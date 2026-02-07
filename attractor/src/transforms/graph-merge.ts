import type { Graph, Node, Edge } from "../types/graph.js";
import type { Transform } from "../types/transform.js";

export class GraphMergeTransform implements Transform {
  private readonly sourceGraphs: Graph[];

  constructor(sourceGraphs: Graph[]) {
    this.sourceGraphs = sourceGraphs;
  }

  apply(targetGraph: Graph): Graph {
    const mergedNodes = new Map(targetGraph.nodes);
    const mergedEdges = [...targetGraph.edges];

    for (const source of this.sourceGraphs) {
      const prefix = source.name;

      for (const [_id, node] of source.nodes) {
        const prefixedId = `${prefix}.${node.id}`;
        const prefixedNode: Node = {
          id: prefixedId,
          attributes: new Map(node.attributes),
        };
        mergedNodes.set(prefixedId, prefixedNode);
      }

      for (const edge of source.edges) {
        const prefixedEdge: Edge = {
          from: `${prefix}.${edge.from}`,
          to: `${prefix}.${edge.to}`,
          attributes: new Map(edge.attributes),
        };
        mergedEdges.push(prefixedEdge);
      }
    }

    return {
      name: targetGraph.name,
      attributes: targetGraph.attributes,
      nodes: mergedNodes,
      edges: mergedEdges,
    };
  }
}
