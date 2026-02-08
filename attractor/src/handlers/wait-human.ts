import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Handler } from "../types/handler.js";
import type { Node, Graph } from "../types/graph.js";
import type { Context } from "../types/context.js";
import type { Outcome } from "../types/outcome.js";
import type { Interviewer, Option, Answer } from "../types/interviewer.js";
import type { EventEmitter } from "../engine/runner.js";
import type { PipelineEventKind, PipelineEventDataMap } from "../types/events.js";
import { getStringAttr, outgoingEdges } from "../types/graph.js";
import { StageStatus, createOutcome } from "../types/outcome.js";
import { QuestionType, AnswerValue, createQuestion } from "../types/interviewer.js";
import { PipelineEventKind as EventKind } from "../types/events.js";
import { parseAcceleratorKey, normalizeLabel } from "../utils/label.js";
import { statusFileFromOutcome } from "../utils/status-file.js";

interface Choice {
  key: string;
  label: string;
  to: string;
}

function findMatchingChoice(answer: Answer, choices: readonly Choice[]): Choice | undefined {
  // Match by selected option key
  if (answer.selectedOption) {
    const found = choices.find(
      (c) => normalizeLabel(c.key) === normalizeLabel(answer.selectedOption?.key ?? ""),
    );
    if (found) return found;
  }

  // Match by answer value against choice key or label
  const normalized = normalizeLabel(answer.value);
  const found = choices.find(
    (c) => normalizeLabel(c.key) === normalized || normalizeLabel(c.label) === normalized,
  );
  if (found) return found;

  return undefined;
}

export class WaitForHumanHandler implements Handler {
  private readonly interviewer: Interviewer;
  private readonly emitter: EventEmitter | undefined;
  private readonly pipelineId: string;

  constructor(interviewer: Interviewer, emitter?: EventEmitter, pipelineId?: string) {
    this.interviewer = interviewer;
    this.emitter = emitter;
    this.pipelineId = pipelineId ?? "";
  }

  private emitEvent<K extends PipelineEventKind>(kind: K, data: PipelineEventDataMap[K]): void {
    if (!this.emitter) return;
    this.emitter.emit({
      kind,
      timestamp: new Date(),
      pipelineId: this.pipelineId,
      data,
    });
  }

  async execute(node: Node, _context: Context, graph: Graph, logsRoot: string): Promise<Outcome> {
    // 1. Derive choices from outgoing edges
    const edges = outgoingEdges(graph, node.id);
    const choices: Choice[] = edges.map((edge) => {
      const label = getStringAttr(edge.attributes, "label") || edge.to;
      const key = parseAcceleratorKey(label);
      return { key, label, to: edge.to };
    });

    if (choices.length === 0) {
      return createOutcome({
        status: StageStatus.FAIL,
        failureReason: "No outgoing edges for human gate",
      });
    }

    // 2. Build question
    const options: Option[] = choices.map((c) => ({ key: c.key, label: c.label }));
    const questionText = getStringAttr(node.attributes, "label") || "Select an option:";
    const question = createQuestion({
      text: questionText,
      type: QuestionType.MULTIPLE_CHOICE,
      options,
      stage: node.id,
    });

    // 3. Present to interviewer
    this.emitEvent(EventKind.INTERVIEW_STARTED, { question: questionText, stage: node.id });
    const answer = await this.interviewer.ask(question);
    this.emitEvent(EventKind.INTERVIEW_COMPLETED, { question: questionText, answer: answer.value });

    // 4. Handle timeout
    if (answer.value === AnswerValue.TIMEOUT) {
      this.emitEvent(EventKind.INTERVIEW_TIMEOUT, { question: questionText, stage: node.id });
      const defaultChoice = getStringAttr(node.attributes, "human.default_choice");
      if (defaultChoice) {
        const defaultNormalized = normalizeLabel(defaultChoice);
        const found = choices.find(
          (c) =>
            normalizeLabel(c.key) === defaultNormalized ||
            normalizeLabel(c.label) === defaultNormalized ||
            normalizeLabel(c.to) === defaultNormalized,
        );
        if (found) {
          return createOutcome({
            status: StageStatus.SUCCESS,
            suggestedNextIds: [found.to],
            contextUpdates: {
              "human.gate.selected": found.key,
              "human.gate.label": found.label,
            },
          });
        }
      }
      return createOutcome({
        status: StageStatus.RETRY,
        failureReason: "human gate timeout, no default",
      });
    }

    // Handle skipped
    if (answer.value === AnswerValue.SKIPPED) {
      return createOutcome({
        status: StageStatus.FAIL,
        failureReason: "human skipped interaction",
      });
    }

    // 5. Find matching choice
    const selected = findMatchingChoice(answer, choices) ?? choices[0];
    if (!selected) {
      return createOutcome({
        status: StageStatus.FAIL,
        failureReason: "No choices available",
      });
    }

    // 6. Write status.json and return with suggested next
    const stageDir = join(logsRoot, node.id);
    mkdirSync(stageDir, { recursive: true });
    const outcome = createOutcome({
      status: StageStatus.SUCCESS,
      suggestedNextIds: [selected.to],
      contextUpdates: {
        "human.gate.selected": selected.key,
        "human.gate.label": selected.label,
      },
    });
    await Bun.write(
      join(stageDir, "status.json"),
      JSON.stringify(statusFileFromOutcome(outcome), null, 2),
    );
    return outcome;
  }
}
