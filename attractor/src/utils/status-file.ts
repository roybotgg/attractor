import type { ContextValue } from "../types/context.js";
import type { Outcome, StageStatus } from "../types/outcome.js";
import { createOutcome, StageStatus as Stage } from "../types/outcome.js";

const STAGE_STATUS_VALUES = new Set<string>(Object.values(Stage));

function asStageStatus(value: unknown): StageStatus | undefined {
  if (typeof value !== "string") return undefined;
  if (!STAGE_STATUS_VALUES.has(value)) return undefined;
  return value as StageStatus;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push(item);
    }
  }
  return out;
}

function asContextUpdates(
  value: unknown,
): Record<string, ContextValue> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, ContextValue>;
}

/**
 * Parse status.json contents using the Appendix C contract, with compatibility
 * fallback for legacy internal Outcome-shaped JSON.
 */
export function parseOutcomeFromStatusFile(
  content: string,
  fallback: Outcome,
): Outcome {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) {
      return fallback;
    }
    const obj = parsed as Record<string, unknown>;

    const status =
      asStageStatus(obj["outcome"]) ??
      asStageStatus(obj["status"]) ??
      fallback.status;

    const preferredLabel =
      asString(obj["preferred_next_label"]) ??
      asString(obj["preferredLabel"]) ??
      fallback.preferredLabel;

    const suggestedNextIds =
      asStringArray(obj["suggested_next_ids"]) ??
      asStringArray(obj["suggestedNextIds"]) ??
      fallback.suggestedNextIds;

    const contextUpdates =
      asContextUpdates(obj["context_updates"]) ??
      asContextUpdates(obj["contextUpdates"]) ??
      fallback.contextUpdates;

    const notes =
      asString(obj["notes"]) ??
      fallback.notes;

    const failureReason =
      asString(obj["failure_reason"]) ??
      asString(obj["failureReason"]) ??
      fallback.failureReason;

    return createOutcome({
      status,
      preferredLabel,
      suggestedNextIds,
      contextUpdates,
      notes,
      failureReason,
    });
  } catch {
    return fallback;
  }
}

/**
 * Serialize an Outcome as status.json using the Appendix C contract.
 * Legacy internal keys are included for backward compatibility.
 */
export function statusFileFromOutcome(
  outcome: Outcome,
): Record<string, unknown> {
  return {
    // Spec contract keys
    outcome: outcome.status,
    preferred_next_label:
      outcome.preferredLabel === "" ? undefined : outcome.preferredLabel,
    suggested_next_ids: outcome.suggestedNextIds,
    context_updates: outcome.contextUpdates,
    notes: outcome.notes,
    failure_reason:
      outcome.failureReason === "" ? undefined : outcome.failureReason,

    // Backward-compatible internal keys
    status: outcome.status,
    preferredLabel: outcome.preferredLabel,
    suggestedNextIds: outcome.suggestedNextIds,
    contextUpdates: outcome.contextUpdates,
    failureReason: outcome.failureReason,
  };
}
