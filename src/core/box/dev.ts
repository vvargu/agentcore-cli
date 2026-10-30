// `agentcore dev` for a box project: build the box image (boxy run is its entry point) and run it
// with the usual container dev flow. Other projects keep their own runner.
import type { DevEvent, DevRunner, DevServerInput } from "../../handlers/project/dev/types";
import { rewriteOtelEndpointForContainer } from "../dev/otel/collector";
import { ContainerDevRunner } from "../dev/container";
import { boxSecretNames, isBoxProject, stageBoxContainer } from "./container";

/** Box Core makes user namespaces and mounts a fresh /proc for the agent's sandbox. */
export const BOX_RUN_ARGS = [
  "--cap-add",
  "SYS_ADMIN",
  "--security-opt",
  "seccomp=unconfined",
  "--security-opt",
  "apparmor=unconfined",
];
/** The boxy/bedrock pack's secret. */
const BEDROCK_SECRET = "AWS_BEARER_TOKEN_BEDROCK";

type BoxDevRunnerConfig = {
  fallback: DevRunner;
  container?: DevRunner;
  stage?: typeof stageBoxContainer;
  processEnv?: NodeJS.ProcessEnv;
};

export class BoxDevRunner implements DevRunner {
  private readonly fallback: DevRunner;
  private readonly container: DevRunner;
  private readonly stage: typeof stageBoxContainer;
  private readonly processEnv: NodeJS.ProcessEnv;

  constructor(config: BoxDevRunnerConfig) {
    this.fallback = config.fallback;
    this.container = config.container ?? new ContainerDevRunner({ runArgs: BOX_RUN_ARGS });
    this.stage = config.stage ?? stageBoxContainer;
    this.processEnv = config.processEnv ?? process.env;
  }

  public async *run(input: DevServerInput): AsyncGenerator<DevEvent, void> {
    if (!isBoxProject(input.projectRoot)) {
      yield* this.fallback.run(input);
      return;
    }
    yield { type: "status", message: "Box project: staging the box image" };
    const context = await this.stage({ projectRoot: input.projectRoot, runtime: input.runtime });

    // Each env:// secret goes to the container, where boxy reads it; the agent never sees it.
    const env: Record<string, string> = rewriteOtelEndpointForContainer({ ...input.env });
    const missing: string[] = [];
    for (const name of [...boxSecretNames(input.projectRoot), BEDROCK_SECRET]) {
      const value = input.env?.[name] ?? this.processEnv[name];
      if (value) env[name] = value;
      else missing.push(name);
    }
    if (missing.length) {
      yield { type: "status", message: `Not set, so not passed to the box: ${missing.join(", ")}` };
    }

    yield* this.container.run({
      ...input,
      env,
      runtime: {
        ...input.runtime,
        build: "Container",
        buildContextPath: context,
        dockerfile: "Dockerfile",
      } as DevServerInput["runtime"],
    });
  }
}
