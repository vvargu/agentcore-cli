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
import { parse as parseToml } from "smol-toml";
import { InvalidEnvironmentError } from "../../errors";
import { boxProfileToml } from "../project/box";

/** A policy.dw the user wrote. */
const USER_POLICY_DW = '@id("spawn_curl") permit (principal, action, resource);\n';
import {
  BOXY_BINARIES,
  BOX_DOCKERIGNORE,
  awsRouteTables,
  boxDockerfile,
  localGatewayTables,
  boxSecretNames,
  containerProfile,
  isBoxProject,
  stageBoxContainer,
} from "./container";

/** A parsed TOML file, for reading nested keys in a test. */
// biome-ignore lint/suspicious/noExplicitAny: test helper over parsed TOML
type Toml = any;
const toml = (text: string): Toml => parseToml(text);

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
  test("adds ingress, the image's folders, and its Python paths, and keeps the user's keys", () => {
    const out = containerProfile(boxProfileToml("us-west-2"));
    const t = toml(out);
    // No packs of agentcore's own: the user's packs, as written.
    expect(t.packs).toEqual(["boxy/python", "boxy/bedrock", "boxy/agentcore"]);
    expect(t.agent.command).toEqual([
      "${{ inputs.python.program }}",
      "${{ inputs.python.script }}",
    ]);
    expect(t.agent.ingress).toEqual({ host: "0.0.0.0", port: 8080 });
    expect(t.agent.filesystem.read).toEqual(["/usr/local/bin", "/usr/lib/aarch64-linux-gnu"]);
    expect(t.options.python).toEqual({ venv: "/opt/agent-venv", runtime: "/usr/local/lib" });
    expect(t.options.bedrock.region).toBe("us-west-2");
    expect(out.startsWith("# Written by agentcore")).toBe(true);
  });

  test("joins the user's grants, keeps the user's ingress port, and overrides the venv", () => {
    const t = toml(
      containerProfile(
        'packs = ["boxy/python"]\n[agent]\ncommand = ["x"]\ningress.port = 9000\n' +
          '[agent.filesystem]\nread = ["/data"]\n[options]\npython.venv = "/mine"\n',
      ),
    );
    expect(t.agent.ingress).toEqual({ host: "0.0.0.0", port: 9000 });
    expect(t.agent.filesystem.read).toEqual(["/data", "/usr/local/bin", "/usr/lib/aarch64-linux-gnu"]);
    expect(t.options.python.venv).toBe("/opt/agent-venv");
  });

  test("sets python.script from the runtime entrypoint unless the profile sets it", () => {
    const profile = boxProfileToml("us-west-2");
    expect(toml(containerProfile(profile, { entrypoint: "main.py" })).options.python.script).toBe(
      undefined,
    );
    expect(toml(containerProfile(profile, { entrypoint: "app.py:app" })).options.python.script).toBe(
      "app.py",
    );
    const own = profile.replace("[options]\n", '[options]\npython.script = "x.py"\n');
    expect(toml(containerProfile(own, { entrypoint: "app.py" })).options.python.script).toBe("x.py");
  });

  test("writes [agent.env] last, with the user's variables, for entrypoint.sh to append to", () => {
    const out = containerProfile(
      'packs = ["boxy/python"]\n[agent]\ncommand = ["x"]\n[agent.env]\nMINE = "1"\n',
      { awsRegion: "us-west-2" },
    );
    const headers = out.match(/^\[[^\]]+\]/gm) ?? [];
    expect(headers.at(-1)).toBe("[agent.env]");
    expect(toml(out).agent.env).toEqual({ MINE: "1" });
    // A line appended at the end lands in [agent.env].
    expect(toml(`${out}ADDED = "2"\n`).agent.env).toEqual({ MINE: "1", ADDED: "2" });
  });

  test("adds the AWS routes for deploy, and refuses a route the user declares", () => {
    const t = toml(containerProfile(boxProfileToml("eu-west-1"), { awsRegion: "eu-west-1" }));
    expect(t.egress.bedrock.secret.ref).toBe("aws://box-runtime");
    expect(t.egress["agentcore-gateway"].destinations).toEqual([
      "*.gateway.bedrock-agentcore.eu-west-1.amazonaws.com",
    ]);
    expect(t.egress["agentcore-data"].destinations).toEqual([
      "bedrock-agentcore.eu-west-1.amazonaws.com",
    ]);
    expect(() =>
      containerProfile('[egress.bedrock]\nsecret.ref = "aws://x"\n', { awsRegion: "us-west-2" }),
    ).toThrow(InvalidEnvironmentError);
    // A commented example is not a declaration.
    expect(() =>
      containerProfile("# [egress.bedrock]\n", { awsRegion: "us-west-2" }),
    ).not.toThrow();
    expect(() => awsRouteTables('us-west-2"\n[x]')).toThrow(InvalidEnvironmentError);
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
    const staged = toml(readFileSync(join(profile, "profile.toml"), "utf8"));
    expect(staged.agent.ingress).toEqual({ host: "0.0.0.0", port: 8080 });
    expect(readFileSync(join(profile, "policy.dw"), "utf8")).toBe(USER_POLICY_DW);
    // The user's own packs are copied; agentcore adds none.
    expect(existsSync(join(profile, "packs", "mine", "pack.toml"))).toBe(true);
    expect(existsSync(join(profile, "packs", "agentcore-container"))).toBe(false);
    expect(existsSync(join(profile, "packs", "agentcore-runtime"))).toBe(false);
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

    await stageBoxContainer({
      projectRoot: root,
      runtime: { name: "agent", codeLocation: "app/agent" },
      target: { kind: "aws", region: "eu-west-1" },
      env,
    });
    const profile = toml(readFileSync(join(staged, "box-container", "profile.toml"), "utf8"));
    expect(profile.egress.bedrock.secret.ref).toBe("aws://box-runtime");
    expect(profile.egress["agentcore-gateway"].destinations).toEqual([
      "*.gateway.bedrock-agentcore.eu-west-1.amazonaws.com",
    ]);
    expect(profile.egress["agentcore-data"].destinations).toEqual([
      "bedrock-agentcore.eu-west-1.amazonaws.com",
    ]);
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
    const profile = toml(readFileSync(join(profileDir, "profile.toml"), "utf8"));
    expect(profile.agent.env.AGENTCORE_GATEWAY_TOOLS_URL).toBe(url);
    expect(profile.egress["agentcore-gateway"]).toEqual({
      destinations: ["*.gateway.bedrock-agentcore.us-west-2.amazonaws.com"],
      secret: { ref: "aws://box-runtime" },
    });
    // box/profile.toml is unchanged.
    expect(readFileSync(join(root, "box", "profile.toml"), "utf8")).toBe(boxProfileToml("us-west-2"));

    // Without deployed Gateways the local image has no Gateway route.
    await stageBoxContainer({ projectRoot: root, runtime, target: { kind: "local" }, env });
    expect(
      toml(readFileSync(join(profileDir, "profile.toml"), "utf8")).egress?.["agentcore-gateway"],
    ).toBe(undefined);
  });

  test("refuses a Gateway URL or name that is not one", () => {
    expect(() =>
      localGatewayTables([
        {
          envName: "AGENTCORE_GATEWAY_TOOLS_URL",
          url: 'https://x" \n[egress.y]',
          region: "us-west-2",
        },
      ]),
    ).toThrow("unexpected Gateway variable");
    expect(() =>
      localGatewayTables([{ envName: "lower", url: "https://x.example.com", region: "us-west-2" }]),
    ).toThrow("unexpected Gateway variable");
    expect(() =>
      localGatewayTables([
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

// entrypoint.sh appends the Gateway and Memory variables to [agent.env] with Python.
const python = Bun.which("python3");
describe.skipIf(!python)("entrypoint.sh's runtime variables", () => {
  const script = readFileSync(
    join(import.meta.dir, "../../assets/box/container/entrypoint.sh"),
    "utf8",
  );
  const body = /profile\.toml <<'PY'\n([\s\S]*?)\nPY\n/.exec(script)?.[1];
  const run = (file: string, env: Record<string, string>): void => {
    execFileSync(python!, ["-", file], { input: body, env: { PATH: process.env.PATH ?? "", ...env } });
  };

  test("appends the Gateway and Memory identifiers to [agent.env], and no secret", () => {
    expect(body).toBeDefined();
    const file = join(temp(), "profile.toml");
    writeFileSync(
      file,
      containerProfile(
        'packs = ["boxy/python"]\n[agent]\ncommand = ["x"]\n[agent.env]\nMEMORY_NOTES_ID = "mine"\n',
        { awsRegion: "us-west-2" },
      ),
    );
    const env = {
      AGENTCORE_GATEWAY_TOOLS_URL: "https://gw-1.gateway.bedrock-agentcore.us-west-2.amazonaws.com",
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
    };
    run(file, env);
    // A second start (a restarted container) adds nothing twice.
    run(file, env);
    const text = readFileSync(file, "utf8");
    const t = toml(text);
    expect(t.agent.env).toEqual({
      AGENTCORE_GATEWAY_TOOLS_AUTH_TYPE: "AWS_IAM",
      AGENTCORE_GATEWAY_TOOLS_URL: "https://gw-1.gateway.bedrock-agentcore.us-west-2.amazonaws.com",
      MEMORY_NOTES_ARN: "arn:aws:bedrock-agentcore:us-west-2:111122223333:memory/notes-abc123",
      // The profile's own value wins.
      MEMORY_NOTES_ID: "mine",
    });
    expect(text).not.toContain("secret\"");
    expect(t.egress.bedrock.secret.ref).toBe("aws://box-runtime");
  });

  test("passes nothing when [agent.env] is not the last table", () => {
    const file = join(temp(), "profile.toml");
    writeFileSync(file, '[agent.env]\nA = "1"\n[egress.x]\ndestinations = ["x"]\n');
    expect(() => run(file, { MEMORY_NOTES_ID: "notes-abc123" })).toThrow();
    expect(readFileSync(file, "utf8")).not.toContain("MEMORY_NOTES_ID");
  });
});
