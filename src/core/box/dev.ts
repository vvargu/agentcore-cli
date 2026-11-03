// `agentcore dev` for a box project: build the box image (boxy run is its entry point) and run it
// with the usual container dev flow. Other projects keep their own runner.
import type { DevEvent, DevRunner, DevServerInput } from "../../handlers/project/dev/types";
import { rewriteOtelEndpointForContainer } from "../dev/otel/collector";
import { ContainerDevRunner } from "../dev/container";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  BOX_BUILD_CONTEXT,
  BOX_BUILD_DIRECTORY,
  boxSecretNames,
  isBoxProject,
  stageBoxContainer, BOX_PROFILE_ARG, LOCAL_PROFILE_DIRECTORY } from "./container";

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
    // syncRuntimeBuilds staged .box-build/<runtime> and set the build already; else stage here.
    let build = {
      context: input.runtime.buildContextPath as string | undefined,
      dockerfile: input.runtime.dockerfile as string | undefined,
    };
    if (
      build.context !== BOX_BUILD_CONTEXT ||
      !build.dockerfile ||
      !existsSync(join(input.projectRoot, BOX_BUILD_DIRECTORY, input.runtime.name, LOCAL_PROFILE_DIRECTORY))
    ) {
      yield { type: "status", message: "Box project: staging the box image" };
      build = await this.stage({ projectRoot: input.projectRoot, runtime: input.runtime });
    }

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
        buildContextPath: build.context,
        dockerfile: build.dockerfile,
        // The local profile; the Dockerfile's default is deploy's.
        customDockerBuildArgs: {
          ...input.runtime.customDockerBuildArgs,
          [BOX_PROFILE_ARG]: LOCAL_PROFILE_DIRECTORY,
        },
      } as DevServerInput["runtime"],
    });
  }
}
