// The box folder `agentcore create` writes beside `app/`: a boxy profile
// (`box/profile.toml`) and the user's own policy rules (`box/policy.dw`). boxy
// runs the agent from them with `boxy run ../../box` from `app/<agent>`.
// A project is a box project when `box/profile.toml` exists; the project spec
// records nothing about it.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ScaffoldRuntimeInput } from "../../handlers/project/types";

export const BOX_DIRECTORY = "box";

/** Lines appended to the project's .gitignore: the venv boxy runs the agent with. */
export const BOX_GITIGNORE = "\n# Box (boxy): the agent's Python environment\nbox/.venv/\n";

/**
 * Whether a scaffolded runtime gets a box folder: a Python Strands agent served
 * over HTTP (main.py calls `app.run()`, which the `boxy/python` pack's default
 * command starts) with the Bedrock model (the `boxy/bedrock` pack). Other
 * templates are left unchanged.
 */
export function boxSupported(runtime: ScaffoldRuntimeInput | undefined): boolean {
  return (
    runtime !== undefined &&
    runtime.language === "Python" &&
    runtime.framework === "strands" &&
    (runtime.protocol ?? "HTTP") === "HTTP" &&
    (runtime.modelProvider ?? "Bedrock") === "Bedrock"
  );
}

/** `box/profile.toml`: packs that boxy ships, the Bedrock region, and commented examples. */
export function boxProfileToml(region: string): string {
  return `# A boxy profile for this project's agent. From app/<agent>, run:
#   boxy profile show --full ../../box   # what the box allows, without starting it
#   boxy run ../../box                   # run the agent in the box
#
# boxy/python runs \`python main.py\` with box/.venv (\`agentcore create\` makes it with uv).
# boxy/bedrock routes the model calls to Bedrock and adds AWS_BEARER_TOKEN_BEDROCK to them.
packs = ["boxy/python", "boxy/bedrock"]

[options]
bedrock.region = "${region}"

# Let the agent call another host with a credential. The box puts the value of the
# variable on each request; the agent sees only a stand-in value.
# [egress.example]
# destinations = ["api.example.com"]
# secret.ref = "env://EXAMPLE_API_KEY"

# Let the agent run a program, such as curl. Permit it in policy.dw as well.
# [tool.curl]
# command = ["/usr/bin/curl"]
`;
}

/** `box/policy.dw`: the user's own rules. boxy adds its generated rules after these. */
export const BOX_POLICY_DW = `// Your own policy rules for the box. boxy adds the rules the profile implies
// (routes, tools, the workspace) and blocks cloud metadata services (IMDS);
// do not repeat those, and give each rule an @id that boxy does not use.
//
// For example, to let the agent run curl ([tool.curl] in profile.toml) only for one URL:
// @id("spawn_curl") permit (principal, action == Box::Action::"shell:spawn", resource) when { context.input.program_path == "/usr/bin/curl" && context.input has arg1 && context.input.arg1 == "https://api.example.com/status" };
`;

/**
 * The environment for the uv sync that makes boxy's venv, `<project>/box/.venv`,
 * outside the workspace (`app/<agent>`), where boxy refuses to run a program.
 * Python goes where uv installs managed Pythons under the real home path (on
 * Linux, /home/x may link to /local/home/x), which the `boxy/python` pack grants.
 */
export function boxVenvEnv(projectRoot: string): Record<string, string> {
  return {
    UV_PROJECT_ENVIRONMENT: join(projectRoot, BOX_DIRECTORY, ".venv"),
    UV_PYTHON_INSTALL_DIR: join(realHome(), ".local", "share", "uv", "python"),
  };
}

export const BOX_UV_SYNC = ["uv", "sync", "--managed-python"];

function realHome(): string {
  const home = homedir();
  try {
    return realpathSync(home);
  } catch {
    return home;
  }
}

/** The next steps after creating a box project, run from the project folder. */
export function boxNextSteps(runtimeName: string): string[] {
  return [
    `cd app/${runtimeName} && boxy profile show --full ../../box`,
    "boxy run ../../box",
    "agentcore dev",
  ];
}
