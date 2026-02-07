import type { Node } from "../types/graph.js";
import type { BackendRunOptions } from "../types/handler.js";
import { getStringAttr } from "../types/graph.js";
import { CliAgentBackend } from "./cli-backend.js";
import type { CliAgentConfig } from "./cli-backend.js";

export class GeminiBackend extends CliAgentBackend {
  constructor(config?: Partial<CliAgentConfig>) {
    super({
      command: config?.command ?? "gemini",
      defaultArgs: config?.defaultArgs ?? [],
      env: config?.env,
      timeoutMs: config?.timeoutMs,
    });
  }

  protected buildArgs(
    _prompt: string,
    node: Node,
    _options?: BackendRunOptions,
  ): string[] {
    const args = [...(this.config.defaultArgs ?? [])];

    const model = getStringAttr(node.attributes, "llm_model");
    if (model !== "") {
      args.push("--model", model);
    }

    return args;
  }
}
