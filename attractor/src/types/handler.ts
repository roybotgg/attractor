import type { FidelityMode } from "./fidelity.js";
import type { Node, Graph } from "./graph.js";
import type { Context } from "./context.js";
import type { Outcome } from "./outcome.js";

export interface BackendRunOptions {
  fidelityMode?: FidelityMode;
  threadId?: string;
  preToolHook?: string;
  postToolHook?: string;
  logsRoot?: string;
}

export interface Handler {
  execute(
    node: Node,
    context: Context,
    graph: Graph,
    logsRoot: string,
  ): Promise<Outcome>;
}

export interface CodergenBackend {
  run(node: Node, prompt: string, context: Context, options?: BackendRunOptions): Promise<string | Outcome>;
}
