import { FsTreeNode } from "./fsTree";
import type { AssetSource } from "../source";
import type { ScaffoldRuntimeInput } from "../../../handlers/project/types";
import type {
  ImportBedrockAgentInput,
  RuntimeResourceConfig,
} from "../../../handlers/project/add/runtime/types";
import { InputValidationError } from "../../../errors/errors";
import { getRuntimeTemplateResolver } from "./runtime";
import { mergeSpecEntries } from "./spec";
import type { Template, TemplateRenderer } from "./types";
import type { EnvLocalEntry } from "../../../handlers/project/types";
import { BOX_DIRECTORY, BOX_GITIGNORE, BOX_POLICY_DW, boxProfileToml } from "../box";
import { boxDockerfile } from "../../box/container";

type CreateProjectConfig = {
  assetSource: AssetSource;
  templateRenderer: TemplateRenderer;
};
/** Scaffold a project from scratch, with optional support for rendering a runtime with the project. **/
export async function createProjectTree(
  config: CreateProjectConfig,
  input: { projectName: string },
  options?: {
    runtime?: ScaffoldRuntimeInput;
    importBedrockAgent?: ImportBedrockAgentInput;
    /** Write box/profile.toml and box/policy.dw for boxy. */
    box?: { region: string };
  },
): Promise<{ tree: FsTreeNode; envEntries: EnvLocalEntry[] }> {
  const templates: Template[] = [];
  if (options?.runtime) {
    const runtimeConfig: RuntimeResourceConfig = {
      name: options.runtime.runtimeName,
      scaffoldRuntimeInput: options.runtime,
      importBedrockAgent: options.importBedrockAgent,
    };

    const resolver = getRuntimeTemplateResolver(config, runtimeConfig);
    if (!resolver)
      throw new InputValidationError(`unable to find template that matches given parameters`);

    templates.push(await resolver.resolve(runtimeConfig));
  }

  const envEntries = templates.flatMap((template) => template.envEntries ?? []);

  const box = options?.box;
  // A box project's agent gets the box image Dockerfile, in place of a template's own one.
  if (box && options?.runtime) {
    for (const template of templates) {
      const agent = template.tree;
      const codeLocation = `app/${agent.name}`;
      agent.children = [
        ...agent.children.filter((child) => child.name !== "Dockerfile"),
        FsTreeNode.createFile("Dockerfile", () => boxDockerfile(codeLocation, config.assetSource)),
      ];
    }
  }
  const tree = FsTreeNode.createDirectory(".", [
    FsTreeNode.createFile(".gitignore", async () => {
      const gitignore = await config.assetSource.read("templates/shared/gitignore.template");
      return box ? `${gitignore}${BOX_GITIGNORE}` : gitignore;
    }),
    // boxy's profile and the user's policy rules, beside app/ (see ../box.ts).
    ...(box
      ? [
          FsTreeNode.createDirectory(BOX_DIRECTORY, [
            FsTreeNode.createFile("profile.toml", async () => boxProfileToml(box.region)),
            FsTreeNode.createFile("policy.dw", async () => BOX_POLICY_DW),
          ]),
        ]
      : []),
    FsTreeNode.createDirectory("agentcore", [
      await FsTreeNode.fromAssetSource({ assetSource: config.assetSource }, { assetDir: "cdk" }),
      FsTreeNode.createFile("agentcore.json", async () =>
        json({
          name: input.projectName,
          version: 2,
          managedBy: "CDK",
          ...mergeSpecEntries(templates.map(({ spec }) => spec)),
        }),
      ),
      FsTreeNode.createFile("aws-targets.json", async () => json([])),
      FsTreeNode.createFile(".env.local", () =>
        config.assetSource.read("templates/shared/env.local.template"),
      ),
    ]),
    FsTreeNode.createDirectory(
      "app",
      templates.map((t) => t.tree),
    ),
  ]);

  return { tree, envEntries };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
