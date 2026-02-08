import type { FidelityMode } from "../types/fidelity.js";
import type { Node, Edge, Graph } from "../types/graph.js";
import type { Context } from "../types/context.js";
import type { Outcome } from "../types/outcome.js";
import { getStringAttr } from "../types/graph.js";
import { FidelityMode as FM, isValidFidelityMode } from "../types/fidelity.js";

export interface FidelityResolution {
  mode: FidelityMode;
  threadId: string;
}

/**
 * Resolve fidelity mode for a node.
 * Precedence: edge attr > node attr > graph attr > default (compact).
 */
export function resolveFidelity(
  node: Node,
  incomingEdge: Edge | undefined,
  graph: Graph,
  prevNodeId: string = "",
): FidelityResolution {
  const mode = resolveMode(node, incomingEdge, graph);
  const threadId = resolveThreadId(node, incomingEdge, graph, prevNodeId);
  return { mode, threadId };
}

function resolveMode(
  node: Node,
  incomingEdge: Edge | undefined,
  graph: Graph,
): FidelityMode {
  if (incomingEdge) {
    const edgeVal = getStringAttr(incomingEdge.attributes, "fidelity");
    if (edgeVal !== "" && isValidFidelityMode(edgeVal)) {
      return edgeVal;
    }
  }

  const nodeVal = getStringAttr(node.attributes, "fidelity");
  if (nodeVal !== "" && isValidFidelityMode(nodeVal)) {
    return nodeVal;
  }

  const graphVal = getStringAttr(graph.attributes, "default_fidelity");
  if (graphVal !== "" && isValidFidelityMode(graphVal)) {
    return graphVal;
  }

  return FM.COMPACT;
}

/**
 * Resolve thread ID for session reuse in full fidelity mode.
 * Precedence: node thread_id > edge thread_id > graph default_thread > node class > prevNodeId.
 * For non-full modes: returns empty string.
 */
export function resolveThreadId(
  node: Node,
  edge: Edge | undefined,
  graph: Graph,
  prevNodeId: string,
): string {
  const mode = resolveMode(node, edge, graph);
  if (mode !== FM.FULL) {
    return "";
  }

  const nodeThreadId = getStringAttr(node.attributes, "thread_id");
  if (nodeThreadId !== "") {
    return nodeThreadId;
  }

  if (edge) {
    const edgeThreadId = getStringAttr(edge.attributes, "thread_id");
    if (edgeThreadId !== "") {
      return edgeThreadId;
    }
  }

  const graphDefault = getStringAttr(graph.attributes, "default_thread");
  if (graphDefault !== "") {
    return graphDefault;
  }

  const nodeClass = getStringAttr(node.attributes, "class");
  if (nodeClass !== "") {
    return nodeClass;
  }

  return prevNodeId;
}

/**
 * Build a context preamble string based on fidelity mode.
 */
export function buildPreamble(
  mode: FidelityMode,
  context: Context,
  completedNodes: string[],
  nodeOutcomes: Map<string, Outcome>,
  graph: Graph,
): string {
  switch (mode) {
    case FM.TRUNCATE:
      return buildTruncatePreamble(context);
    case FM.COMPACT:
      return buildCompactPreamble(context, completedNodes, nodeOutcomes, graph);
    case FM.SUMMARY_LOW:
      return buildSummaryLow(context, completedNodes, nodeOutcomes, graph);
    case FM.SUMMARY_MEDIUM:
      return buildSummaryMedium(context, completedNodes, nodeOutcomes, graph);
    case FM.SUMMARY_HIGH:
      return buildSummaryHigh(context, completedNodes, nodeOutcomes, graph);
    case FM.FULL:
      return "";
  }
}

function buildTruncatePreamble(context: Context): string {
  const goal = context.getString("graph.goal", "");
  const runId = context.getString("run_id", "");
  return `Goal: ${goal}\nRun ID: ${runId}`;
}

function buildCompactPreamble(
  context: Context,
  completedNodes: string[],
  nodeOutcomes: Map<string, Outcome>,
  _graph: Graph,
): string {
  const lines: string[] = [];
  lines.push("# Completed Stages");

  for (const nodeId of completedNodes) {
    const outcome = nodeOutcomes.get(nodeId);
    const status = outcome ? outcome.status : "unknown";
    lines.push(`- ${nodeId}: ${status}`);
  }

  lines.push("");
  lines.push("# Context");
  const snapshot = context.snapshot();
  for (const [key, value] of Object.entries(snapshot)) {
    if (!key.startsWith("_")) {
      lines.push(`- ${key}: ${value}`);
    }
  }

  return lines.join("\n");
}

function buildSummaryLow(
  context: Context,
  completedNodes: string[],
  nodeOutcomes: Map<string, Outcome>,
  _graph: Graph,
): string {
  // ~600 token budget: brief event counts + goal
  const goal = context.getString("graph.goal", "");
  const total = completedNodes.length;
  let successCount = 0;
  let failCount = 0;

  for (const [, outcome] of nodeOutcomes) {
    if (outcome.status === "success") successCount++;
    if (outcome.status === "fail") failCount++;
  }

  const lines: string[] = [];
  lines.push(`Goal: ${goal}`);
  lines.push(`Stages completed: ${total} (${successCount} success, ${failCount} failed)`);
  return lines.join("\n");
}

function buildSummaryMedium(
  context: Context,
  completedNodes: string[],
  nodeOutcomes: Map<string, Outcome>,
  _graph: Graph,
): string {
  // ~1500 token budget: recent outcomes + active context vars
  const lines: string[] = [];
  const goal = context.getString("graph.goal", "");
  lines.push(`Goal: ${goal}`);
  lines.push("");
  lines.push("# Recent Outcomes");

  // Show last 5 completed nodes
  const recentNodes = completedNodes.slice(-5);
  for (const nodeId of recentNodes) {
    const outcome = nodeOutcomes.get(nodeId);
    if (outcome) {
      lines.push(`- ${nodeId}: ${outcome.status}`);
      if (outcome.notes !== "") {
        lines.push(`  Notes: ${outcome.notes}`);
      }
    }
  }

  lines.push("");
  lines.push("# Active Context");
  const snapshot = context.snapshot();
  for (const [key, value] of Object.entries(snapshot)) {
    if (!key.startsWith("_")) {
      lines.push(`- ${key}: ${value}`);
    }
  }

  return lines.join("\n");
}

function buildSummaryHigh(
  context: Context,
  completedNodes: string[],
  nodeOutcomes: Map<string, Outcome>,
  _graph: Graph,
): string {
  // ~3000 token budget: detailed events + all context + notes from outcomes
  const lines: string[] = [];
  const goal = context.getString("graph.goal", "");
  lines.push(`Goal: ${goal}`);
  lines.push("");
  lines.push("# All Completed Stages");

  for (const nodeId of completedNodes) {
    const outcome = nodeOutcomes.get(nodeId);
    if (outcome) {
      lines.push(`## ${nodeId}`);
      lines.push(`Status: ${outcome.status}`);
      if (outcome.notes !== "") {
        lines.push(`Notes: ${outcome.notes}`);
      }
      if (outcome.failureReason !== "") {
        lines.push(`Failure: ${outcome.failureReason}`);
      }
      const updateKeys = Object.keys(outcome.contextUpdates);
      if (updateKeys.length > 0) {
        lines.push(`Context updates: ${updateKeys.join(", ")}`);
      }
    }
  }

  lines.push("");
  lines.push("# Full Context");
  const snapshot = context.snapshot();
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === "_fidelity.preamble") {
      continue;
    }
    lines.push(`- ${key}: ${value}`);
  }

  lines.push("");
  lines.push("# Logs");
  const logs = context.logs();
  for (const entry of logs) {
    lines.push(`- ${entry}`);
  }

  return lines.join("\n");
}
