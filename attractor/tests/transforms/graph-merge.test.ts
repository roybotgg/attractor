import { describe, test, expect } from "bun:test";
import { GraphMergeTransform } from "../../src/transforms/graph-merge.js";
import type { Graph, Node, Edge } from "../../src/types/graph.js";
import { stringAttr } from "../../src/types/graph.js";

function makeNode(id: string, attrs: Record<string, string> = {}): Node {
  const attributes = new Map(
    Object.entries(attrs).map(([k, v]) => [k, stringAttr(v)]),
  );
  return { id, attributes };
}

function makeGraph(
  name: string,
  nodes: Node[],
  edges: Edge[] = [],
): Graph {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  return { name, attributes: new Map(), nodes: nodeMap, edges };
}

describe("GraphMergeTransform", () => {
  test("prefixes node IDs with source graph name", () => {
    const source = makeGraph("auth", [
      makeNode("login", { label: "Login" }),
      makeNode("verify", { label: "Verify" }),
    ]);
    const target = makeGraph("main", [makeNode("start")]);

    const transform = new GraphMergeTransform([source]);
    const result = transform.apply(target);

    expect(result.nodes.has("auth.login")).toBe(true);
    expect(result.nodes.has("auth.verify")).toBe(true);
    expect(result.nodes.has("start")).toBe(true);
    expect(result.nodes.get("auth.login")?.id).toBe("auth.login");
  });

  test("prefixes edge from/to with source graph name", () => {
    const source = makeGraph(
      "auth",
      [makeNode("a"), makeNode("b")],
      [{ from: "a", to: "b", attributes: new Map() }],
    );
    const target = makeGraph("main", [], []);

    const transform = new GraphMergeTransform([source]);
    const result = transform.apply(target);

    expect(result.edges.length).toBe(1);
    const edge = result.edges[0];
    expect(edge).toBeDefined();
    expect(edge?.from).toBe("auth.a");
    expect(edge?.to).toBe("auth.b");
  });

  test("merges multiple source graphs without collision", () => {
    const sourceA = makeGraph("alpha", [makeNode("step1")]);
    const sourceB = makeGraph("beta", [makeNode("step1")]);
    const target = makeGraph("main", [makeNode("root")]);

    const transform = new GraphMergeTransform([sourceA, sourceB]);
    const result = transform.apply(target);

    expect(result.nodes.has("alpha.step1")).toBe(true);
    expect(result.nodes.has("beta.step1")).toBe(true);
    expect(result.nodes.has("root")).toBe(true);
    expect(result.nodes.size).toBe(3);
  });
});
