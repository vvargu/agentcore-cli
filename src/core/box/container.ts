// The container image that runs a box project's agent with `boxy run` as its entry point.
// The image builds from the project root, with the agent's Dockerfile ({codeLocation}/Dockerfile)
// and a root .dockerignore that lets in only app/ and .box-build/. stageBoxContainer writes what the
// image needs from outside the project to `.box-build/<runtime>/`:
//
//   boxy/                       boxy and its two helpers, prebuilt for Linux arm64
//                               ($AGENTCORE_BOXY_BIN), and boxy's resources/ (packs) from
//                               $AGENTCORE_BOXY_SOURCE
//   box-container/              the container profile: box/profile.toml with container paths and
//                               the agentcore-container pack, box/policy.dw if any, and box/packs/*
//   entrypoint.sh               from src/assets/box/container
//   Dockerfile                  only when the agent folder has no box Dockerfile (built-in)
//
// POC: the binaries come from a local Linux build until released boxy binaries ship.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { InvalidEnvironmentError } from "../../errors";
import { BOX_DIRECTORY } from "../project/box";
import { defaultSource, type AssetSource } from "../project/source";

export const BOX_BUILD_DIRECTORY = ".box-build";
const ASSET_DIRECTORY = "box/container";
const CONTAINER_PACK = "agentcore-container";
/** Written again by entrypoint.sh from the container's Gateway and Memory variables (an allowlist). */
const RUNTIME_PACK = "agentcore-runtime";
/** The image's Python (python:3.12-slim) and the venv the Dockerfile makes with uv. */
const CONTAINER_OPTIONS = {
  "python.venv": "/opt/agent-venv",
  // Box refuses /usr/local as a whole (a system root); the pack grants /usr/local/bin.
  "python.runtime": "/usr/local/lib",
};

/** Whether the project is a box project: `box/profile.toml` exists. */
export function isBoxProject(projectRoot: string): boolean {
  return existsSync(join(projectRoot, BOX_DIRECTORY, "profile.toml"));
}

export type StageBoxContainerInput = {
  projectRoot: string;
  /** `entrypoint` (agentcore.json, such as `main.py` or `app.py:app`) becomes `python.script`. */
  runtime: { name: string; codeLocation: string; entrypoint?: string };
  /**
   * `aws` for AgentCore Runtime (deploy). `local` for `agentcore dev`; `gateways` are the deployed
   * Gateways the local agent may call, signed with the developer's own AWS credentials.
   */
  target?: { kind: "local"; gateways?: LocalGateway[] } | { kind: "aws"; region: string };
  env?: NodeJS.ProcessEnv;
  assets?: AssetSource;
};

/** A deployed Gateway for `agentcore dev`: its env var name and URL, as the CDK sets them. */
export type LocalGateway = { envName: string; url: string; region: string };

/** Only in a local image with deployed Gateways: their URLs and the route that signs for them. */
const LOCAL_GATEWAY_PACK = "agentcore-local-gateway";

/** Where the box image builds from, relative to the project root. */
export type BoxBuild = { context: string; dockerfile: string };

/** The build context: the project root. */
export const BOX_BUILD_CONTEXT = ".";

/**
 * The root .dockerignore: an allowlist of app/ and .box-build/, without host venvs, .env files,
 * caches, or node_modules. agentcore owns it (the first line marks it) and writes it each time.
 */
export const BOX_DOCKERIGNORE = `# Written by agentcore for the box image build, which runs from the project root.
# Only app/ and .box-build/ go to Docker; host venvs and .env files never do.
*
!app
!.box-build
app/**/.venv
app/**/.env
app/**/.env.*
app/**/__pycache__
app/**/node_modules
app/**/.pytest_cache
**/.DS_Store
`;

/** Stages `.box-build/<runtime>/` and the root .dockerignore, and says where the image builds from. */
export async function stageBoxContainer(input: StageBoxContainerInput): Promise<BoxBuild> {
  const env = input.env ?? process.env;
  const target = input.target ?? { kind: "local" };
  const assets = input.assets ?? defaultSource();
  const codeLocation = input.runtime.codeLocation.replace(/\/+$/, "");
  const relativeContext = join(BOX_BUILD_DIRECTORY, input.runtime.name);
  const context = join(input.projectRoot, relativeContext);
  rmSync(context, { recursive: true, force: true });
  mkdirSync(context, { recursive: true });

  // The Dockerfile: the user's {codeLocation}/Dockerfile when it builds a box image (it copies the
  // staged boxy in), else the built-in one. A Dockerfile from a non-box template is not a box image.
  const userDockerfile = join(codeLocation, "Dockerfile");
  let dockerfile = userDockerfile;
  if (!isBoxDockerfile(join(input.projectRoot, userDockerfile))) {
    dockerfile = join(relativeContext, "Dockerfile");
    writeFileSync(
      join(input.projectRoot, dockerfile),
      await boxDockerfile(codeLocation, input.runtime.name, assets),
    );
  }
  writeDockerignore(input.projectRoot);
  writeFileSync(
    join(context, "entrypoint.sh"),
    await assets.read(`${ASSET_DIRECTORY}/entrypoint.sh`),
    {
      mode: 0o755,
    },
  );

  // boxy, its helpers, and its packs, which Box Core and boxy find beside the running boxy.
  const boxy = join(context, "boxy");
  mkdirSync(boxy, { recursive: true });
  const bin = binaryFolder(env);
  for (const name of BOXY_BINARIES) {
    cpSync(join(bin, name), join(boxy, name));
  }
  cpSync(join(resourcesFolder(env), "resources"), join(boxy, "resources"), { recursive: true });

  // The container profile.
  const box = join(input.projectRoot, BOX_DIRECTORY);
  const profileDir = join(context, "box-container");
  const gateways = target.kind === "local" ? (target.gateways ?? []) : [];
  const packs = [CONTAINER_PACK, RUNTIME_PACK, ...(gateways.length ? [LOCAL_GATEWAY_PACK] : [])];
  for (const pack of packs) mkdirSync(join(profileDir, "packs", pack), { recursive: true });
  const profile = containerProfile(
    readFileSync(join(box, "profile.toml"), "utf8"),
    packs,
    input.runtime.entrypoint,
  );
  writeFileSync(
    join(profileDir, "profile.toml"),
    target.kind === "aws"
      ? `${profile.trimEnd()}\n\n${awsRoutes(target.region, profile)}`
      : profile,
  );
  if (existsSync(join(box, "policy.dw")))
    cpSync(join(box, "policy.dw"), join(profileDir, "policy.dw"));
  if (existsSync(join(box, "packs")))
    cpSync(join(box, "packs"), join(profileDir, "packs"), { recursive: true });
  writeFileSync(
    join(profileDir, "packs", CONTAINER_PACK, "pack.toml"),
    await assets.read(`${ASSET_DIRECTORY}/${CONTAINER_PACK}/pack.toml`),
  );
  writeFileSync(
    join(profileDir, "packs", RUNTIME_PACK, "pack.toml"),
    `[pack]\nname = "${RUNTIME_PACK}"\nversion = 1\n`,
  );
  if (gateways.length) {
    writeFileSync(
      join(profileDir, "packs", LOCAL_GATEWAY_PACK, "pack.toml"),
      localGatewayPack(gateways),
    );
  }
  return { context: BOX_BUILD_CONTEXT, dockerfile };
}

/**
 * The user's profile for the container: agentcore's packs after the project's packs, and the
 * image's Python paths in [options]. String edits keep the user's comments.
 */
export function containerProfile(
  profile: string,
  packs: string[] = [CONTAINER_PACK],
  entrypoint?: string,
): string {
  const added = packs.map((pack) => `"${pack}"`).join(", ");
  let out = profile.replace(/^packs\s*=\s*\[([^\]]*)\]/m, (_line, list: string) => {
    const items = list.trim().replace(/,\s*$/, "");
    return `packs = [${items ? `${items}, ` : ""}${added}]`;
  });
  if (out === profile) out = `packs = [${added}]\n${out}`;
  const options: Record<string, string> = { ...CONTAINER_OPTIONS };
  // The runtime's entry file, unless the user's profile names one itself.
  const script = entrypoint?.split(":")[0];
  if (script && script !== "main.py" && !/^\s*python\.script\s*=/m.test(profile)) {
    options["python.script"] = script;
  }
  const lines = Object.entries(options).map(([key, value]) => `${key} = "${value}"`);
  const header = /^\[options\]\s*$/m;
  return header.test(out)
    ? out.replace(
        header,
        `[options]\n# Set by agentcore for the container image.\n${lines.join("\n")}`,
      )
    : `${out.trimEnd()}\n\n[options]\n${lines.join("\n")}\n`;
}

/** The names of the env:// secrets in the profile and the project's own packs. */
export function boxSecretNames(projectRoot: string): string[] {
  const box = join(projectRoot, BOX_DIRECTORY);
  const files = [join(box, "profile.toml")];
  const packs = join(box, "packs");
  if (existsSync(packs)) {
    for (const name of readdirSync(packs)) files.push(join(packs, name, "pack.toml"));
  }
  const names = new Set<string>();
  for (const file of files.filter((f) => existsSync(f))) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      for (const match of line.matchAll(/env:\/\/([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1]!);
    }
  }
  return [...names].sort();
}

/**
 * The local image's Gateway pack: each deployed Gateway's URL for the agent, and the same Gateway
 * route as on AgentCore Runtime. Locally `box-runtime` holds the developer's AWS credentials, which
 * entrypoint.sh writes from the ones `agentcore dev` passes in, so Box signs as the developer.
 */
export function localGatewayPack(gateways: LocalGateway[]): string {
  const regions = [...new Set(gateways.map((gateway) => gateway.region))];
  for (const region of regions) {
    if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) {
      throw new InvalidEnvironmentError(`"${region}" is not an AWS region for the box profile.`);
    }
  }
  const env = gateways.map(({ envName, url }) => {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(envName) ||
      !/^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9/_-]*)?$/.test(url)
    ) {
      throw new InvalidEnvironmentError(`unexpected Gateway variable ${envName}=${url}`);
    }
    return `${envName} = "${url}"`;
  });
  return `# Written by agentcore dev: the project's deployed Gateways, for the local agent.
[pack]
name = "${LOCAL_GATEWAY_PACK}"
version = 1

[agent.env]
${env.join("\n")}

# Signed with your AWS credentials (entrypoint.sh writes them to the profile box-runtime).
[egress.agentcore-gateway]
destinations = [${regions.map((region) => `"*.gateway.bedrock-agentcore.${region}.amazonaws.com"`).join(", ")}]
secret.ref = "aws://box-runtime"
`;
}

/** The routes {@link awsRoutes} declares. */
const AWS_ROUTES = ["bedrock", "agentcore-gateway", "agentcore-data"];

/**
 * The deployed profile's routes, after the user's profile (a profile may change a pack's route; two
 * packs may not declare one). AgentCore Runtime gives the container the runtime role's credentials
 * (entrypoint.sh writes them to the AWS profile box-runtime), so Box signs the model, Gateway, and
 * AgentCore data-plane calls (memory) with SigV4 as that role. The agent holds no AWS credential.
 * A Gateway target holds its own outbound credential (AgentCore Identity), so the box needs none.
 */
export function awsRoutes(region: string, profile = ""): string {
  // The region goes into TOML and host names, so it must look like one.
  if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) {
    throw new InvalidEnvironmentError(`"${region}" is not an AWS region for the box profile.`);
  }
  // TOML refuses a table declared twice, and boxy would only say so in the container at startup.
  for (const route of AWS_ROUTES) {
    if (new RegExp(`^\\s*\\[egress\\.${route}[.\\]]`, "m").test(profile)) {
      throw new InvalidEnvironmentError(
        `box/profile.toml declares [egress.${route}], which agentcore deploy sets for AgentCore ` +
          `Runtime (signed with the runtime role). Remove it from box/profile.toml to deploy.`,
      );
    }
  }
  return `# --- Written by agentcore deploy for AgentCore Runtime ---
# The model: the role signs, instead of the Bedrock API key (env://AWS_BEARER_TOKEN_BEDROCK) locally.
[egress.bedrock]
secret.ref = "aws://box-runtime"

# Each AgentCore Gateway of the project (AGENTCORE_GATEWAY_<NAME>_URL).
[egress.agentcore-gateway]
destinations = ["*.gateway.bedrock-agentcore.${region}.amazonaws.com"]
secret.ref = "aws://box-runtime"

# The AgentCore data plane, such as Memory (MEMORY_<NAME>_ID).
[egress.agentcore-data]
destinations = ["bedrock-agentcore.${region}.amazonaws.com"]
secret.ref = "aws://box-runtime"
`;
}

/** The built-in box image Dockerfile for an agent in `codeLocation` (such as `app/agent`). */
export async function boxDockerfile(
  codeLocation: string,
  runtimeName: string,
  assets: AssetSource = defaultSource(),
): Promise<string> {
  const dockerfile = await assets.read(`${ASSET_DIRECTORY}/Dockerfile`);
  return dockerfile
    .replaceAll("{{codeLocation}}", codeLocation.replace(/\/+$/, ""))
    .replaceAll("{{runtimeName}}", runtimeName);
}

/** Whether the file is a box image Dockerfile: it copies the staged boxy in. */
function isBoxDockerfile(path: string): boolean {
  return existsSync(path) && readFileSync(path, "utf8").includes("COPY .box-build/");
}

/** Writes the root .dockerignore, unless the user has one of their own there. */
function writeDockerignore(projectRoot: string): void {
  const path = join(projectRoot, ".dockerignore");
  const marker = BOX_DOCKERIGNORE.split("\n")[0]!;
  if (existsSync(path) && !readFileSync(path, "utf8").startsWith(marker)) {
    throw new InvalidEnvironmentError(
      `${path} is not agentcore's; the box image builds from the project root and needs its own ` +
        ".dockerignore there. Move yours into the agent folder, or remove it.",
    );
  }
  writeFileSync(path, BOX_DOCKERIGNORE);
}

/** The programs the image needs: boxy and the two helpers Box Core runs from beside it. */
export const BOXY_BINARIES = [
  "boxy",
  "strands-box-sock-alias",
  "strands-box-contain-trampoline",
] as const;
/** ELF machine number for aarch64, the architecture AgentCore Runtime runs. */
const EM_AARCH64 = 183;

/** $AGENTCORE_BOXY_BIN: a folder with each of {@link BOXY_BINARIES} built for Linux arm64. */
function binaryFolder(env: NodeJS.ProcessEnv): string {
  const folder = env.AGENTCORE_BOXY_BIN;
  if (!folder) {
    throw new InvalidEnvironmentError(
      "Set AGENTCORE_BOXY_BIN to the folder with boxy, strands-box-sock-alias, and " +
        "strands-box-contain-trampoline built for Linux arm64, such as staging-boxy/target/linux/release.",
    );
  }
  for (const name of BOXY_BINARIES) {
    const path = join(folder, name);
    let header: Buffer;
    try {
      header = readFileSync(path).subarray(0, 20);
    } catch {
      throw new InvalidEnvironmentError(`AGENTCORE_BOXY_BIN has no ${name} (${path}).`);
    }
    // ELF magic, then e_machine (little-endian) at byte 18.
    const elf = header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    if (!elf || header.readUInt16LE(18) !== EM_AARCH64) {
      throw new InvalidEnvironmentError(
        `${path} is not a Linux arm64 program; build it for linux/arm64.`,
      );
    }
  }
  return folder;
}

/** $AGENTCORE_BOXY_SOURCE: the boxy checkout whose resources/ holds the packs. */
function resourcesFolder(env: NodeJS.ProcessEnv): string {
  const folder = env.AGENTCORE_BOXY_SOURCE;
  if (!folder || !existsSync(join(folder, "resources"))) {
    throw new InvalidEnvironmentError(
      "Set AGENTCORE_BOXY_SOURCE to the boxy checkout; the image takes boxy's packs from its " +
        "resources/ folder.",
    );
  }
  return folder;
}
