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
import {
  awsRoutes,
  boxSecretNames,
  containerProfile,
  isBoxProject,
  stageBoxContainer,
} from "./container";

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
    expect(containerProfile('packs = ["boxy/python"]\n', ["a", "b"])).toContain(
      'packs = ["boxy/python", "a", "b"]',
    );
    expect(out).toMatch(
      /\[options\]\n# Set by agentcore[^\n]*\npython\.venv = "\/opt\/agent-venv"\npython\.runtime = "\/usr\/local\/lib"/,
    );
    expect(out).toContain('bedrock.region = "us-west-2"');
  });

  test("sets python.script from the runtime entrypoint unless the profile sets it", () => {
    const profile = boxProfileToml("us-west-2");
    expect(containerProfile(profile, undefined, "main.py")).not.toContain("python.script");
    expect(containerProfile(profile, undefined, "app.py:app")).toContain(
      'python.script = "app.py"',
    );
    expect(
      containerProfile(
        profile.replace("[options]\n", '[options]\npython.script = "x.py"\n'),
        undefined,
        "app.py",
      ),
    ).not.toContain('python.script = "app.py"');
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

  test("adds the AWS routes to the deployed profile", async () => {
    const root = boxProject();
    const env = {
      AGENTCORE_BOXY_SOURCE: gitRepo("Cargo.toml", "[workspace]\n"),
      AGENTCORE_BOX_SOURCE: gitRepo("README.md", "box\n"),
    };
    const local = await stageBoxContainer({
      projectRoot: root,
      runtime: { name: "agent", codeLocation: "app/agent" },
      env,
    });
    const localProfile = readFileSync(join(root, local, "box-container", "profile.toml"), "utf8");
    expect(localProfile).not.toContain("aws://box-runtime");
    expect(localProfile).toContain('"agentcore-container", "agentcore-runtime"]');

    const deployed = await stageBoxContainer({
      projectRoot: root,
      runtime: { name: "agent", codeLocation: "app/agent" },
      target: { kind: "aws", region: "eu-west-1" },
      env,
    });
    const profile = readFileSync(join(root, deployed, "box-container", "profile.toml"), "utf8");
    expect(profile).toContain('[egress.bedrock]\nsecret.ref = "aws://box-runtime"');
    expect(profile).toContain(
      'destinations = ["*.gateway.bedrock-agentcore.eu-west-1.amazonaws.com"]',
    );
    expect(profile).toContain('destinations = ["bedrock-agentcore.eu-west-1.amazonaws.com"]');
    expect(
      readFileSync(
        join(root, deployed, "box-container", "packs", "agentcore-runtime", "pack.toml"),
        "utf8",
      ),
    ).toContain('name = "agentcore-runtime"');
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

describe("awsRoutes", () => {
  test("refuses a route the user's profile already declares, and a bad region", () => {
    expect(() => awsRoutes("us-west-2", '[egress.bedrock]\nsecret.ref = "aws://x"\n')).toThrow(
      InvalidEnvironmentError,
    );
    expect(() => awsRoutes("us-west-2", "[egress.agentcore-gateway.secret]\n")).toThrow(
      InvalidEnvironmentError,
    );
    // A commented example is not a declaration.
    expect(awsRoutes("us-west-2", "# [egress.bedrock]\n")).toContain("[egress.bedrock]");
    expect(() => awsRoutes('us-west-2"\n[x]')).toThrow(InvalidEnvironmentError);
  });
});

// entrypoint.sh writes the agentcore-runtime pack from the container's environment with Python.
const python = Bun.which("python3");
describe.skipIf(!python)("entrypoint.sh's agentcore-runtime pack", () => {
  test("passes the Gateway and Memory identifiers and no secret", () => {
    const script = readFileSync(
      join(import.meta.dir, "../../assets/box/container/entrypoint.sh"),
      "utf8",
    );
    const body = /pack\.toml <<'PY'\n([\s\S]*?)\nPY\n/.exec(script)?.[1];
    expect(body).toBeDefined();
    const out = join(temp(), "packs", "agentcore-runtime", "pack.toml");
    execFileSync(python!, ["-", out], {
      input: body,
      env: {
        PATH: process.env.PATH ?? "",
        AGENTCORE_GATEWAY_TOOLS_URL:
          "https://gw-1.gateway.bedrock-agentcore.us-west-2.amazonaws.com/mcp",
        AGENTCORE_GATEWAY_TOOLS_AUTH_TYPE: "AWS_IAM",
        MEMORY_NOTES_ID: "notes-abc123",
        MEMORY_NOTES_ARN: "arn:aws:bedrock-agentcore:us-west-2:111122223333:memory/notes-abc123",
        // Secrets that share a prefix with the identifiers.
        AGENTCORE_CREDENTIAL_OPENAI_KEY: "sk-secret",
        AGENTCORE_CREDENTIAL_WALLET_API_KEY_ID: "key-id-secret",
        AGENTCORE_GATEWAY_TOOLS_TOKEN: "token-secret",
        MEMORY_PASSWORD: "pw-secret",
        AWS_BEARER_TOKEN_BEDROCK: "bedrock-secret",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        // Not a plain identifier, so not passed.
        MEMORY_ODD_ID: 'a" \n[x]',
      },
    });
    const pack = readFileSync(out, "utf8");
    expect(pack).toContain('name = "agentcore-runtime"');
    expect(pack).toContain(
      'AGENTCORE_GATEWAY_TOOLS_URL = "https://gw-1.gateway.bedrock-agentcore.us-west-2.amazonaws.com/mcp"',
    );
    expect(pack).toContain('AGENTCORE_GATEWAY_TOOLS_AUTH_TYPE = "AWS_IAM"');
    expect(pack).toContain('MEMORY_NOTES_ID = "notes-abc123"');
    expect(pack).toContain("MEMORY_NOTES_ARN = ");
    expect(pack).not.toContain("secret");
    expect(pack).not.toContain("MEMORY_ODD_ID");
  });
});
