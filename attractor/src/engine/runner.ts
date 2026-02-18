import type { Graph, Node, Edge } from "../types/graph.js";
import type { Outcome } from "../types/outcome.js";
import type { Checkpoint } from "../types/checkpoint.js";
import type { Handler } from "../types/handler.js";
import type { Interviewer } from "../types/interviewer.js";
import type { CodergenBackend } from "../types/handler.js";
import type { PipelineEvent, PipelineEventKind, PipelineEventDataMap } from "../types/events.js";
import type { Transform } from "../types/transform.js";
import type { LintRule } from "../types/diagnostic.js";
import type { CxdbStore } from "../cxdb/store.js";
import { Context } from "../types/context.js";
import { StageStatus, createOutcome } from "../types/outcome.js";
import { PipelineEventKind as EventKind } from "../types/events.js";
import { getStringAttr, getIntegerAttr, getBooleanAttr, getDurationAttr, attrToString } from "../types/graph.js";
import { selectEdge } from "./edge-selection.js";
import { buildRetryPolicy, executeWithRetry } from "./retry.js";
import { checkGoalGates, getRetryTarget } from "./goal-gates.js";
import { saveCheckpoint, loadCheckpoint } from "./checkpoint.js";
import { buildPreamble, resolveFidelity } from "./fidelity.js";
import { validateOrRaise } from "../validation/validate.js";
import { builtInTransforms } from "../transforms/index.js";
import { FidelityMode as FM, isValidFidelityMode } from "../types/fidelity.js";
import { dirname, join } from "path";
import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { ArtifactStore } from "../types/artifact.js";
import { parseOutcomeFromStatusFile, statusFileFromOutcome } from "../utils/status-file.js";

/** Shape-to-handler-type mapping from spec 2.8 */
const SHAPE_TO_TYPE: Record<string, string> = {
  Mdiamond: "start",
  Msquare: "exit",
  box: "codergen",
  hexagon: "wait.human",
  diamond: "conditional",
  component: "parallel",
  tripleoctagon: "parallel.fan_in",
  parallelogram: "tool",
  house: "stack.manager_loop",
};

export interface HandlerRegistry {
  handlers: Map<string, Handler>;
  defaultHandler: Handler | undefined;

  register(typeString: string, handler: Handler): void;
  resolve(node: Node): Handler | undefined;
}

export function createHandlerRegistry(): HandlerRegistry {
  const handlers = new Map<string, Handler>();
  let defaultHandler: Handler | undefined;

  return {
    handlers,
    get defaultHandler() {
      return defaultHandler;
    },
    set defaultHandler(h: Handler | undefined) {
      defaultHandler = h;
    },
    register(typeString: string, handler: Handler): void {
      handlers.set(typeString, handler);
    },
    resolve(node: Node): Handler | undefined {
      // 1. Explicit type attribute
      const explicitType = getStringAttr(node.attributes, "type");
      if (explicitType !== "") {
        const h = handlers.get(explicitType);
        if (h) return h;
      }

      // 2. Shape-based resolution
      const shape = getStringAttr(node.attributes, "shape", "box");
      const handlerType = SHAPE_TO_TYPE[shape];
      if (handlerType) {
        const h = handlers.get(handlerType);
        if (h) return h;
      }

      // 3. Default
      return defaultHandler;
    },
  };
}

export interface EventEmitter {
  emit(event: PipelineEvent): void;
}

export interface PipelineRunnerConfig {
  handlerRegistry: HandlerRegistry;
  interviewer?: Interviewer;
  backend?: CodergenBackend;
  transforms?: Transform[];
  extraLintRules?: LintRule[];
  eventEmitter?: EventEmitter;
  onEvent?: (event: PipelineEvent) => void;
  onCheckpoint?: (checkpoint: Checkpoint) => void;
  logsRoot?: string;
  cleanup?: () => Promise<void>;
  /** Optional CXDB store for persisting pipeline runs to the turn DAG. */
  cxdbStore?: CxdbStore;
  /** Default model alias (for CXDB tracking). */
  model?: string;
  abortSignal?: AbortSignal;
}

export interface PipelineResult {
  outcome: Outcome;
  completedNodes: string[];
  context: Context;
  artifactStore: ArtifactStore;
}

function isTerminal(node: Node): boolean {
  const shape = getStringAttr(node.attributes, "shape");
  const nodeType = getStringAttr(node.attributes, "type");
  const lowerId = node.id.toLowerCase();
  return (
    shape === "Msquare" ||
    nodeType === "exit" ||
    lowerId === "exit" ||
    lowerId === "end"
  );
}

function findStartNode(graph: Graph): Node {
  // 1. shape=Mdiamond
  for (const node of graph.nodes.values()) {
    if (getStringAttr(node.attributes, "shape") === "Mdiamond") {
      return node;
    }
  }
  // 2. id-based fallback (case-insensitive, matches validation rules)
  for (const node of graph.nodes.values()) {
    if (node.id.toLowerCase() === "start") return node;
  }

  throw new Error("No start node found: need shape=Mdiamond or id=start");
}

function mirrorGraphAttributes(graph: Graph, context: Context): void {
  for (const [key, attr] of graph.attributes) {
    context.set(`graph.${key}`, attrToString(attr));
  }
}

interface LoopState {
  context: Context;
  completedNodes: string[];
  nodeOutcomes: Map<string, Outcome>;
  nodeRetries: Map<string, number>;
  currentNode: Node;
  currentIncomingEdge: Edge | undefined;
  previousNodeId: string;
  lastOutcome: Outcome;
  restartCount: number;
  degradeNextFidelity: boolean;
  logsRoot: string;
  artifactStore: ArtifactStore;
}

export class PipelineRunner {
  private config: PipelineRunnerConfig;
  private pipelineId: string;
  private additionalTransforms: Transform[] = [];

  constructor(config: PipelineRunnerConfig) {
    this.config = config;
    this.pipelineId = randomUUID();
  }

  registerTransform(transform: Transform): void {
    this.additionalTransforms.push(transform);
  }

  /** Apply transforms + validate, skipping if already applied (prevents double-transform). */
  private prepareGraph(input: Graph): Graph {
    if (input._transformsApplied) {
      return input;
    }
    let graph = input;
    const allTransforms = [
      ...builtInTransforms(),
      ...(this.config.transforms ?? []),
      ...this.additionalTransforms,
    ];
    for (const transform of allTransforms) {
      graph = transform.apply(graph);
    }
    validateOrRaise(graph, this.config.extraLintRules);
    graph._transformsApplied = true;
    return graph;
  }

  async run(input: Graph): Promise<PipelineResult> {
    const graph = this.prepareGraph(input);

    // Initialize context
    const context = new Context();
    context.set("run_id", this.pipelineId);
    mirrorGraphAttributes(graph, context);

    // Create run directory with unique run ID
    const logsRoot = join(this.config.logsRoot ?? "/tmp/attractor-logs", this.pipelineId);

    const state: LoopState = {
      context,
      completedNodes: [],
      nodeOutcomes: new Map(),
      nodeRetries: new Map(),
      currentNode: findStartNode(graph),
      currentIncomingEdge: undefined,
      previousNodeId: "",
      lastOutcome: createOutcome({ status: StageStatus.SUCCESS }),
      restartCount: 0,
      degradeNextFidelity: false,
      logsRoot,
      artifactStore: new ArtifactStore({ baseDir: logsRoot }),
    };

    this.emitEvent(EventKind.PIPELINE_STARTED, { graphName: graph.name });

    // Initialize CXDB tracking if configured
    await this.safeCxdb("onPipelineStart", () =>
      this.config.cxdbStore!.onPipelineStart({
        pipelineId: this.pipelineId,
        graphName: graph.name,
        goal: getStringAttr(graph.attributes, "goal"),
        model: this.config.model,
      }),
    );

    try {
      await mkdir(logsRoot, { recursive: true });
      const manifest = {
        graphName: graph.name,
        goal: getStringAttr(graph.attributes, "goal"),
        startedAt: new Date().toISOString(),
        pipelineId: this.pipelineId,
      };
      await writeFile(join(logsRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
    } catch {
      // Run directory creation is non-fatal
    }

    // Save initial checkpoint
    await this.saveCheckpointSafe(logsRoot, {
      pipelineId: this.pipelineId,
      timestamp: new Date().toISOString(),
      currentNode: state.currentNode.id,
      completedNodes: [],
      nodeRetries: {},
      nodeOutcomes: {},
      contextValues: context.snapshot(),
      logs: [],
    });

    return this.executeLoop(graph, state);
  }

  async resume(input: Graph, checkpointPath: string): Promise<PipelineResult> {
    const graph = this.prepareGraph(input);
    const checkpoint = await loadCheckpoint(checkpointPath);

    // Restore context
    const context = new Context();
    context.applyUpdates(checkpoint.contextValues);
    if (!context.has("run_id")) {
      context.set("run_id", checkpoint.pipelineId);
    }

    // Restore completedNodes
    const completedNodes = [...checkpoint.completedNodes];

    // Restore nodeRetries
    const nodeRetries = new Map<string, number>();
    for (const [nodeId, count] of Object.entries(checkpoint.nodeRetries)) {
      nodeRetries.set(nodeId, count);
    }

    // Determine next node: select edge from checkpoint.currentNode using last outcome
    const checkpointNode = graph.nodes.get(checkpoint.currentNode);
    if (!checkpointNode) {
      throw new Error(`Checkpoint currentNode not found in graph: ${checkpoint.currentNode}`);
    }

    const outcomeStatus = context.getString("outcome", StageStatus.SUCCESS);
    const lastOutcome = createOutcome({
      status: outcomeStatus as StageStatus,
      preferredLabel: context.getString("preferred_label"),
    });

    const nextEdge = selectEdge(checkpointNode, lastOutcome, context, graph);
    if (!nextEdge) {
      throw new Error(`No outgoing edge from checkpoint node: ${checkpoint.currentNode}`);
    }

    const nextNode = graph.nodes.get(nextEdge.to);
    if (!nextNode) {
      throw new Error(`Edge target node not found: ${nextEdge.to}`);
    }

    // Restore nodeOutcomes from checkpoint
    const nodeOutcomes = new Map<string, Outcome>();
    if (checkpoint.nodeOutcomes) {
      for (const [nodeId, status] of Object.entries(checkpoint.nodeOutcomes)) {
        nodeOutcomes.set(nodeId, createOutcome({ status: status as StageStatus }));
      }
    }

    const logsRoot = join(this.config.logsRoot ?? "/tmp/attractor-logs", this.pipelineId);

    const state: LoopState = {
      context,
      completedNodes,
      nodeOutcomes,
      nodeRetries,
      currentNode: nextNode,
      currentIncomingEdge: nextEdge,
      previousNodeId: checkpoint.currentNode,
      lastOutcome,
      restartCount: 0,
      degradeNextFidelity: context.getString("_fidelity.mode") === FM.FULL,
      logsRoot,
      artifactStore: new ArtifactStore({ baseDir: logsRoot }),
    };

    this.emitEvent(EventKind.PIPELINE_STARTED, { graphName: graph.name });

    return this.executeLoop(graph, state);
  }

  private async executeLoop(graph: Graph, state: LoopState): Promise<PipelineResult> {
    let { context } = state;
    const { completedNodes, nodeOutcomes, nodeRetries, artifactStore } = state;
    let {
      currentNode,
      currentIncomingEdge,
      previousNodeId,
      lastOutcome,
      restartCount,
      degradeNextFidelity,
    } = state;
    const baseLogsRoot = state.logsRoot;
    let logsRoot = baseLogsRoot;

    while (true) {
      // Check for cancellation via AbortSignal
      if (this.config.abortSignal?.aborted) {
        this.emitEvent(EventKind.PIPELINE_FAILED, {
          reason: "Pipeline cancelled",
        });
        return {
          outcome: createOutcome({
            status: StageStatus.FAIL,
            failureReason: "Pipeline cancelled",
          }),
          completedNodes,
          context,
          artifactStore,
        };
      }

      // Step 1: Check for terminal node
      if (isTerminal(currentNode)) {
        const gateResult = checkGoalGates(graph, nodeOutcomes);
        if (!gateResult.satisfied && gateResult.failedGate) {
          const retryTarget = getRetryTarget(gateResult.failedGate, graph);
          if (retryTarget) {
            const targetNode = graph.nodes.get(retryTarget);
            if (targetNode) {
              previousNodeId = currentNode.id;
              currentIncomingEdge = undefined;
              currentNode = targetNode;
              continue;
            }
          }
          this.emitEvent(EventKind.PIPELINE_FAILED, {
            reason: `Goal gate unsatisfied: ${gateResult.failedGate.id}`,
          });
          return {
            outcome: createOutcome({
              status: StageStatus.FAIL,
              failureReason: `Goal gate unsatisfied: ${gateResult.failedGate.id} and no retry target`,
            }),
            completedNodes,
            context,
            artifactStore,
          };
        }
        break;
      }

      // Resolve fidelity for the current node from the actual incoming edge.
      const fidelityResult = resolveFidelity(
        currentNode,
        currentIncomingEdge,
        graph,
        previousNodeId,
      );
      context.set("_fidelity.mode", fidelityResult.mode);
      context.set("_fidelity.threadId", fidelityResult.threadId);

      // Apply degraded fidelity for first node after resume
      if (degradeNextFidelity) {
        context.set("_fidelity.mode", FM.SUMMARY_HIGH);
        context.set("_fidelity.threadId", "");
        degradeNextFidelity = false;
      }

      const fidelityModeRaw = context.getString("_fidelity.mode", FM.COMPACT);
      const fidelityMode = isValidFidelityMode(fidelityModeRaw)
        ? fidelityModeRaw
        : FM.COMPACT;
      context.set("_fidelity.preamble", "");
      if (fidelityMode !== FM.FULL) {
        const preamble = buildPreamble(
          fidelityMode,
          context,
          completedNodes,
          nodeOutcomes,
          graph,
        );
        context.set("_fidelity.preamble", preamble);
      }

      // max_visits enforcement: bound graph-level loops (distinct from per-node max_retries)
      const maxVisits = getIntegerAttr(currentNode.attributes, "max_visits", 0);
      if (maxVisits > 0) {
        const visitCount = completedNodes.filter((id) => id === currentNode.id).length;
        if (visitCount >= maxVisits) {
          const reason = `Node "${currentNode.id}" exceeded max_visits=${maxVisits}`;
          const failOutcome = createOutcome({
            status: StageStatus.FAIL,
            failureReason: reason,
          });
          this.emitEvent(EventKind.STAGE_FAILED, { nodeId: currentNode.id, reason, willRetry: false });
          completedNodes.push(currentNode.id);
          nodeOutcomes.set(currentNode.id, failOutcome);
          lastOutcome = failOutcome;
          // Follow normal failure routing (fail edge → retry_target → terminate)
          const failEdge = selectEdge(currentNode, failOutcome, context, graph);
          if (failEdge) {
            const nextNode = graph.nodes.get(failEdge.to);
            if (nextNode) {
              previousNodeId = currentNode.id;
              currentIncomingEdge = failEdge;
              currentNode = nextNode;
              continue;
            }
          }
          this.emitEvent(EventKind.PIPELINE_FAILED, { reason, nodeId: currentNode.id });
          return { outcome: failOutcome, completedNodes, context, artifactStore };
        }
      }

      // Step 2: Execute node handler with retry policy
      context.set("current_node", currentNode.id);
      this.emitEvent(EventKind.STAGE_STARTED, { nodeId: currentNode.id });
      const statusPath = join(logsRoot, currentNode.id, "status.json");
      try {
        await unlink(statusPath);
      } catch {
        // No prior status file to clear.
      }

      const handler = this.config.handlerRegistry.resolve(currentNode);
      if (!handler) {
        const failOutcome = createOutcome({
          status: StageStatus.FAIL,
          failureReason: `No handler found for node: ${currentNode.id}`,
        });
        this.emitEvent(EventKind.STAGE_FAILED, {
          nodeId: currentNode.id,
          reason: failOutcome.failureReason,
        });
        this.emitEvent(EventKind.PIPELINE_FAILED, {
          reason: failOutcome.failureReason,
          nodeId: currentNode.id,
        });
        return { outcome: failOutcome, completedNodes, context, artifactStore };
      }

      const retryPolicy = buildRetryPolicy(currentNode, graph);
      const retryExecution = executeWithRetry(
        currentNode,
        context,
        graph,
        logsRoot,
        handler,
        retryPolicy,
        {
          onRetry: (nodeId, attempt, maxAttempts, reason) => {
            this.emitEvent(EventKind.STAGE_RETRYING, {
              nodeId,
              attempt,
              maxAttempts,
              reason,
            });
          },
        },
      );

      // Node timeout enforcement (spec 2.6: timeout attribute)
      const timeoutMs = getDurationAttr(currentNode.attributes, "timeout");
      let retryResult: Awaited<typeof retryExecution>;
      if (timeoutMs !== undefined) {
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`Node timeout exceeded: ${timeoutMs}ms`)), timeoutMs);
        });
        try {
          retryResult = await Promise.race([retryExecution, timeoutPromise]);
        } catch (error: unknown) {
          const err = error instanceof Error ? error : new Error(String(error));
          retryResult = {
            outcome: createOutcome({
              status: StageStatus.FAIL,
              failureReason: err.message,
            }),
            attempts: 0,
          };
        }
      } else {
        retryResult = await retryExecution;
      }

      let outcome = retryResult.outcome;
      const statusExists = existsSync(statusPath);

      if (statusExists) {
        try {
          const content = await readFile(statusPath, "utf-8");
          outcome = parseOutcomeFromStatusFile(content, outcome);
        } catch {
          // Keep handler outcome when status file cannot be parsed.
        }
      }

      // auto_status enforcement (spec 2.6/Appendix C)
      if (getBooleanAttr(currentNode.attributes, "auto_status", false)) {
        if (!statusExists) {
          outcome = createOutcome({
            status: StageStatus.SUCCESS,
            notes: "auto-status: handler completed without writing status",
          });
        }
      }

      await this.writeStatusSafe(statusPath, outcome);

      // Step 3: Record completion
      completedNodes.push(currentNode.id);
      nodeOutcomes.set(currentNode.id, outcome);
      nodeRetries.set(currentNode.id, retryResult.attempts);
      lastOutcome = outcome;

      if (outcome.status === StageStatus.FAIL) {
        this.emitEvent(EventKind.STAGE_FAILED, {
          nodeId: currentNode.id,
          reason: outcome.failureReason,
          willRetry: false,
        });
      } else {
        this.emitEvent(EventKind.STAGE_COMPLETED, {
          nodeId: currentNode.id,
          status: outcome.status,
        });
      }

      // Track stage completion in CXDB
      const nodeModel = getStringAttr(currentNode.attributes, "model", "") || this.config.model || "";
      await this.safeCxdb("onStageComplete", () =>
        this.config.cxdbStore!.onStageComplete(
          currentNode.id,
          outcome,
          retryResult.attempts,
          undefined,
          nodeModel || undefined,
        ),
      );

      // Step 4: Apply context updates
      context.applyUpdates(outcome.contextUpdates);
      context.set("outcome", outcome.status);
      if (outcome.preferredLabel !== "") {
        context.set("preferred_label", outcome.preferredLabel);
      }

      // Built-in context keys (spec 5.2)
      context.set("last_stage", currentNode.id);
      if (!outcome.contextUpdates["last_response"]) {
        context.set("last_response", outcome.notes.slice(0, 200));
      }
      context.set(`internal.retry_count.${currentNode.id}`, retryResult.attempts);

      // Step 5: Save checkpoint
      const retriesRecord: Record<string, number> = {};
      for (const [nodeId, count] of nodeRetries) {
        retriesRecord[nodeId] = count;
      }
      const outcomesRecord: Record<string, string> = {};
      for (const [nodeId, o] of nodeOutcomes) {
        outcomesRecord[nodeId] = o.status;
      }
      await this.saveCheckpointSafe(logsRoot, {
        pipelineId: this.pipelineId,
        timestamp: new Date().toISOString(),
        currentNode: currentNode.id,
        completedNodes: [...completedNodes],
        nodeRetries: retriesRecord,
        nodeOutcomes: outcomesRecord,
        contextValues: context.snapshot(),
        logs: [...context.logs()],
      });

      // Step 6: Select next edge with failure routing (spec 3.7)
      // Order: (1) fail edge, (2) node retry_target, (3) node fallback_retry_target,
      //        (4) graph retry_target, (5) graph fallback_retry_target, (6) unconditional edge, (7) termination
      const nextEdge = selectEdge(currentNode, outcome, context, graph);

      if (outcome.status === StageStatus.FAIL) {
        // Check if selectEdge found a fail-condition edge (step 1)
        const hasFailEdge = nextEdge !== undefined &&
          getStringAttr(nextEdge.attributes, "condition").includes("outcome=fail");

        if (!hasFailEdge) {
          // Steps 2-5: consult retry_target chain (takes priority over unconditional edges)
          const failRetryTarget = getRetryTarget(currentNode, graph);
          if (failRetryTarget) {
            const targetNode = graph.nodes.get(failRetryTarget);
            if (targetNode) {
              previousNodeId = currentNode.id;
              currentIncomingEdge = undefined;
              currentNode = targetNode;
              continue;
            }
          }
          // No retry_target found: if no edge at all, terminate
          if (!nextEdge) {
            this.emitEvent(EventKind.PIPELINE_FAILED, {
              reason: "Stage failed with no outgoing fail edge",
              nodeId: currentNode.id,
            });
            return {
              outcome: createOutcome({
                status: StageStatus.FAIL,
                failureReason: `Stage ${currentNode.id} failed with no outgoing fail edge`,
              }),
              completedNodes,
              context,
              artifactStore,
            };
          }
          // Otherwise follow the unconditional edge (step 6)
        }
      }

      if (!nextEdge) {
        break;
      }

      // Step 7: Handle loop_restart — complete state isolation between restarts
      if (getBooleanAttr(nextEdge.attributes, "loop_restart", false)) {
        restartCount++;

        // Fresh context with graph attributes re-mirrored
        context = new Context();
        mirrorGraphAttributes(graph, context);

        // Clear ALL per-node state for complete isolation
        nodeOutcomes.clear();
        nodeRetries.clear();
        completedNodes.length = 0;

        // Fresh logs subdirectory for this restart
        logsRoot = join(baseLogsRoot, "restart-" + String(restartCount));

        // Advance to target node
        const restartTarget = graph.nodes.get(nextEdge.to);
        if (!restartTarget) {
          this.emitEvent(EventKind.PIPELINE_FAILED, {
            reason: `loop_restart target node not found: ${nextEdge.to}`,
            nodeId: currentNode.id,
          });
          return {
            outcome: createOutcome({
              status: StageStatus.FAIL,
              failureReason: `loop_restart target node not found: ${nextEdge.to}`,
            }),
            completedNodes,
            context,
            artifactStore,
          };
        }
        previousNodeId = "";
        currentIncomingEdge = undefined;
        currentNode = restartTarget;

        this.emitEvent(EventKind.PIPELINE_RESTARTED, {
          restartCount,
          targetNode: nextEdge.to,
          logsRoot,
        });

        continue;
      }

      // Step 7.5: Edge delay (cooldown between retries to avoid rate-limit exhaustion)
      const edgeDelayMs = getIntegerAttr(nextEdge.attributes, "delay_ms", 0);
      if (edgeDelayMs > 0) {
        console.log(`[delay] Waiting ${edgeDelayMs}ms before transitioning ${currentNode.id} → ${nextEdge.to}`);
        await new Promise((resolve) => setTimeout(resolve, edgeDelayMs));
      }

      // Step 8: Advance to next node
      const nextNode = graph.nodes.get(nextEdge.to);
      if (!nextNode) {
        this.emitEvent(EventKind.PIPELINE_FAILED, {
          reason: `Edge target node not found: ${nextEdge.to}`,
          nodeId: currentNode.id,
        });
        return {
          outcome: createOutcome({
            status: StageStatus.FAIL,
            failureReason: `Edge target node not found: ${nextEdge.to}`,
          }),
          completedNodes,
          context,
          artifactStore,
        };
      }

      previousNodeId = currentNode.id;
      currentIncomingEdge = nextEdge;
      currentNode = nextNode;
    }

    // Save final checkpoint
    const finalRetries: Record<string, number> = {};
    for (const [nodeId, count] of nodeRetries) {
      finalRetries[nodeId] = count;
    }
    const finalOutcomes: Record<string, string> = {};
    for (const [nodeId, o] of nodeOutcomes) {
      finalOutcomes[nodeId] = o.status;
    }
    await this.saveCheckpointSafe(logsRoot, {
      pipelineId: this.pipelineId,
      timestamp: new Date().toISOString(),
      currentNode: currentNode.id,
      completedNodes: [...completedNodes],
      nodeRetries: finalRetries,
      nodeOutcomes: finalOutcomes,
      contextValues: context.snapshot(),
      logs: [...context.logs()],
    });

    // Resource cleanup (close sessions, release files)
    if (this.config.cleanup) {
      try {
        await this.config.cleanup();
      } catch {
        // cleanup failure is non-fatal
      }
    }

    if (lastOutcome.status === StageStatus.FAIL) {
      this.emitEvent(EventKind.PIPELINE_FAILED, {
        reason: lastOutcome.failureReason || "Pipeline failed",
      });
    } else {
      this.emitEvent(EventKind.PIPELINE_COMPLETED, {
        completedNodes,
        status: lastOutcome.status,
      });
    }

    return { outcome: lastOutcome, completedNodes, context, artifactStore };
  }

  private async writeStatusSafe(path: string, outcome: Outcome): Promise<void> {
    try {
      await mkdir(dirname(path), { recursive: true });
      const content = JSON.stringify(statusFileFromOutcome(outcome), null, 2);
      await writeFile(path, content, "utf-8");
    } catch {
      // Status write failure is non-fatal
    }
  }

  private async saveCheckpointSafe(logsRoot: string, checkpoint: Checkpoint): Promise<void> {
    try {
      await saveCheckpoint(checkpoint, join(logsRoot, "checkpoint.json"));
      this.emitEvent(EventKind.CHECKPOINT_SAVED, {
        nodeId: checkpoint.currentNode,
      });
    } catch {
      // Checkpoint save failure is non-fatal
    }
    // Persist checkpoint to CXDB
    await this.safeCxdb("onCheckpointSave", () =>
      this.config.cxdbStore!.onCheckpointSave(checkpoint),
    );
    if (this.config.onCheckpoint) {
      this.config.onCheckpoint(checkpoint);
    }
  }

  /** Run a CXDB operation non-fatally. Logs errors at debug level. */
  private async safeCxdb(op: string, fn: () => Promise<unknown>): Promise<void> {
    if (!this.config.cxdbStore) return;
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Debug-level: observable but non-fatal
      console.debug(`[cxdb] ${op} failed: ${msg}`);
    }
  }

  private emitEvent<K extends PipelineEventKind>(
    kind: K,
    data: PipelineEventDataMap[K],
  ): void {
    const event = {
      kind,
      timestamp: new Date(),
      pipelineId: this.pipelineId,
      data,
    } satisfies PipelineEvent;
    if (this.config.eventEmitter) {
      this.config.eventEmitter.emit(event);
    }
    if (this.config.onEvent) {
      this.config.onEvent(event);
    }
  }
}
