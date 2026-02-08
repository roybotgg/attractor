import type { Outcome } from "../types/outcome.js";
import type { Context } from "../types/context.js";

/**
 * Resolve a condition key to its string value.
 *
 * - "outcome" -> outcome.status
 * - "preferred_label" -> outcome.preferredLabel
 * - "context.foo" -> context.get("context.foo"), falling back to context.get("foo")
 * - bare key -> context.get(key)
 * - missing keys return ""
 */
export function resolveKey(
  key: string,
  outcome: Outcome,
  context: Context,
): string {
  if (key === "outcome") {
    return outcome.status;
  }
  if (key === "preferred_label") {
    return outcome.preferredLabel;
  }
  if (key.startsWith("context.")) {
    const fullValue = context.getString(key);
    if (fullValue !== "") {
      return fullValue;
    }
    const stripped = key.slice("context.".length);
    return context.getString(stripped);
  }
  return context.getString(key);
}

/**
 * Evaluate a single clause: "key op literal" or bare key for truthiness.
 */
export function evaluateClause(
  clause: string,
  outcome: Outcome,
  context: Context,
): boolean {
  const trimmed = clause.trim();
  if (trimmed === "") {
    return true;
  }

  // Check != before = since "!=" contains "="
  const neqIndex = trimmed.indexOf("!=");
  if (neqIndex !== -1) {
    const key = trimmed.slice(0, neqIndex).trim();
    const value = parseLiteral(trimmed.slice(neqIndex + 2));
    return resolveKey(key, outcome, context) !== value;
  }

  const eqIndex = trimmed.indexOf("=");
  if (eqIndex !== -1) {
    const key = trimmed.slice(0, eqIndex).trim();
    const value = parseLiteral(trimmed.slice(eqIndex + 1));
    return resolveKey(key, outcome, context) === value;
  }

  // Bare key: truthy check (non-empty string)
  const resolved = resolveKey(trimmed, outcome, context);
  return resolved !== "";
}

/**
 * Evaluate a full condition expression (clauses joined by &&).
 * Empty conditions always return true.
 */
export function evaluateCondition(
  condition: string,
  outcome: Outcome,
  context: Context,
): boolean {
  if (condition.trim() === "") {
    return true;
  }

  const clauses = condition.split("&&");
  return clauses.every((clause) => evaluateClause(clause, outcome, context));
}

function parseLiteral(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    trimmed.startsWith("\"") &&
    trimmed.endsWith("\"")
  ) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") {
        return parsed;
      }
    } catch {
      // Fall through to unquoted form.
    }
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
