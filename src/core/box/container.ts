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
/** The image's Python (python:3.12-slim) and the venv the Dockerfile makes with uv. */
const CONTAINER_OPTIONS = {
  "python.venv": "/opt/agent-venv",
  "python.runtime": "/usr/local",
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
  env?: NodeJS.ProcessEnv;
  assets?: AssetSource;
};

/** Writes the build context and returns its path relative to the project root. */
export async function stageBoxContainer(input: StageBoxContainerInput): Promise<string> {
  const env = input.env ?? process.env;
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
  mkdirSync(join(profileDir, "packs", CONTAINER_PACK), { recursive: true });
  writeFileSync(
    join(profileDir, "profile.toml"),
    containerProfile(readFileSync(join(box, "profile.toml"), "utf8")),
  );
  if (existsSync(join(box, "policy.dw")))
    cpSync(join(box, "policy.dw"), join(profileDir, "policy.dw"));
  if (existsSync(join(box, "packs")))
    cpSync(join(box, "packs"), join(profileDir, "packs"), { recursive: true });
  writeFileSync(
    join(profileDir, "packs", CONTAINER_PACK, "pack.toml"),
    await assets.read(`${ASSET_DIRECTORY}/${CONTAINER_PACK}/pack.toml`),
  );
  return relativeContext;
}

/**
 * The user's profile for the container: the agentcore-container pack after the project's packs,
 * and the image's Python paths in [options]. String edits keep the user's comments.
 */
export function containerProfile(profile: string): string {
  let out = profile.replace(/^packs\s*=\s*\[([^\]]*)\]/m, (_line, list: string) => {
    const items = list.trim().replace(/,\s*$/, "");
    return `packs = [${items ? `${items}, ` : ""}"${CONTAINER_PACK}"]`;
  });
  if (out === profile) out = `packs = ["${CONTAINER_PACK}"]\n${out}`;
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
