import { describe, it, expect } from "bun:test";
import { WaitForHumanHandler } from "../../src/handlers/wait-human.js";
import { StageStatus } from "../../src/types/outcome.js";
import { Context } from "../../src/types/context.js";
import { stringAttr } from "../../src/types/graph.js";
import { AnswerValue, createAnswer } from "../../src/types/interviewer.js";
import { PipelineEventKind } from "../../src/types/events.js";
import type { PipelineEvent } from "../../src/types/events.js";
import type { EventEmitter } from "../../src/engine/runner.js";
import type { Node, Graph, Edge, AttributeValue } from "../../src/types/graph.js";
import type { Interviewer, Question, Answer } from "../../src/types/interviewer.js";

function makeNode(id: string, attrs: Record<string, string> = {}): Node {
  const attributes = new Map<string, AttributeValue>();
  for (const [k, v] of Object.entries(attrs)) {
    attributes.set(k, stringAttr(v));
  }
  return { id, attributes };
}

function makeGraph(edges: Edge[]): Graph {
  return { name: "test", attributes: new Map(), nodes: new Map(), edges, subgraphs: [] };
}

function makeEdge(from: string, to: string, label?: string): Edge {
  const attributes = new Map<string, AttributeValue>();
  if (label) {
    attributes.set("label", stringAttr(label));
  }
  return { from, to, attributes };
}

class StubEventEmitter implements EventEmitter {
  readonly events: PipelineEvent[] = [];
  emit(event: PipelineEvent): void {
    this.events.push(event);
  }
}

class QueueInterviewer implements Interviewer {
  private answers: Answer[];
  private index = 0;
  readonly askedQuestions: Question[] = [];

  constructor(answers: Answer[]) {
    this.answers = answers;
  }

  async ask(question: Question): Promise<Answer> {
    this.askedQuestions.push(question);
    const answer = this.answers[this.index];
    this.index++;
    if (!answer) {
      return createAnswer({ value: AnswerValue.SKIPPED });
    }
    return answer;
  }

  async askMultiple(questions: Question[]): Promise<Answer[]> {
    const answers: Answer[] = [];
    for (const q of questions) {
      answers.push(await this.ask(q));
    }
    return answers;
  }

  async inform(_message: string, _stage: string): Promise<void> {
    // no-op
  }
}

describe("WaitForHumanHandler", () => {
  it("derives choices from outgoing edges", async () => {
    const interviewer = new QueueInterviewer([
      createAnswer({ value: "Y", selectedOption: { key: "Y", label: "[Y] Yes, deploy" } }),
    ]);
    const handler = new WaitForHumanHandler(interviewer);
    const node = makeNode("gate", { label: "Deploy?" });
    const edges = [
      makeEdge("gate", "deploy", "[Y] Yes, deploy"),
      makeEdge("gate", "cancel", "[N] No, cancel"),
    ];
    const graph = makeGraph(edges);

    const outcome = await handler.execute(node, new Context(), graph, "/tmp");
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.suggestedNextIds).toEqual(["deploy"]);
  });

  it("presents options from edge labels", async () => {
    const interviewer = new QueueInterviewer([
      createAnswer({ value: "A", selectedOption: { key: "A", label: "A) Approve" } }),
    ]);
    const handler = new WaitForHumanHandler(interviewer);
    const node = makeNode("gate", { label: "Review" });
    const edges = [
      makeEdge("gate", "approved", "A) Approve"),
      makeEdge("gate", "rejected", "R) Reject"),
    ];

    await handler.execute(node, new Context(), makeGraph(edges), "/tmp");
    const question = interviewer.askedQuestions[0];
    expect(question).toBeDefined();
    expect(question?.options.length).toBe(2);
    expect(question?.options[0]?.key).toBe("A");
    expect(question?.options[1]?.key).toBe("R");
  });

  it("uses edge target as label fallback", async () => {
    const interviewer = new QueueInterviewer([
      createAnswer({ value: "n", text: "next_step" }),
    ]);
    const handler = new WaitForHumanHandler(interviewer);
    const node = makeNode("gate");
    const edges = [makeEdge("gate", "next_step")];

    const outcome = await handler.execute(node, new Context(), makeGraph(edges), "/tmp");
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.suggestedNextIds).toEqual(["next_step"]);
  });

  it("handles accelerator keys", async () => {
    const interviewer = new QueueInterviewer([
      createAnswer({ value: "Y", selectedOption: { key: "Y", label: "[Y] Yes" } }),
    ]);
    const handler = new WaitForHumanHandler(interviewer);
    const node = makeNode("gate", { label: "Continue?" });
    const edges = [
      makeEdge("gate", "yes_node", "[Y] Yes"),
      makeEdge("gate", "no_node", "[N] No"),
    ];

    const outcome = await handler.execute(node, new Context(), makeGraph(edges), "/tmp");
    expect(outcome.contextUpdates["human.gate.selected"]).toBe("Y");
    expect(outcome.contextUpdates["human.gate.label"]).toBe("[Y] Yes");
  });

  it("fails when no outgoing edges", async () => {
    const interviewer = new QueueInterviewer([]);
    const handler = new WaitForHumanHandler(interviewer);
    const node = makeNode("gate");

    const outcome = await handler.execute(node, new Context(), makeGraph([]), "/tmp");
    expect(outcome.status).toBe(StageStatus.FAIL);
    expect(outcome.failureReason).toContain("No outgoing edges");
  });

  it("returns RETRY on timeout with no default", async () => {
    const interviewer = new QueueInterviewer([
      createAnswer({ value: AnswerValue.TIMEOUT }),
    ]);
    const handler = new WaitForHumanHandler(interviewer);
    const node = makeNode("gate", { label: "Choose" });
    const edges = [makeEdge("gate", "next", "Go")];

    const outcome = await handler.execute(node, new Context(), makeGraph(edges), "/tmp");
    expect(outcome.status).toBe(StageStatus.RETRY);
    expect(outcome.failureReason).toContain("timeout");
  });

  it("uses default choice on timeout", async () => {
    const interviewer = new QueueInterviewer([
      createAnswer({ value: AnswerValue.TIMEOUT }),
    ]);
    const handler = new WaitForHumanHandler(interviewer);
    const node = makeNode("gate", {
      label: "Choose",
      "human.default_choice": "Y",
    });
    const edges = [
      makeEdge("gate", "yes_node", "[Y] Yes"),
      makeEdge("gate", "no_node", "[N] No"),
    ];

    const outcome = await handler.execute(node, new Context(), makeGraph(edges), "/tmp");
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.suggestedNextIds).toEqual(["yes_node"]);
  });

  it("uses default choice on timeout when configured as target node ID", async () => {
    const interviewer = new QueueInterviewer([
      createAnswer({ value: AnswerValue.TIMEOUT }),
    ]);
    const handler = new WaitForHumanHandler(interviewer);
    const node = makeNode("gate", {
      label: "Choose",
      "human.default_choice": "yes_node",
    });
    const edges = [
      makeEdge("gate", "yes_node", "[Y] Yes"),
      makeEdge("gate", "no_node", "[N] No"),
    ];

    const outcome = await handler.execute(node, new Context(), makeGraph(edges), "/tmp");
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.suggestedNextIds).toEqual(["yes_node"]);
  });

  it("fails on skipped interaction", async () => {
    const interviewer = new QueueInterviewer([
      createAnswer({ value: AnswerValue.SKIPPED }),
    ]);
    const handler = new WaitForHumanHandler(interviewer);
    const node = makeNode("gate", { label: "Choose" });
    const edges = [makeEdge("gate", "next", "Go")];

    const outcome = await handler.execute(node, new Context(), makeGraph(edges), "/tmp");
    expect(outcome.status).toBe(StageStatus.FAIL);
    expect(outcome.failureReason).toContain("skipped");
  });

  it("emits INTERVIEW_STARTED and INTERVIEW_COMPLETED on success", async () => {
    const emitter = new StubEventEmitter();
    const interviewer = new QueueInterviewer([
      createAnswer({ value: "Y", selectedOption: { key: "Y", label: "[Y] Yes" } }),
    ]);
    const handler = new WaitForHumanHandler(interviewer, emitter, "pipe-1");
    const node = makeNode("gate", { label: "Deploy?" });
    const edges = [
      makeEdge("gate", "deploy", "[Y] Yes"),
      makeEdge("gate", "cancel", "[N] No"),
    ];

    await handler.execute(node, new Context(), makeGraph(edges), "/tmp");

    expect(emitter.events.length).toBe(2);
    expect(emitter.events[0]?.kind).toBe(PipelineEventKind.INTERVIEW_STARTED);
    expect(emitter.events[0]?.pipelineId).toBe("pipe-1");
    expect(emitter.events[0]?.data).toMatchObject({ question: "Deploy?", stage: "gate" });
    expect(emitter.events[1]?.kind).toBe(PipelineEventKind.INTERVIEW_COMPLETED);
    expect(emitter.events[1]?.data).toMatchObject({ question: "Deploy?", answer: "Y" });
  });

  it("emits INTERVIEW_TIMEOUT on timeout", async () => {
    const emitter = new StubEventEmitter();
    const interviewer = new QueueInterviewer([
      createAnswer({ value: AnswerValue.TIMEOUT }),
    ]);
    const handler = new WaitForHumanHandler(interviewer, emitter, "pipe-2");
    const node = makeNode("gate", { label: "Choose" });
    const edges = [makeEdge("gate", "next", "Go")];

    await handler.execute(node, new Context(), makeGraph(edges), "/tmp");

    expect(emitter.events[0]?.kind).toBe(PipelineEventKind.INTERVIEW_STARTED);
    expect(emitter.events[1]?.kind).toBe(PipelineEventKind.INTERVIEW_COMPLETED);
    expect(emitter.events[2]?.kind).toBe(PipelineEventKind.INTERVIEW_TIMEOUT);
    expect(emitter.events[2]?.data).toMatchObject({ question: "Choose", stage: "gate" });
  });

  it("does not fail when no emitter is provided", async () => {
    const interviewer = new QueueInterviewer([
      createAnswer({ value: "Y", selectedOption: { key: "Y", label: "[Y] Yes" } }),
    ]);
    const handler = new WaitForHumanHandler(interviewer);
    const node = makeNode("gate", { label: "Deploy?" });
    const edges = [makeEdge("gate", "deploy", "[Y] Yes")];

    const outcome = await handler.execute(node, new Context(), makeGraph(edges), "/tmp");
    expect(outcome.status).toBe(StageStatus.SUCCESS);
  });
});
