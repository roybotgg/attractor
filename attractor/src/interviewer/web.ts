import type { Question, Answer, Interviewer } from "../types/interviewer.js";
import { AnswerValue, createAnswer } from "../types/interviewer.js";

interface PendingQuestion {
  question: Question;
  resolve: (answer: Answer) => void;
}

/**
 * A web-based Interviewer that queues questions for HTTP retrieval
 * and accepts answers via HTTP POST.
 */
export class WebInterviewer implements Interviewer {
  private pending: PendingQuestion | undefined;
  private messages: Array<{ message: string; stage: string }> = [];

  ask(question: Question): Promise<Answer> {
    return new Promise<Answer>((resolve) => {
      this.pending = { question, resolve };
    });
  }

  inform(message: string, stage: string): Promise<void> {
    this.messages.push({ message, stage });
    return Promise.resolve();
  }

  /** Returns the currently pending question, if any. */
  getPendingQuestion(): Question | undefined {
    return this.pending?.question;
  }

  /** Submits an answer to the pending question. Returns true if there was one. */
  submitAnswer(answer: Answer): boolean {
    if (!this.pending) return false;
    this.pending.resolve(answer);
    this.pending = undefined;
    return true;
  }

  /** Returns and clears buffered inform messages. */
  drainMessages(): Array<{ message: string; stage: string }> {
    const result = [...this.messages];
    this.messages = [];
    return result;
  }
}
