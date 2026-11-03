// The container image that runs a box project's agent with `boxy run` as its entry point.
// The image builds from the project root, with the agent's Dockerfile ({codeLocation}/Dockerfile)
// and a root .dockerignore that lets in only app/ and .box-build/. stageBoxContainer writes what the
// image needs from outside the project to `.box-build/<runtime>/`:
//
//   boxy/                       boxy and its two helpers, prebuilt for Linux arm64
//                               ($AGENTCORE_BOXY_BIN), and boxy's resources/ (packs) from
//                               $AGENTCORE_BOXY_SOURCE
//   box-container/              the container profile: box/profile.toml with agentcore's tables
//                               added (ingress, image folders, routes), box/policy.dw if any, and
//                               box/packs/*
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
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { InvalidEnvironmentError } from "../../errors";
import { BOX_DIRECTORY } from "../project/box";
import { defaultSource, type AssetSource } from "../project/source";

export const BOX_BUILD_DIRECTORY = ".box-build";
const ASSET_DIRECTORY = "box/container";
type Table = Record<string, unknown>;

/** The image's Python (python:3.12-slim) and the venv the Dockerfile makes with uv. */
const CONTAINER_OPTIONS = {
  // Box refuses /usr/local as a whole (a system root); CONTAINER_TABLES grants /usr/local/bin.
  python: { venv: "/opt/agent-venv", runtime: "/usr/local/lib" },
};

/** The image's folders: the venv's Python links to /usr/local/bin, and Debian's shared
 * libraries (libssl, libffi, ...) that Python's modules load. On Linux a read grant does not let
 * Python load a .so, so each is exec as well. */
const IMAGE_FOLDERS = ["/usr/local/bin", "/usr/lib/aarch64-linux-gnu"];

/**
 * What only the container has, added to the container's copy of the profile. Box listens on
 * 0.0.0.0:8080 (the port `agentcore dev` publishes and AgentCore Runtime calls) and relays each
 * connection to the agent's own port 8080. Box Core accepts ingress on Linux only, which is why it
 * is not in box/profile.toml. A profile may set its own `[agent.ingress]` keys, which win.
 */
const CONTAINER_TABLES: Table = {
  agent: {
    ingress: { host: "0.0.0.0", port: 8080 },
    filesystem: { read: IMAGE_FOLDERS, exec: IMAGE_FOLDERS },
  },
};

/** The first line of the container profile, which says who wrote it. */
const CONTAINER_PROFILE_HEADER =
  "# Written by agentcore from box/profile.toml for the container image. Do not edit.\n";

/** Above the last table. entrypoint.sh appends the runtime's Gateway and Memory variables to it. */
const AGENT_ENV_HEADER =
  "# The agent's environment. On AgentCore Runtime, entrypoint.sh appends the Gateway and Memory\n" +
  "# variables here at start, so this table stays last.\n[agent.env]\n";

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
  target?:
    | { kind: "local"; gateways?: LocalGateway[] }
    | {
        kind: "aws";
        region: string;
        /** The deployed Gateways' hosts, when every Gateway is deployed; else any in the region. */
        gatewayHosts?: string[];
      };
  env?: NodeJS.ProcessEnv;
  assets?: AssetSource;
};

/** A deployed Gateway for `agentcore dev`: its env var name and URL, as the CDK sets them. */
export type LocalGateway = { envName: string; url: string; region: string };


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
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(profileDir, "profile.toml"),
    containerProfile(readFileSync(join(box, "profile.toml"), "utf8"), {
      entrypoint: input.runtime.entrypoint,
      gateways: target.kind === "local" ? target.gateways : undefined,
      awsRegion: target.kind === "aws" ? target.region : undefined,
      awsGatewayHosts: target.kind === "aws" ? target.gatewayHosts : undefined,
    }),
  );
  if (existsSync(join(box, "policy.dw")))
    cpSync(join(box, "policy.dw"), join(profileDir, "policy.dw"));
  if (existsSync(join(box, "packs")))
    cpSync(join(box, "packs"), join(profileDir, "packs"), { recursive: true });
  return { context: BOX_BUILD_CONTEXT, dockerfile };
}

/** What `containerProfile` adds to the user's profile. */
export type ContainerProfileOptions = {
  /** The runtime's `entrypoint` (such as `app.py:app`); its file becomes `python.script`. */
  entrypoint?: string;
  /** `agentcore dev`: the deployed Gateways the local agent may call (their route). */
  gateways?: LocalGateway[];
  /** `agentcore deploy`: the region of the AWS routes, signed as the Runtime role. */
  awsRegion?: string;
  /** `agentcore deploy`: the project's deployed Gateway hosts, instead of any in the region. */
  awsGatewayHosts?: string[];
};

/**
 * The container's copy of box/profile.toml: the user's profile with agentcore's tables added,
 * written as one file with no packs of agentcore's own. The user's keys win, except the image's
 * Python paths in [options]. Lists, such as the filesystem grants, are joined. The user's comments
 * are not kept; box/profile.toml is unchanged. `[agent.env]` is written last, for entrypoint.sh.
 */
export function containerProfile(profile: string, options: ContainerProfileOptions = {}): string {
  let table: Table;
  try {
    table = parseToml(profile) as Table;
  } catch (error) {
    throw new InvalidEnvironmentError(`box/profile.toml is not valid TOML: ${String(error)}`);
  }
  if (options.awsRegion !== undefined) refuseDeployRoutes(table);
  merge(table, CONTAINER_TABLES, false);
  merge(table, { options: CONTAINER_OPTIONS }, true);
  // The runtime's entry file, unless the user's profile names one itself.
  const script = options.entrypoint?.split(":")[0];
  if (script && script !== "main.py") merge(table, { options: { python: { script } } }, false);
  if (options.gateways?.length) merge(table, localGatewayTables(options.gateways), false);
  if (options.awsRegion !== undefined)
    merge(table, awsRouteTables(options.awsRegion, options.awsGatewayHosts), true);

  const agent = (table.agent ?? {}) as Table;
  const env = (agent.env ?? {}) as Table;
  delete agent.env;
  table.agent = agent;
  const envText = Object.keys(env).length ? stringifyToml(env).trimEnd() + "\n" : "";
  return `${CONTAINER_PROFILE_HEADER}\n${stringifyToml(table).trimEnd()}\n\n${AGENT_ENV_HEADER}${envText}`;
}

/** Merge `source` into `target`: tables merge, lists join without repeats, and for a key both set,
 * `source` wins when `sourceWins`, else `target` keeps its value. */
function merge(target: Table, source: Table, sourceWins: boolean): void {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (isTable(current) && isTable(value)) merge(current, value, sourceWins);
    else if (Array.isArray(current) && Array.isArray(value))
      target[key] = [...current, ...value.filter((item) => !current.includes(item))];
    else if (current === undefined || sourceWins) target[key] = structuredClone(value);
  }
}

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * The local image's Gateway route: exactly the deployed Gateways' hosts. The URLs reach the agent
 * the same way as on AgentCore Runtime: dev sets AGENTCORE_GATEWAY_<NAME>_URL on the container,
 * and entrypoint.sh appends it to [agent.env]. Locally `box-runtime` holds the developer's AWS credentials, which
 * entrypoint.sh writes from the ones `agentcore dev` passes in, so Box signs as the developer.
 */
export function localGatewayTables(gateways: LocalGateway[]): Table {
  for (const { region } of gateways) checkRegion(region);
  for (const { envName, url } of gateways) {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(envName) ||
      !/^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9/_-]*)?$/.test(url)
    ) {
      throw new InvalidEnvironmentError(`unexpected Gateway variable ${envName}=${url}`);
    }
  }
  return {
    egress: {
      "agentcore-gateway": {
        // Each Gateway's own host, not a wildcard: locally Box signs as the developer, who may
        // reach other Gateways in the account.
        destinations: [...new Set(gateways.map((gateway) => new URL(gateway.url).host))],
        secret: { ref: "aws://box-runtime" },
      },
    },
  };
}

function checkRegion(region: string): void {
  // The region goes into host names, so it must look like one.
  if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) {
    throw new InvalidEnvironmentError(`"${region}" is not an AWS region for the box profile.`);
  }
}

/** The routes {@link awsRouteTables} declares. */
const AWS_ROUTES = ["bedrock", "agentcore-gateway", "agentcore-data"];

/** A user's profile may not declare a route that deploy sets for AgentCore Runtime. */
function refuseDeployRoutes(table: Table): void {
  const egress = (table.egress ?? {}) as Table;
  for (const route of AWS_ROUTES) {
    if (route in egress) {
      throw new InvalidEnvironmentError(
        `box/profile.toml declares [egress.${route}], which agentcore deploy sets for AgentCore ` +
          `Runtime (signed with the runtime role). Remove it from box/profile.toml to deploy.`,
      );
    }
  }
}

/**
 * The deployed profile's routes. AgentCore Runtime gives the container the runtime role's
 * credentials (entrypoint.sh writes them to the AWS profile box-runtime), so Box signs the model,
 * Gateway, and AgentCore data-plane calls (memory) with SigV4 as that role. The agent holds no AWS
 * credential. A Gateway target holds its own outbound credential (AgentCore Identity).
 */
export function awsRouteTables(region: string, gatewayHosts?: string[]): Table {
  checkRegion(region);
  const suffix = `.gateway.bedrock-agentcore.${region}.amazonaws.com`;
  for (const host of gatewayHosts ?? []) {
    if (!/^[a-z0-9-]+$/.test(host.slice(0, -suffix.length)) || !host.endsWith(suffix)) {
      throw new InvalidEnvironmentError(`"${host}" is not an AgentCore Gateway host in ${region}.`);
    }
  }
  const signed = { ref: "aws://box-runtime" };
  return {
    egress: {
      // The model: the role signs, instead of the Bedrock API key used locally.
      bedrock: { secret: signed },
      // Each AgentCore Gateway of the project (AGENTCORE_GATEWAY_<NAME>_URL): their own hosts
      // once deployed, else any in the region (the host's id does not exist before the deploy).
      "agentcore-gateway": {
        destinations: gatewayHosts?.length ? gatewayHosts : [`*${suffix}`],
        secret: signed,
      },
      // The AgentCore data plane, such as Memory (MEMORY_<NAME>_ID).
      "agentcore-data": {
        destinations: [`bedrock-agentcore.${region}.amazonaws.com`],
        secret: signed,
      },
    },
  };
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
