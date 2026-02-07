import { describe, it, expect } from "bun:test";
import { ParallelHandler } from "../../src/handlers/parallel.js";
import type { NodeExecutor } from "../../src/handlers/parallel.js";
import { StageStatus, createOutcome } from "../../src/types/outcome.js";
import { Context } from "../../src/types/context.js";
import { stringAttr, integerAttr, floatAttr } from "../../src/types/graph.js";
import type { Node, Graph, Edge, AttributeValue } from "../../src/types/graph.js";

function makeNode(id: string): Node {
  return { id, attributes: new Map() };
}

function makeEdge(from: string, to: string): Edge {
  return { from, to, attributes: new Map<string, AttributeValue>() };
}

function makeGraph(edges: Edge[]): Graph {
  return { name: "test", attributes: new Map(), nodes: new Map(), edges };
}

describe("ParallelHandler", () => {
  it("returns SUCCESS when all branches succeed", async () => {
    const executor: NodeExecutor = async () =>
      createOutcome({ status: StageStatus.SUCCESS });

    const handler = new ParallelHandler(executor);
    const node = makeNode("parallel");
    const edges = [makeEdge("parallel", "a"), makeEdge("parallel", "b")];
    const context = new Context();

    const outcome = await handler.execute(node, context, makeGraph(edges), "/tmp");
    expect(outcome.status).toBe(StageStatus.SUCCESS);
  });

  it("returns PARTIAL_SUCCESS when some branches fail", async () => {
    let callCount = 0;
    const executor: NodeExecutor = async () => {
      callCount++;
      if (callCount === 1) {
        return createOutcome({ status: StageStatus.SUCCESS });
      }
      return createOutcome({ status: StageStatus.FAIL, failureReason: "error" });
    };

    const handler = new ParallelHandler(executor);
    const node = makeNode("parallel");
    const edges = [makeEdge("parallel", "a"), makeEdge("parallel", "b")];
    const context = new Context();

    const outcome = await handler.execute(node, context, makeGraph(edges), "/tmp");
    expect(outcome.status).toBe(StageStatus.PARTIAL_SUCCESS);
  });

  it("stores results in context for fan-in", async () => {
    const executor: NodeExecutor = async (nodeId) =>
      createOutcome({ status: StageStatus.SUCCESS, notes: "done: " + nodeId });

    const handler = new ParallelHandler(executor);
    const node = makeNode("parallel");
    const edges = [makeEdge("parallel", "a"), makeEdge("parallel", "b")];
    const context = new Context();

    await handler.execute(node, context, makeGraph(edges), "/tmp");
    const raw = context.get("parallel.results");
    expect(raw).not.toBe("");
    const results = JSON.parse(raw);
    expect(results.length).toBe(2);
    expect(results[0].nodeId).toBe("a");
    expect(results[1].nodeId).toBe("b");
  });

  it("clones context for each branch", async () => {
    const contexts: Context[] = [];
    const executor: NodeExecutor = async (_nodeId, ctx) => {
      contexts.push(ctx);
      return createOutcome({ status: StageStatus.SUCCESS });
    };

    const handler = new ParallelHandler(executor);
    const node = makeNode("parallel");
    const edges = [makeEdge("parallel", "a"), makeEdge("parallel", "b")];
    const parentContext = new Context();
    parentContext.set("shared", "value");

    await handler.execute(node, parentContext, makeGraph(edges), "/tmp");
    // Each branch context should be a distinct clone
    expect(contexts.length).toBe(2);
    expect(contexts[0]).not.toBe(parentContext);
    expect(contexts[1]).not.toBe(parentContext);
    expect(contexts[0]).not.toBe(contexts[1]);
    // But share same values
    expect(contexts[0]?.get("shared")).toBe("value");
    expect(contexts[1]?.get("shared")).toBe("value");
  });

  it("fails when no outgoing edges", async () => {
    const executor: NodeExecutor = async () =>
      createOutcome({ status: StageStatus.SUCCESS });

    const handler = new ParallelHandler(executor);
    const node = makeNode("parallel");
    const context = new Context();

    const outcome = await handler.execute(node, context, makeGraph([]), "/tmp");
    expect(outcome.status).toBe(StageStatus.FAIL);
  });
});

function makeNodeWithAttrs(id: string, attrs: Map<string, AttributeValue>): Node {
  return { id, attributes: attrs };
}

describe("ParallelHandler advanced policies", () => {
  it("wait_all default: all pass returns SUCCESS", async () => {
    const executor: NodeExecutor = async () =>
      createOutcome({ status: StageStatus.SUCCESS });

    const handler = new ParallelHandler(executor);
    const node = makeNode("p");
    const edges = [makeEdge("p", "a"), makeEdge("p", "b"), makeEdge("p", "c")];
    const context = new Context();

    const outcome = await handler.execute(node, context, makeGraph(edges), "/tmp");
    expect(outcome.status).toBe(StageStatus.SUCCESS);
  });

  it("wait_all default: some fail returns PARTIAL_SUCCESS", async () => {
    const outcomes = new Map<string, StageStatus>([
      ["a", StageStatus.SUCCESS],
      ["b", StageStatus.FAIL],
      ["c", StageStatus.SUCCESS],
    ]);
    const executor: NodeExecutor = async (nodeId) =>
      createOutcome({ status: outcomes.get(nodeId) ?? StageStatus.FAIL });

    const handler = new ParallelHandler(executor);
    const node = makeNode("p");
    const edges = [makeEdge("p", "a"), makeEdge("p", "b"), makeEdge("p", "c")];
    const context = new Context();

    const outcome = await handler.execute(node, context, makeGraph(edges), "/tmp");
    expect(outcome.status).toBe(StageStatus.PARTIAL_SUCCESS);
  });

  it("k_of_n: K successes met returns SUCCESS", async () => {
    const outcomes = new Map<string, StageStatus>([
      ["a", StageStatus.SUCCESS],
      ["b", StageStatus.FAIL],
      ["c", StageStatus.SUCCESS],
    ]);
    const executor: NodeExecutor = async (nodeId) =>
      createOutcome({ status: outcomes.get(nodeId) ?? StageStatus.FAIL });

    const handler = new ParallelHandler(executor);
    const attrs = new Map<string, AttributeValue>([
      ["join_policy", stringAttr("k_of_n")],
      ["join_k", integerAttr(2)],
    ]);
    const node = makeNodeWithAttrs("p", attrs);
    const edges = [makeEdge("p", "a"), makeEdge("p", "b"), makeEdge("p", "c")];
    const context = new Context();

    const outcome = await handler.execute(node, context, makeGraph(edges), "/tmp");
    expect(outcome.status).toBe(StageStatus.SUCCESS);
  });

  it("k_of_n: impossible to reach K returns FAIL", async () => {
    const executor: NodeExecutor = async () =>
      createOutcome({ status: StageStatus.FAIL, failureReason: "nope" });

    const handler = new ParallelHandler(executor);
    const attrs = new Map<string, AttributeValue>([
      ["join_policy", stringAttr("k_of_n")],
      ["join_k", integerAttr(3)],
    ]);
    const node = makeNodeWithAttrs("p", attrs);
    const edges = [makeEdge("p", "a"), makeEdge("p", "b"), makeEdge("p", "c")];
    const context = new Context();

    const outcome = await handler.execute(node, context, makeGraph(edges), "/tmp");
    expect(outcome.status).toBe(StageStatus.FAIL);
  });

  it("first_success: one succeeds returns SUCCESS", async () => {
    const outcomes = new Map<string, StageStatus>([
      ["a", StageStatus.FAIL],
      ["b", StageStatus.SUCCESS],
      ["c", StageStatus.FAIL],
    ]);
    const executor: NodeExecutor = async (nodeId) =>
      createOutcome({ status: outcomes.get(nodeId) ?? StageStatus.FAIL });

    const handler = new ParallelHandler(executor);
    const attrs = new Map<string, AttributeValue>([
      ["join_policy", stringAttr("first_success")],
    ]);
    const node = makeNodeWithAttrs("p", attrs);
    const edges = [makeEdge("p", "a"), makeEdge("p", "b"), makeEdge("p", "c")];
    const context = new Context();

    const outcome = await handler.execute(node, context, makeGraph(edges), "/tmp");
    expect(outcome.status).toBe(StageStatus.SUCCESS);
  });

  it("quorum: majority met returns SUCCESS", async () => {
    const outcomes = new Map<string, StageStatus>([
      ["a", StageStatus.SUCCESS],
      ["b", StageStatus.FAIL],
      ["c", StageStatus.SUCCESS],
      ["d", StageStatus.FAIL],
    ]);
    const executor: NodeExecutor = async (nodeId) =>
      createOutcome({ status: outcomes.get(nodeId) ?? StageStatus.FAIL });

    const handler = new ParallelHandler(executor);
    // quorum with 0.5 fraction => ceil(0.5 * 4) = 2 successes needed
    const attrs = new Map<string, AttributeValue>([
      ["join_policy", stringAttr("quorum")],
      ["join_k", floatAttr(0.5)],
    ]);
    const node = makeNodeWithAttrs("p", attrs);
    const edges = [makeEdge("p", "a"), makeEdge("p", "b"), makeEdge("p", "c"), makeEdge("p", "d")];
    const context = new Context();

    const outcome = await handler.execute(node, context, makeGraph(edges), "/tmp");
    expect(outcome.status).toBe(StageStatus.SUCCESS);
  });

  it("fail_fast: stops on first failure", async () => {
    let executedCount = 0;
    const executor: NodeExecutor = async (nodeId) => {
      executedCount++;
      if (nodeId === "a") {
        return createOutcome({ status: StageStatus.FAIL, failureReason: "boom" });
      }
      return createOutcome({ status: StageStatus.SUCCESS });
    };

    const handler = new ParallelHandler(executor);
    const attrs = new Map<string, AttributeValue>([
      ["error_policy", stringAttr("fail_fast")],
      ["max_parallel", integerAttr(1)],
    ]);
    const node = makeNodeWithAttrs("p", attrs);
    const edges = [makeEdge("p", "a"), makeEdge("p", "b"), makeEdge("p", "c")];
    const context = new Context();

    const outcome = await handler.execute(node, context, makeGraph(edges), "/tmp");
    expect(outcome.status).toBe(StageStatus.FAIL);
    // With max_parallel=1 and fail_fast, should stop after first failure
    expect(executedCount).toBe(1);
  });

  it("ignore: all failures still returns SUCCESS", async () => {
    const executor: NodeExecutor = async () =>
      createOutcome({ status: StageStatus.FAIL, failureReason: "error" });

    const handler = new ParallelHandler(executor);
    const attrs = new Map<string, AttributeValue>([
      ["error_policy", stringAttr("ignore")],
    ]);
    const node = makeNodeWithAttrs("p", attrs);
    const edges = [makeEdge("p", "a"), makeEdge("p", "b")];
    const context = new Context();

    const outcome = await handler.execute(node, context, makeGraph(edges), "/tmp");
    expect(outcome.status).toBe(StageStatus.SUCCESS);
  });

  it("bounded parallelism: max_parallel limits concurrent execution", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const executor: NodeExecutor = async () => {
      concurrent++;
      if (concurrent > maxConcurrent) maxConcurrent = concurrent;
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
      return createOutcome({ status: StageStatus.SUCCESS });
    };

    const handler = new ParallelHandler(executor);
    const attrs = new Map<string, AttributeValue>([
      ["max_parallel", integerAttr(2)],
    ]);
    const node = makeNodeWithAttrs("p", attrs);
    const edges = [makeEdge("p", "a"), makeEdge("p", "b"), makeEdge("p", "c"), makeEdge("p", "d")];
    const context = new Context();

    await handler.execute(node, context, makeGraph(edges), "/tmp");
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(maxConcurrent).toBeGreaterThan(0);
  });

  it("serialized results in context contain correct structure", async () => {
    const outcomes = new Map<string, StageStatus>([
      ["a", StageStatus.SUCCESS],
      ["b", StageStatus.FAIL],
    ]);
    const executor: NodeExecutor = async (nodeId) =>
      createOutcome({
        status: outcomes.get(nodeId) ?? StageStatus.FAIL,
        notes: "note-" + nodeId,
        contextUpdates: { key: nodeId },
      });

    const handler = new ParallelHandler(executor);
    const attrs = new Map<string, AttributeValue>([
      ["error_policy", stringAttr("ignore")],
    ]);
    const node = makeNodeWithAttrs("p", attrs);
    const edges = [makeEdge("p", "a"), makeEdge("p", "b")];
    const context = new Context();

    await handler.execute(node, context, makeGraph(edges), "/tmp");
    const raw = context.get("parallel.results");
    const results = JSON.parse(raw) as Array<{ nodeId: string; status: string; notes: string; contextUpdates: Record<string, string> }>;
    expect(results.length).toBe(2);

    const resultA = results.find((r) => r.nodeId === "a");
    const resultB = results.find((r) => r.nodeId === "b");
    expect(resultA?.status).toBe(StageStatus.SUCCESS);
    expect(resultA?.notes).toBe("note-a");
    expect(resultA?.contextUpdates.key).toBe("a");
    expect(resultB?.status).toBe(StageStatus.FAIL);
  });
});
