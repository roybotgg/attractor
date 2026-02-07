import type { Node } from "../types/graph.js";
import type { BackendRunOptions } from "../types/handler.js";
import { getStringAttr } from "../types/graph.js";
import { CliAgentBackend } from "./cli-backend.js";
import type { CliAgentConfig } from "./cli-backend.js";

export class ClaudeCodeBackend extends CliAgentBackend {
  constructor(config?: Partial<CliAgentConfig>) {
    super({
      command: config?.command ?? "claude",
      defaultArgs: config?.defaultArgs ?? ["--print"],
      env: config?.env,
      timeoutMs: config?.timeoutMs,
    });
  }

  protected buildArgs(
    _prompt: string,
    node: Node,
    options?: BackendRunOptions,
  ): string[] {
    const args = [...(this.config.defaultArgs ?? [])];

    const model = getStringAttr(node.attributes, "llm_model");
    if (model !== "") {
      args.push("--model", model);
    }

    if (options?.logsRoot) {
      args.push("--output-dir", options.logsRoot);
    }

    return args;
  }
}
