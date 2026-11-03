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
import { boxProfileToml } from "../project/box";

/** A policy.dw the user wrote. */
const USER_POLICY_DW = '@id("spawn_curl") permit (principal, action, resource);\n';
import {
  BOXY_BINARIES,
  BOX_DOCKERIGNORE,
  awsRoutes,
  boxDockerfile,
  localGatewayPack,
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

/** The first 20 bytes of an ELF program for a machine (183 is aarch64, 62 is x86-64). */
function elf(machine: number): Buffer {
  const header = Buffer.alloc(20);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(header);
  header.writeUInt16LE(machine, 18);
  return header;
}

/** AGENTCORE_BOXY_BIN and AGENTCORE_BOXY_SOURCE for a fake Linux arm64 boxy. */
function boxyEnv(machine = 183): NodeJS.ProcessEnv {
  const bin = temp();
  for (const name of BOXY_BINARIES) writeFileSync(join(bin, name), elf(machine));
  const source = temp();
  mkdirSync(join(source, "resources", "shared", "python"), { recursive: true });
  writeFileSync(join(source, "resources", "shared", "python", "pack.toml"), "[pack]\n");
  return { AGENTCORE_BOXY_BIN: bin, AGENTCORE_BOXY_SOURCE: source };
}

function boxProject(profile = boxProfileToml("us-west-2")): string {
  const root = temp();
  mkdirSync(join(root, "app", "agent", ".venv"), { recursive: true });
  writeFileSync(join(root, "app", "agent", "main.py"), "print('hi')\n");
  writeFileSync(join(root, "app", "agent", "pyproject.toml"), "[project]\nname = 'agent'\n");
  writeFileSync(join(root, "app", "agent", ".env"), "SECRET=1\n");
  mkdirSync(join(root, "box", "packs", "mine"), { recursive: true });
  writeFileSync(join(root, "box", "profile.toml"), profile);
  writeFileSync(join(root, "box", "policy.dw"), USER_POLICY_DW);
  writeFileSync(
    join(root, "box", "packs", "mine", "pack.toml"),
    '[egress.search]\nsecret.ref = "env://SEARCH_KEY"\n',
  );
  return root;
}

describe("containerProfile", () => {
  test("adds the container pack and the image's Python paths to [options]", () => {
    const out = containerProfile(boxProfileToml("us-west-2"));
    expect(out).toContain(
      'packs = ["boxy/python", "boxy/bedrock", "boxy/agentcore", "agentcore-container"]',
    );
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
    expect(containerProfile(profile, undefined, "main.py")).not.toContain("python.script =");
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
  test("stages the files from outside the project and builds from the root", async () => {
    const root = boxProject();
    const env = boxyEnv();
    expect(isBoxProject(root)).toBe(true);

    const build = await stageBoxContainer({
      projectRoot: root,
      runtime: { name: "agent", codeLocation: "app/agent/" },
      env,
    });

    // No Dockerfile in app/agent: the built-in one, staged.
    expect(build).toEqual({ context: ".", dockerfile: join(".box-build", "agent", "Dockerfile") });
    const dir = join(root, ".box-build", "agent");
    const dockerfile = readFileSync(join(root, build.dockerfile), "utf8");
    expect(dockerfile).toContain("WORKDIR /app/app/agent\n");
    expect(dockerfile).toContain("COPY app/agent/ /app/app/agent/");
    expect(dockerfile).toContain("COPY .box-build/agent/boxy/ /opt/boxy/");
    expect(dockerfile).not.toMatch(/\{\{\w+\}\}/);
    expect(statSync(join(dir, "entrypoint.sh")).mode & 0o111).not.toBe(0);
    for (const name of BOXY_BINARIES) {
      expect(existsSync(join(dir, "boxy", name))).toBe(true);
    }
    expect(existsSync(join(dir, "boxy", "resources", "shared", "python", "pack.toml"))).toBe(true);
    // The agent's code is not copied: the image takes it from app/agent.
    expect(existsSync(join(dir, "project"))).toBe(false);
    const profile = join(dir, "box-container");
    expect(readFileSync(join(profile, "profile.toml"), "utf8")).toContain('"agentcore-container"');
    expect(readFileSync(join(profile, "policy.dw"), "utf8")).toBe(USER_POLICY_DW);
    expect(existsSync(join(profile, "packs", "mine", "pack.toml"))).toBe(true);
    expect(
      readFileSync(join(profile, "packs", "agentcore-container", "pack.toml"), "utf8"),
    ).toContain('host = "0.0.0.0"');
    // The root .dockerignore lets in only app/ and .box-build/, without venvs or .env files.
    expect(readFileSync(join(root, ".dockerignore"), "utf8")).toBe(BOX_DOCKERIGNORE);
    expect(BOX_DOCKERIGNORE).toContain("*\n!app\n!.box-build\napp/**/.venv\napp/**/.env\n");
  });

  test("builds with the agent folder's box Dockerfile, not a template's own one", async () => {
    const root = boxProject();
    const env = boxyEnv();
    const runtime = { name: "agent", codeLocation: "app/agent" };
    const user = `${await boxDockerfile("app/agent", "agent")}RUN apt-get install -y ffmpeg\n`;
    writeFileSync(join(root, "app", "agent", "Dockerfile"), user);
    let build = await stageBoxContainer({ projectRoot: root, runtime, env });
    expect(build).toEqual({ context: ".", dockerfile: join("app", "agent", "Dockerfile") });
    expect(existsSync(join(root, ".box-build", "agent", "Dockerfile"))).toBe(false);

    // A Dockerfile that does not copy the staged files in is not a box image: the built-in one.
    writeFileSync(
      join(root, "app", "agent", "Dockerfile"),
      "FROM python:3.12\nCMD python main.py\n",
    );
    build = await stageBoxContainer({ projectRoot: root, runtime, env });
    expect(build.dockerfile).toBe(join(".box-build", "agent", "Dockerfile"));
    expect(readFileSync(join(root, build.dockerfile), "utf8")).toBe(
      await boxDockerfile("app/agent", "agent"),
    );
  });

  test("refuses to replace a .dockerignore the user wrote", async () => {
    const root = boxProject();
    writeFileSync(join(root, ".dockerignore"), "node_modules\n");
    await expect(
      stageBoxContainer({
        projectRoot: root,
        runtime: { name: "agent", codeLocation: "app/agent" },
        env: boxyEnv(),
      }),
    ).rejects.toThrow("is not agentcore's");
    expect(readFileSync(join(root, ".dockerignore"), "utf8")).toBe("node_modules\n");
  });

  test("adds the AWS routes to the deployed profile", async () => {
    const root = boxProject();
    const env = boxyEnv();
    await stageBoxContainer({
      projectRoot: root,
      runtime: { name: "agent", codeLocation: "app/agent" },
      env,
    });
    const staged = join(root, ".box-build", "agent");
    const localProfile = readFileSync(join(staged, "box-container", "profile.toml"), "utf8");
    expect(localProfile).not.toContain("aws://box-runtime");
    expect(localProfile).toContain('"agentcore-container", "agentcore-runtime"]');

    await stageBoxContainer({
      projectRoot: root,
      runtime: { name: "agent", codeLocation: "app/agent" },
      target: { kind: "aws", region: "eu-west-1" },
      env,
    });
    const profile = readFileSync(join(staged, "box-container", "profile.toml"), "utf8");
    expect(profile).toContain('[egress.bedrock]\nsecret.ref = "aws://box-runtime"');
    expect(profile).toContain(
      'destinations = ["*.gateway.bedrock-agentcore.eu-west-1.amazonaws.com"]',
    );
    expect(profile).toContain('destinations = ["bedrock-agentcore.eu-west-1.amazonaws.com"]');
    expect(
      readFileSync(
        join(staged, "box-container", "packs", "agentcore-runtime", "pack.toml"),
        "utf8",
      ),
    ).toContain('name = "agentcore-runtime"');
  });

  test("gives the local agent the deployed Gateways and a route signed as box-runtime", async () => {
    const root = boxProject();
    const env = boxyEnv();
    const runtime = { name: "agent", codeLocation: "app/agent" };
    const url = "https://demo-tools-4tz0r9jcyl.gateway.bedrock-agentcore.us-west-2.amazonaws.com";
    await stageBoxContainer({
      projectRoot: root,
      runtime,
      target: {
        kind: "local",
        gateways: [{ envName: "AGENTCORE_GATEWAY_TOOLS_URL", url, region: "us-west-2" }],
      },
      env,
    });
    const profileDir = join(root, ".box-build", "agent", "box-container");
    const profile = readFileSync(join(profileDir, "profile.toml"), "utf8");
    expect(profile).toContain('"agentcore-runtime", "agentcore-local-gateway"]');
    // The user's profile gets no route: the Gateway route is in agentcore's own pack.
    expect(profile).not.toContain("[egress.agentcore-gateway]");
    const pack = readFileSync(
      join(profileDir, "packs", "agentcore-local-gateway", "pack.toml"),
      "utf8",
    );
    expect(pack).toContain(`AGENTCORE_GATEWAY_TOOLS_URL = "${url}"`);
    expect(pack).toContain(
      '[egress.agentcore-gateway]\ndestinations = ["*.gateway.bedrock-agentcore.us-west-2.amazonaws.com"]\nsecret.ref = "aws://box-runtime"',
    );

    // Without deployed Gateways the local image has no Gateway pack.
    await stageBoxContainer({ projectRoot: root, runtime, target: { kind: "local" }, env });
    expect(readFileSync(join(profileDir, "profile.toml"), "utf8")).not.toContain(
      "agentcore-local-gateway",
    );
    expect(existsSync(join(profileDir, "packs", "agentcore-local-gateway"))).toBe(false);
  });

  test("refuses a Gateway URL or name that is not one", () => {
    expect(() =>
      localGatewayPack([
        {
          envName: "AGENTCORE_GATEWAY_TOOLS_URL",
          url: 'https://x" \n[egress.y]',
          region: "us-west-2",
        },
      ]),
    ).toThrow("unexpected Gateway variable");
    expect(() =>
      localGatewayPack([{ envName: "lower", url: "https://x.example.com", region: "us-west-2" }]),
    ).toThrow("unexpected Gateway variable");
    expect(() =>
      localGatewayPack([
        { envName: "AGENTCORE_GATEWAY_TOOLS_URL", url: "https://x.example.com", region: "x" },
      ]),
    ).toThrow("is not an AWS region");
  });

  test("refuses boxy binaries that are not built for Linux arm64", async () => {
    await expect(
      stageBoxContainer({
        projectRoot: boxProject(),
        runtime: { name: "agent", codeLocation: "app/agent" },
        env: boxyEnv(62),
      }),
    ).rejects.toThrow("is not a Linux arm64 program");
  });

  test("asks for the boxy binaries when they are not set", async () => {
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
