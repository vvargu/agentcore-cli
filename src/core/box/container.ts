// The container image that runs a box project's agent with `boxy run` as its entry point.
// stageBoxContainer writes the image's build context to `.box-build/<runtime>/`:
//
//   Dockerfile, entrypoint.sh   from src/assets/box/container
//   .box-src/boxy.tar           `git archive HEAD` of boxy ($AGENTCORE_BOXY_SOURCE)
//   .box-src/box.tar            `git archive HEAD` of Box Core ($AGENTCORE_BOX_SOURCE)
//   project/<codeLocation>/     the agent's code, without host venvs or .env files
//   box-container/              the container profile: box/profile.toml with container paths and
//                               the agentcore-container pack, box/policy.dw, and box/packs/*
//
// POC: boxy and Box Core build from source in the image until released binaries ship.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
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
const SKIPPED = new Set([
  ".venv",
  "__pycache__",
  ".git",
  "node_modules",
  ".pytest_cache",
  ".DS_Store",
]);

/** Whether the project is a box project: `box/profile.toml` exists. */
export function isBoxProject(projectRoot: string): boolean {
  return existsSync(join(projectRoot, BOX_DIRECTORY, "profile.toml"));
}

export type StageBoxContainerInput = {
  projectRoot: string;
  runtime: { name: string; codeLocation: string };
  /** `aws` for AgentCore Runtime (deploy); `local` for `agentcore dev`. */
  target?: { kind: "local" } | { kind: "aws"; region: string };
  env?: NodeJS.ProcessEnv;
  assets?: AssetSource;
};

/** Writes the build context and returns its path relative to the project root. */
export async function stageBoxContainer(input: StageBoxContainerInput): Promise<string> {
  const env = input.env ?? process.env;
  const target = input.target ?? { kind: "local" };
  const assets = input.assets ?? defaultSource();
  const codeLocation = input.runtime.codeLocation.replace(/\/+$/, "");
  const relativeContext = join(BOX_BUILD_DIRECTORY, input.runtime.name);
  const context = join(input.projectRoot, relativeContext);
  rmSync(context, { recursive: true, force: true });
  mkdirSync(join(context, ".box-src"), { recursive: true });

  // The Dockerfile and the entry point.
  const dockerfile = await assets.read(`${ASSET_DIRECTORY}/Dockerfile`);
  writeFileSync(
    join(context, "Dockerfile"),
    dockerfile.replaceAll("{{codeLocation}}", codeLocation),
  );
  writeFileSync(
    join(context, "entrypoint.sh"),
    await assets.read(`${ASSET_DIRECTORY}/entrypoint.sh`),
    {
      mode: 0o755,
    },
  );

  // boxy and Box Core sources.
  archive(
    sourceFolder(env, "AGENTCORE_BOXY_SOURCE", "boxy"),
    join(context, ".box-src", "boxy.tar"),
  );
  archive(
    sourceFolder(env, "AGENTCORE_BOX_SOURCE", "Box Core"),
    join(context, ".box-src", "box.tar"),
  );

  // The agent's code.
  cpSync(join(input.projectRoot, codeLocation), join(context, "project", codeLocation), {
    recursive: true,
    filter: (path) => !SKIPPED.has(basename(path)) && !basename(path).startsWith(".env"),
  });

  // The container profile.
  const box = join(input.projectRoot, BOX_DIRECTORY);
  const profileDir = join(context, "box-container");
  const packs = [CONTAINER_PACK, RUNTIME_PACK];
  for (const pack of packs) mkdirSync(join(profileDir, "packs", pack), { recursive: true });
  const profile = containerProfile(readFileSync(join(box, "profile.toml"), "utf8"), packs);
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
  return relativeContext;
}

/**
 * The user's profile for the container: agentcore's packs after the project's packs, and the
 * image's Python paths in [options]. String edits keep the user's comments.
 */
export function containerProfile(profile: string, packs: string[] = [CONTAINER_PACK]): string {
  const added = packs.map((pack) => `"${pack}"`).join(", ");
  let out = profile.replace(/^packs\s*=\s*\[([^\]]*)\]/m, (_line, list: string) => {
    const items = list.trim().replace(/,\s*$/, "");
    return `packs = [${items ? `${items}, ` : ""}${added}]`;
  });
  if (out === profile) out = `packs = [${added}]\n${out}`;
  const lines = Object.entries(CONTAINER_OPTIONS).map(([key, value]) => `${key} = "${value}"`);
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

function sourceFolder(env: NodeJS.ProcessEnv, key: string, what: string): string {
  const folder = env[key];
  if (!folder || !existsSync(join(folder, ".git"))) {
    throw new InvalidEnvironmentError(
      `Set ${key} to a git checkout of ${what}; the box image builds it from source.`,
    );
  }
  return folder;
}

function archive(folder: string, output: string): void {
  execFileSync("git", ["-C", folder, "archive", "--format=tar", "-o", output, "HEAD"]);
}
