import type { Response, Usage, RateLimitInfo } from "../../types/response.js";
import type { Message } from "../../types/message.js";
import type { ContentPart } from "../../types/content-part.js";
import { Role } from "../../types/role.js";
import { str, num, rec, recArray } from "../../utils/extract.js";
import { safeJsonParse } from "../../utils/json.js";

function mapFinishReason(reason: string): Response["finishReason"] {
  switch (reason) {
    case "stop":
      return { reason: "stop", raw: reason };
    case "length":
      return { reason: "length", raw: reason };
    case "tool_calls":
      return { reason: "tool_calls", raw: reason };
    case "content_filter":
      return { reason: "content_filter", raw: reason };
    default:
      return { reason: "other", raw: reason };
  }
}

function translateUsage(
  usageData: Record<string, unknown> | undefined,
): Usage {
  if (!usageData) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  const inputTokens = num(usageData["prompt_tokens"]);
  const outputTokens = num(usageData["completion_tokens"]);
  const totalFromApi = num(usageData["total_tokens"]);

  const result: Usage = {
    inputTokens,
    outputTokens,
    totalTokens: totalFromApi > 0 ? totalFromApi : inputTokens + outputTokens,
    raw: usageData,
  };

  const completionDetails = rec(usageData["completion_tokens_details"]);
  if (
    completionDetails &&
    typeof completionDetails["reasoning_tokens"] === "number"
  ) {
    result.reasoningTokens = completionDetails["reasoning_tokens"];
  }

  const promptDetails = rec(usageData["prompt_tokens_details"]);
  if (promptDetails && typeof promptDetails["cached_tokens"] === "number") {
    result.cacheReadTokens = promptDetails["cached_tokens"];
  }

  return result;
}

export function translateResponse(
  body: Record<string, unknown>,
  rateLimit?: RateLimitInfo,
): Response {
  const choices = recArray(body["choices"]);
  const firstChoice = choices.length > 0 ? choices[0] : undefined;
  const messageData = firstChoice ? rec(firstChoice["message"]) : undefined;

  const contentParts: ContentPart[] = [];

  if (messageData) {
    const contentStr = messageData["content"];
    if (typeof contentStr === "string") {
      contentParts.push({ kind: "text", text: contentStr });
    }

    const toolCalls = recArray(messageData["tool_calls"]);
    for (const tc of toolCalls) {
      const fn = rec(tc["function"]);
      if (!fn) continue;

      const rawArgs =
        typeof fn["arguments"] === "string" ? fn["arguments"] : "{}";
      const parsed = safeJsonParse(rawArgs);
      const parsedRecord = parsed.success ? rec(parsed.value) : undefined;
      const parsedArgs: Record<string, unknown> | string =
        parsedRecord ?? rawArgs;

      contentParts.push({
        kind: "tool_call",
        toolCall: {
          id: str(tc["id"]),
          name: str(fn["name"]),
          arguments: parsedArgs,
        },
      });
    }
  }

  const rawFinishReason = str(firstChoice?.["finish_reason"]);
  const finishReason = mapFinishReason(rawFinishReason);

  const message: Message = {
    role: Role.ASSISTANT,
    content: contentParts,
  };

  const result: Response = {
    id: str(body["id"]),
    model: str(body["model"]),
    provider: "openai-compatible",
    message,
    finishReason,
    usage: translateUsage(rec(body["usage"])),
    raw: body,
    warnings: [],
  };

  if (rateLimit) {
    result.rateLimit = rateLimit;
  }

  return result;
}
