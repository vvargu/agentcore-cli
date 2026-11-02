import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevEvent, DevRunner, DevServerInput } from "../../handlers/project/dev/types";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import { BoxDevRunner } from "./dev";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class Recorder implements DevRunner {
  public inputs: DevServerInput[] = [];
  public async *run(input: DevServerInput): AsyncGenerator<DevEvent, void> {
    this.inputs.push(input);
    yield { type: "status", message: "ran" };
  }
}

function project(box: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "agentcore-boxdev-"));
  temps.push(root);
  if (box) {
    mkdirSync(join(root, "box"));
    writeFileSync(
      join(root, "box", "profile.toml"),
      'packs = ["boxy/python"]\n[egress.x]\nsecret.ref = "env://EXAMPLE_API_KEY"\n',
    );
  }
  return root;
}

function input(root: string, env: Record<string, string> = {}): DevServerInput {
  return {
    runtime: {
      name: "agent",
      build: "CodeZip",
      codeLocation: "app/agent",
      entrypoint: "main.py",
    } as ProjectRuntime,
    projectRoot: root,
    port: 8080,
    env,
    signal: new AbortController().signal,
  };
}

async function collect(events: AsyncIterable<DevEvent>): Promise<DevEvent[]> {
  const out: DevEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("BoxDevRunner", () => {
  test("uses the fallback runner for a project without box/profile.toml", async () => {
    const fallback = new Recorder();
    const container = new Recorder();
    const runner = new BoxDevRunner({
      fallback,
      container,
      stage: async () => ({ context: ".", dockerfile: "unused" }),
    });
    await collect(runner.run(input(project(false))));
    expect(fallback.inputs).toHaveLength(1);
    expect(container.inputs).toHaveLength(0);
  });

  test("does not stage again when syncRuntimeBuilds already did", async () => {
    const container = new Recorder();
    let staged = 0;
    const runner = new BoxDevRunner({
      fallback: new Recorder(),
      container,
      stage: async () => {
        staged += 1;
        return { context: ".", dockerfile: "app/agent/Dockerfile" };
      },
      processEnv: {},
    });
    const root = project(true);
    mkdirSync(join(root, ".box-build", "agent", "box-container"), { recursive: true });
    const synced = input(root);
    synced.runtime = {
      ...synced.runtime,
      build: "Container",
      buildContextPath: ".",
      dockerfile: "app/agent/Dockerfile",
    } as ProjectRuntime;
    await collect(runner.run(synced));
    expect(staged).toBe(0);
    expect(container.inputs[0]!.runtime.buildContextPath as string).toBe(".");
    expect(container.inputs[0]!.runtime.dockerfile as string).toBe("app/agent/Dockerfile");
  });

  test("runs the staged box image with the profile's secrets", async () => {
    const container = new Recorder();
    const runner = new BoxDevRunner({
      fallback: new Recorder(),
      container,
      stage: async () => ({ context: ".", dockerfile: "app/agent/Dockerfile" }),
      processEnv: { EXAMPLE_API_KEY: "from-shell" },
    });
    const events = await collect(
      runner.run(
        input(project(true), { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318", OTHER: "1" }),
      ),
    );

    const ran = container.inputs[0]!;
    expect(ran.runtime.build).toBe("Container");
    expect(ran.runtime.buildContextPath as string).toBe(".");
    expect(ran.runtime.dockerfile as string).toBe("app/agent/Dockerfile");
    expect(events[0]).toEqual({ type: "status", message: "Box project: staging the box image" });
    expect(ran.env).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://host.docker.internal:4318",
      OTHER: "1",
      EXAMPLE_API_KEY: "from-shell",
    });
    expect(events).toContainEqual({
      type: "status",
      message: "Not set, so not passed to the box: AWS_BEARER_TOKEN_BEDROCK",
    });
  });
});
