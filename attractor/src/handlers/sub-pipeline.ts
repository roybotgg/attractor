import { readFileSync } from "node:fs";
import type { Handler } from "../types/handler.js";
import type { Node, Graph } from "../types/graph.js";
import type { Context } from "../types/context.js";
import type { Outcome } from "../types/outcome.js";
import type { CodergenBackend } from "../types/handler.js";
import { getStringAttr } from "../types/graph.js";
import { StageStatus, createOutcome } from "../types/outcome.js";
import { PipelineRunner } from "../engine/runner.js";
import type { HandlerRegistry } from "../engine/runner.js";
import { parse } from "../parser/index.js";

export interface SubPipelineHandlerConfig {
  handlerRegistry: HandlerRegistry;
  backend?: CodergenBackend;
  logsRoot?: string;
}

export class SubPipelineHandler implements Handler {
  private readonly config: SubPipelineHandlerConfig;

  constructor(config: SubPipelineHandlerConfig) {
    this.config = config;
  }

  async execute(
    node: Node,
    context: Context,
    _graph: Graph,
    logsRoot: string,
  ): Promise<Outcome> {
    // Read the sub-pipeline DOT file path from node attributes
    const dotFilePath =
      getStringAttr(node.attributes, "sub_pipeline") ||
      getStringAttr(node.attributes, "stack.child_dotfile");

    if (dotFilePath === "") {
      return createOutcome({
        status: StageStatus.FAIL,
        failureReason: `Node ${node.id}: missing sub_pipeline or stack.child_dotfile attribute`,
      });
    }

    // Read and parse the DOT file
    let dotContent: string;
    try {
      dotContent = readFileSync(dotFilePath, "utf-8");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return createOutcome({
        status: StageStatus.FAIL,
        failureReason: `Failed to read DOT file ${dotFilePath}: ${message}`,
      });
    }

    let childGraph: Graph;
    try {
      childGraph = parse(dotContent);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return createOutcome({
        status: StageStatus.FAIL,
        failureReason: `Failed to parse DOT file ${dotFilePath}: ${message}`,
      });
    }

    // Create a child PipelineRunner with a subset of the parent config
    const childRunner = new PipelineRunner({
      handlerRegistry: this.config.handlerRegistry,
      backend: this.config.backend,
      logsRoot: this.config.logsRoot ?? logsRoot,
    });

    // Run the child pipeline
    const childResult = await childRunner.run(childGraph);

    // Store child results in context
    const prefix = `sub_pipeline.${node.id}`;
    context.set(`${prefix}.status`, childResult.outcome.status);
    context.set(`${prefix}.completedNodes`, childResult.completedNodes.join(","));
    if (childResult.outcome.notes !== "") {
      context.set(`${prefix}.notes`, childResult.outcome.notes);
    }
    if (childResult.outcome.failureReason !== "") {
      context.set(`${prefix}.failureReason`, childResult.outcome.failureReason);
    }

    // Map child PipelineResult to Outcome
    return createOutcome({
      status: childResult.outcome.status,
      notes: `Sub-pipeline ${childGraph.name} completed with status: ${childResult.outcome.status}`,
      failureReason: childResult.outcome.failureReason,
      contextUpdates: {
        [`${prefix}.status`]: childResult.outcome.status,
      },
    });
  }
}
