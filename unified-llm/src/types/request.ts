import type { Message } from "./message.js";
import type { ToolDefinition, ToolChoice } from "./tool.js";
import type { ResponseFormat } from "./response-format.js";
import type { AdapterTimeout } from "./timeout.js";

export interface Request {
  model: string;
  messages: Message[];
  provider?: string;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
  reasoningEffort?: string;
  metadata?: Record<string, string>;
  providerOptions?: Record<string, Record<string, unknown>>;
  timeout?: AdapterTimeout;
  abortSignal?: AbortSignal;
}
