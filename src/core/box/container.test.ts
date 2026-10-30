import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidEnvironmentError } from "../../errors";
import { boxProfileToml, BOX_POLICY_DW } from "../project/box";
import { boxSecretNames, containerProfile, isBoxProject, stageBoxContainer } from "./container";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentcore-box-"));
  temps.push(dir);
  return dir;
}

function gitRepo(file: string, contents: string): string {
  const dir = temp();
  writeFileSync(join(dir, file), contents);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "init");
  return dir;
}

function boxProject(profile = boxProfileToml("us-west-2")): string {
  const root = temp();
  mkdirSync(join(root, "app", "agent", ".venv"), { recursive: true });
  writeFileSync(join(root, "app", "agent", "main.py"), "print('hi')\n");
  writeFileSync(join(root, "app", "agent", "pyproject.toml"), "[project]\nname = 'agent'\n");
  writeFileSync(join(root, "app", "agent", ".env"), "SECRET=1\n");
  mkdirSync(join(root, "box", "packs", "mine"), { recursive: true });
  writeFileSync(join(root, "box", "profile.toml"), profile);
  writeFileSync(join(root, "box", "policy.dw"), BOX_POLICY_DW);
  writeFileSync(
    join(root, "box", "packs", "mine", "pack.toml"),
    '[egress.search]\nsecret.ref = "env://SEARCH_KEY"\n',
  );
  return root;
}

describe("containerProfile", () => {
  test("adds the container pack and the image's Python paths to [options]", () => {
    const out = containerProfile(boxProfileToml("us-west-2"));
    expect(out).toContain('packs = ["boxy/python", "boxy/bedrock", "agentcore-container"]');
    expect(out).toMatch(
      /\[options\]\n# Set by agentcore[^\n]*\npython\.venv = "\/opt\/agent-venv"\npython\.runtime = "\/usr\/local"/,
    );
    expect(out).toContain('bedrock.region = "us-west-2"');
  });

  test("adds [options] and packs when the profile has neither", () => {
    const out = containerProfile('[tool.curl]\ncommand = ["/usr/bin/curl"]\n');
    expect(out.startsWith('packs = ["agentcore-container"]\n')).toBe(true);
    expect(out).toContain('[options]\npython.venv = "/opt/agent-venv"');
  });
});

describe("boxSecretNames", () => {
  test("lists env:// names in the profile and project packs, not in comments", () => {
    const root = boxProject(
      `${boxProfileToml("us-west-2")}\n[egress.github]\nsecret.ref = "env://GITHUB_TOKEN"\n`,
    );
    expect(boxSecretNames(root)).toEqual(["GITHUB_TOKEN", "SEARCH_KEY"]);
  });
});

describe("stageBoxContainer", () => {
  test("writes the build context for the box image", async () => {
    const root = boxProject();
    const env = {
      AGENTCORE_BOXY_SOURCE: gitRepo("Cargo.toml", "[workspace]\n"),
      AGENTCORE_BOX_SOURCE: gitRepo("README.md", "box\n"),
    };
    expect(isBoxProject(root)).toBe(true);

    const context = await stageBoxContainer({
      projectRoot: root,
      runtime: { name: "agent", codeLocation: "app/agent/" },
      env,
    });

    const dir = join(root, context);
    expect(context).toBe(join(".box-build", "agent"));
    const dockerfile = readFileSync(join(dir, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("WORKDIR /app/app/agent\n");
    expect(dockerfile).not.toContain("{{codeLocation}}");
    expect(statSync(join(dir, "entrypoint.sh")).mode & 0o111).not.toBe(0);
    expect(existsSync(join(dir, ".box-src", "boxy.tar"))).toBe(true);
    expect(existsSync(join(dir, ".box-src", "box.tar"))).toBe(true);
    expect(existsSync(join(dir, "project", "app", "agent", "main.py"))).toBe(true);
    expect(existsSync(join(dir, "project", "app", "agent", ".venv"))).toBe(false);
    expect(existsSync(join(dir, "project", "app", "agent", ".env"))).toBe(false);
    const profile = join(dir, "box-container");
    expect(readFileSync(join(profile, "profile.toml"), "utf8")).toContain('"agentcore-container"');
    expect(readFileSync(join(profile, "policy.dw"), "utf8")).toBe(BOX_POLICY_DW);
    expect(existsSync(join(profile, "packs", "mine", "pack.toml"))).toBe(true);
    expect(
      readFileSync(join(profile, "packs", "agentcore-container", "pack.toml"), "utf8"),
    ).toContain('host = "0.0.0.0"');
  });

  test("asks for the boxy source when it is not set", async () => {
    const root = boxProject();
    await expect(
      stageBoxContainer({
        projectRoot: root,
        runtime: { name: "agent", codeLocation: "app/agent" },
        env: {},
      }),
    ).rejects.toBeInstanceOf(InvalidEnvironmentError);
  });
});
