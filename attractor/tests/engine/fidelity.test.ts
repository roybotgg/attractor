import { describe, expect, test } from "bun:test";
import {
  resolveFidelity,
  resolveThreadId,
  buildPreamble,
} from "../../src/engine/fidelity.js";
import { FidelityMode } from "../../src/types/fidelity.js";
import { Context } from "../../src/types/context.js";
import { createOutcome, StageStatus } from "../../src/types/outcome.js";
import type { Graph, Node, Edge, AttributeValue } from "../../src/types/graph.js";
import { stringAttr } from "../../src/types/graph.js";

function makeNode(
  id: string,
  attrs: Record<string, AttributeValue> = {},
): Node {
  return { id, attributes: new Map(Object.entries(attrs)) };
}

function makeEdge(
  from: string,
  to: string,
  attrs: Record<string, AttributeValue> = {},
): Edge {
  return { from, to, attributes: new Map(Object.entries(attrs)) };
}

function makeGraph(
  nodes: Node[],
  edges: Edge[],
  attrs: Record<string, AttributeValue> = {},
): Graph {
  const nodeMap = new Map<string, Node>();
  for (const n of nodes) nodeMap.set(n.id, n);
  return {
    name: "test",
    attributes: new Map(Object.entries(attrs)),
    nodes: nodeMap,
    edges,
  };
}

describe("resolveFidelity", () => {
  test("edge attr takes precedence over node", () => {
    const node = makeNode("A", { fidelity: stringAttr("truncate") });
    const edge = makeEdge("X", "A", { fidelity: stringAttr("full") });
    const graph = makeGraph([node], [edge]);

    const result = resolveFidelity(node, edge, graph);
    expect(result.mode).toBe(FidelityMode.FULL);
  });

  test("node attr takes precedence over graph", () => {
    const node = makeNode("A", { fidelity: stringAttr("truncate") });
    const graph = makeGraph([node], [], {
      fidelity: stringAttr("summary:low"),
    });

    const result = resolveFidelity(node, undefined, graph);
    expect(result.mode).toBe(FidelityMode.TRUNCATE);
  });

  test("defaults to compact when no fidelity attrs", () => {
    const node = makeNode("A");
    const graph = makeGraph([node], []);

    const result = resolveFidelity(node, undefined, graph);
    expect(result.mode).toBe(FidelityMode.COMPACT);
  });
});

describe("resolveThreadId", () => {
  test("uses edge attr if present in full mode", () => {
    const node = makeNode("A", { fidelity: stringAttr("full") });
    const edge = makeEdge("X", "A", {
      fidelity: stringAttr("full"),
      thread_id: stringAttr("my-thread"),
    });
    const graph = makeGraph([node], [edge]);

    const result = resolveThreadId(node, edge, graph, "X");
    expect(result).toBe("my-thread");
  });

  test("generates default thread id for full mode", () => {
    const node = makeNode("B", { fidelity: stringAttr("full") });
    const graph = makeGraph([node], []);

    const result = resolveThreadId(node, undefined, graph, "A");
    expect(result).toBe("A->B");
  });

  test("returns empty string for non-full modes", () => {
    const node = makeNode("A", { fidelity: stringAttr("compact") });
    const graph = makeGraph([node], []);

    const result = resolveThreadId(node, undefined, graph, "X");
    expect(result).toBe("");
  });
});

describe("buildPreamble", () => {
  test("truncate contains goal and run ID", () => {
    const context = new Context();
    context.set("graph.goal", "Deploy app");
    context.set("run_id", "run-123");

    const result = buildPreamble(
      FidelityMode.TRUNCATE,
      context,
      [],
      new Map(),
      makeGraph([], []),
    );
    expect(result).toContain("Goal: Deploy app");
    expect(result).toContain("Run ID: run-123");
  });

  test("compact lists completed nodes with statuses", () => {
    const context = new Context();
    const outcomes = new Map([
      [
        "build",
        createOutcome({ status: StageStatus.SUCCESS }),
      ],
      [
        "test",
        createOutcome({ status: StageStatus.FAIL, failureReason: "timeout" }),
      ],
    ]);

    const result = buildPreamble(
      FidelityMode.COMPACT,
      context,
      ["build", "test"],
      outcomes,
      makeGraph([], []),
    );
    expect(result).toContain("- build: success");
    expect(result).toContain("- test: fail");
  });

  test("summary:low is brief with event counts", () => {
    const context = new Context();
    context.set("graph.goal", "Ship feature");
    const outcomes = new Map([
      ["step1", createOutcome({ status: StageStatus.SUCCESS })],
      ["step2", createOutcome({ status: StageStatus.SUCCESS })],
      ["step3", createOutcome({ status: StageStatus.FAIL })],
    ]);

    const result = buildPreamble(
      FidelityMode.SUMMARY_LOW,
      context,
      ["step1", "step2", "step3"],
      outcomes,
      makeGraph([], []),
    );
    expect(result).toContain("Goal: Ship feature");
    expect(result).toContain("3");
    expect(result).toContain("2 success");
    expect(result).toContain("1 failed");
  });

  test("summary:medium includes recent outcomes", () => {
    const context = new Context();
    context.set("graph.goal", "Build thing");
    context.set("status", "running");
    const outcomes = new Map([
      [
        "analyze",
        createOutcome({ status: StageStatus.SUCCESS, notes: "Looks good" }),
      ],
    ]);

    const result = buildPreamble(
      FidelityMode.SUMMARY_MEDIUM,
      context,
      ["analyze"],
      outcomes,
      makeGraph([], []),
    );
    expect(result).toContain("Goal: Build thing");
    expect(result).toContain("analyze: success");
    expect(result).toContain("Notes: Looks good");
    expect(result).toContain("status: running");
  });

  test("summary:high detailed with all context", () => {
    const context = new Context();
    context.set("graph.goal", "Comprehensive");
    context.set("_internal", "hidden-in-compact");
    context.appendLog("Did something");
    const outcomes = new Map([
      [
        "deploy",
        createOutcome({
          status: StageStatus.PARTIAL_SUCCESS,
          notes: "Partial rollout",
          failureReason: "Region B down",
          contextUpdates: { region: "A" },
        }),
      ],
    ]);

    const result = buildPreamble(
      FidelityMode.SUMMARY_HIGH,
      context,
      ["deploy"],
      outcomes,
      makeGraph([], []),
    );
    expect(result).toContain("Goal: Comprehensive");
    expect(result).toContain("## deploy");
    expect(result).toContain("Status: partial_success");
    expect(result).toContain("Notes: Partial rollout");
    expect(result).toContain("Failure: Region B down");
    expect(result).toContain("Context updates: region");
    expect(result).toContain("_internal: hidden-in-compact");
    expect(result).toContain("Did something");
  });

  test("full returns empty string", () => {
    const context = new Context();
    context.set("graph.goal", "Something");

    const result = buildPreamble(
      FidelityMode.FULL,
      context,
      ["a", "b"],
      new Map(),
      makeGraph([], []),
    );
    expect(result).toBe("");
  });
});
