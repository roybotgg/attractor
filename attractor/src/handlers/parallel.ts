import type { Handler } from "../types/handler.js";
import type { Node, Graph, Edge, AttributeValue } from "../types/graph.js";
import type { Context } from "../types/context.js";
import type { Outcome } from "../types/outcome.js";
import { outgoingEdges, getStringAttr, getIntegerAttr } from "../types/graph.js";
import { StageStatus, createOutcome } from "../types/outcome.js";
import { JoinPolicy, ErrorPolicy, parseJoinPolicy, parseErrorPolicy } from "../types/parallel.js";

export type NodeExecutor = (
  nodeId: string,
  context: Context,
  graph: Graph,
  logsRoot: string,
) => Promise<Outcome>;

interface BranchResult {
  nodeId: string;
  outcome: Outcome;
}

function getFloatFromAttrs(attrs: Map<string, AttributeValue>, key: string, defaultValue: number): number {
  const attr = attrs.get(key);
  if (!attr) return defaultValue;
  if (attr.kind === "float") return attr.value;
  if (attr.kind === "integer") return attr.value;
  if (attr.kind === "string") {
    const n = parseFloat(attr.value);
    return isNaN(n) ? defaultValue : n;
  }
  return defaultValue;
}

class Semaphore {
  private running = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    if (this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (next) next();
    } else {
      this.running--;
    }
  }
}

function resolveJoinK(joinPolicy: JoinPolicy, joinK: number, total: number): number {
  if (joinPolicy === JoinPolicy.QUORUM) {
    return Math.ceil(joinK * total);
  }
  return joinK;
}

export class ParallelHandler implements Handler {
  private readonly nodeExecutor: NodeExecutor;

  constructor(nodeExecutor: NodeExecutor) {
    this.nodeExecutor = nodeExecutor;
  }

  async execute(node: Node, context: Context, graph: Graph, logsRoot: string): Promise<Outcome> {
    const branches = outgoingEdges(graph, node.id);

    if (branches.length === 0) {
      return createOutcome({
        status: StageStatus.FAIL,
        failureReason: "No outgoing edges for parallel node",
      });
    }

    const joinPolicy = parseJoinPolicy(getStringAttr(node.attributes, "join_policy", JoinPolicy.WAIT_ALL));
    const errorPolicy = parseErrorPolicy(getStringAttr(node.attributes, "error_policy", ErrorPolicy.CONTINUE));
    const maxParallel = getIntegerAttr(node.attributes, "max_parallel", branches.length);
    const joinK = getFloatFromAttrs(node.attributes, "join_k", 1);
    const requiredSuccesses = resolveJoinK(joinPolicy, joinK, branches.length);

    const semaphore = new Semaphore(maxParallel);
    const results: BranchResult[] = [];
    let aborted = false;
    let successCount = 0;
    let failCount = 0;

    if (joinPolicy === JoinPolicy.FIRST_SUCCESS) {
      return this.executeFirstSuccess(branches, context, graph, logsRoot, semaphore);
    }

    if (joinPolicy === JoinPolicy.K_OF_N || joinPolicy === JoinPolicy.QUORUM) {
      return this.executeKOfN(branches, context, graph, logsRoot, semaphore, requiredSuccesses);
    }

    // wait_all with optional fail_fast / ignore
    const promises = branches.map(async (branch) => {
      if (aborted) {
        results.push({
          nodeId: branch.to,
          outcome: createOutcome({ status: StageStatus.SKIPPED, notes: "Aborted due to fail_fast" }),
        });
        return;
      }

      await semaphore.acquire();
      if (aborted) {
        semaphore.release();
        results.push({
          nodeId: branch.to,
          outcome: createOutcome({ status: StageStatus.SKIPPED, notes: "Aborted due to fail_fast" }),
        });
        return;
      }

      try {
        const branchContext = context.clone();
        const outcome = await this.nodeExecutor(branch.to, branchContext, graph, logsRoot);

        if (outcome.status === StageStatus.FAIL) {
          failCount++;
          if (errorPolicy === ErrorPolicy.FAIL_FAST) {
            aborted = true;
          }
        } else {
          successCount++;
        }

        results.push({ nodeId: branch.to, outcome });
      } finally {
        semaphore.release();
      }
    });

    await Promise.all(promises);

    this.storeResults(results, context);

    if (errorPolicy === ErrorPolicy.IGNORE) {
      return createOutcome({
        status: StageStatus.SUCCESS,
        notes: "All " + String(results.length) + " branches completed (errors ignored)",
      });
    }

    if (failCount === 0) {
      return createOutcome({
        status: StageStatus.SUCCESS,
        notes: "All " + String(successCount) + " branches completed successfully",
      });
    }

    if (errorPolicy === ErrorPolicy.FAIL_FAST) {
      return createOutcome({
        status: StageStatus.FAIL,
        failureReason: "Branch failed with fail_fast policy",
        notes: String(successCount) + " of " + String(branches.length) + " branches succeeded before failure",
      });
    }

    return createOutcome({
      status: StageStatus.PARTIAL_SUCCESS,
      notes: String(successCount) + " of " + String(results.length) + " branches succeeded",
    });
  }

  private async executeFirstSuccess(
    branches: Edge[],
    context: Context,
    graph: Graph,
    logsRoot: string,
    semaphore: Semaphore,
  ): Promise<Outcome> {
    const results: BranchResult[] = [];
    let resolved = false;

    return new Promise<Outcome>((resolve) => {
      let completedCount = 0;

      const tryResolve = () => {
        if (resolved) return;

        const successResult = results.find((r) => r.outcome.status === StageStatus.SUCCESS);
        if (successResult) {
          resolved = true;
          // Mark remaining as cancelled
          const finishedIds = new Set(results.map((r) => r.nodeId));
          branches
            .filter((b) => !finishedIds.has(b.to))
            .forEach((b) => {
              results.push({
                nodeId: b.to,
                outcome: createOutcome({ status: StageStatus.SKIPPED, notes: "Cancelled: first_success resolved" }),
              });
            });
          this.storeResults(results, context);
          resolve(createOutcome({
            status: StageStatus.SUCCESS,
            notes: "First success from branch " + successResult.nodeId,
          }));
          return;
        }

        if (completedCount === branches.length) {
          resolved = true;
          this.storeResults(results, context);
          resolve(createOutcome({
            status: StageStatus.FAIL,
            failureReason: "No branch succeeded",
            notes: "All " + String(branches.length) + " branches failed",
          }));
        }
      };

      branches.forEach((branch) => {
        if (resolved) {
          results.push({
            nodeId: branch.to,
            outcome: createOutcome({ status: StageStatus.SKIPPED, notes: "Cancelled: first_success resolved" }),
          });
          completedCount++;
          tryResolve();
          return;
        }

        const run = async () => {
          await semaphore.acquire();
          if (resolved) {
            semaphore.release();
            results.push({
              nodeId: branch.to,
              outcome: createOutcome({ status: StageStatus.SKIPPED, notes: "Cancelled: first_success resolved" }),
            });
            completedCount++;
            tryResolve();
            return;
          }

          try {
            const branchContext = context.clone();
            const outcome = await this.nodeExecutor(branch.to, branchContext, graph, logsRoot);
            results.push({ nodeId: branch.to, outcome });
          } catch {
            results.push({
              nodeId: branch.to,
              outcome: createOutcome({ status: StageStatus.FAIL, failureReason: "Branch threw" }),
            });
          } finally {
            semaphore.release();
            completedCount++;
            tryResolve();
          }
        };

        void run();
      });
    });
  }

  private async executeKOfN(
    branches: Edge[],
    context: Context,
    graph: Graph,
    logsRoot: string,
    semaphore: Semaphore,
    requiredSuccesses: number,
  ): Promise<Outcome> {
    const results: BranchResult[] = [];
    let resolved = false;
    let successCount = 0;

    return new Promise<Outcome>((resolve) => {
      let completedCount = 0;

      const tryResolve = () => {
        if (resolved) return;

        if (successCount >= requiredSuccesses) {
          resolved = true;
          this.storeResults(results, context);
          resolve(createOutcome({
            status: StageStatus.SUCCESS,
            notes: String(successCount) + " of " + String(branches.length) + " branches succeeded (required: " + String(requiredSuccesses) + ")",
          }));
          return;
        }

        const remaining = branches.length - completedCount;
        if (remaining + successCount < requiredSuccesses) {
          resolved = true;
          this.storeResults(results, context);
          resolve(createOutcome({
            status: StageStatus.FAIL,
            failureReason: "Cannot reach " + String(requiredSuccesses) + " successes: " + String(successCount) + " succeeded, " + String(remaining) + " remaining",
            notes: String(successCount) + " of " + String(branches.length) + " branches succeeded",
          }));
          return;
        }

        if (completedCount === branches.length) {
          resolved = true;
          this.storeResults(results, context);
          // All done but we didn't reach the threshold
          resolve(createOutcome({
            status: StageStatus.FAIL,
            failureReason: "Only " + String(successCount) + " successes, required " + String(requiredSuccesses),
          }));
        }
      };

      branches.forEach((branch) => {
        const run = async () => {
          await semaphore.acquire();
          if (resolved) {
            semaphore.release();
            results.push({
              nodeId: branch.to,
              outcome: createOutcome({ status: StageStatus.SKIPPED, notes: "Cancelled: k_of_n resolved" }),
            });
            completedCount++;
            return;
          }

          try {
            const branchContext = context.clone();
            const outcome = await this.nodeExecutor(branch.to, branchContext, graph, logsRoot);
            results.push({ nodeId: branch.to, outcome });
            if (outcome.status !== StageStatus.FAIL) {
              successCount++;
            }
          } catch {
            results.push({
              nodeId: branch.to,
              outcome: createOutcome({ status: StageStatus.FAIL, failureReason: "Branch threw" }),
            });
          } finally {
            semaphore.release();
            completedCount++;
            tryResolve();
          }
        };

        void run();
      });
    });
  }

  private storeResults(results: BranchResult[], context: Context): void {
    const serialized = results.map((r) => ({
      nodeId: r.nodeId,
      status: r.outcome.status,
      notes: r.outcome.notes,
      contextUpdates: r.outcome.contextUpdates,
    }));
    context.set("parallel.results", JSON.stringify(serialized));
  }
}
