import type { Message } from "../types/message.js";
import { systemMessage, userMessage, toolResultMessage } from "../types/message.js";
import type { StreamEvent } from "../types/stream-event.js";
import { StreamEventType } from "../types/stream-event.js";
import type { Response } from "../types/response.js";
import { responseToolCalls, responseText, responseReasoning } from "../types/response.js";
import type { AdapterTimeout } from "../types/timeout.js";
import type { TimeoutConfig } from "../types/timeout.js";
import { StreamAccumulator } from "../utils/stream-accumulator.js";
import type { Client } from "../client/client.js";
import { getDefaultClient } from "../client/default-client.js";
import { ConfigurationError, RequestTimeoutError, UnsupportedToolChoiceError, InvalidToolCallError } from "../types/errors.js";
import { validateToolName } from "../utils/validate-tool-name.js";
import { validateJsonSchema } from "../utils/validate-json-schema.js";
import { retry } from "../utils/retry.js";
import type { RetryPolicy } from "../utils/retry.js";
import type { GenerateOptions, ToolExecutionContext } from "./generate.js";
import type { StepResult, StreamResult } from "./types.js";

function toAdapterTimeout(timeout: number | TimeoutConfig, remainingMs?: number): AdapterTimeout {
  if (typeof timeout === "number") {
    const requestMs = remainingMs != null ? Math.min(timeout, remainingMs) : timeout;
    return { request: requestMs, streamRead: 30_000 };
  }
  const requestMs = timeout.perStep ?? timeout.total ?? 120_000;
  const clamped = remainingMs != null ? Math.min(requestMs, remainingMs) : requestMs;
  return { request: clamped, streamRead: 30_000 };
}

export type StreamOptions = GenerateOptions;

class StreamResultImpl implements StreamResult {
  private events: StreamEvent[] = [];
  private responsePromise: Promise<Response>;
  private resolveResponse: ((response: Response) => void) | undefined;
  private iterationStarted = false;
  private generatorFn: () => AsyncGenerator<StreamEvent>;
  private accumulator: StreamAccumulator;

  constructor(generatorFn: () => AsyncGenerator<StreamEvent>, provider: string) {
    this.generatorFn = generatorFn;
    this.accumulator = new StreamAccumulator(provider);
    this.responsePromise = new Promise<Response>((resolve) => {
      this.resolveResponse = resolve;
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    if (this.iterationStarted) {
      // Return iterator over cached events
      let index = 0;
      const events = this.events;
      return {
        async next() {
          if (index < events.length) {
            const event = events[index++];
            if (event) {
              return { value: event, done: false };
            }
          }
          return { value: undefined, done: true };
        },
      };
    }
    this.iterationStarted = true;
    const self = this;
    const gen = this.generatorFn();
    const accumulator = this.accumulator;
    return {
      async next() {
        const result = await gen.next();
        if (result.done) {
          const response = accumulator.response();
          self.resolveResponse?.(response);
          return { value: undefined, done: true };
        }
        const event = result.value;
        self.events.push(event);
        accumulator.process(event);
        return { value: event, done: false };
      },
    };
  }

  response(): Promise<Response> {
    if (!this.iterationStarted) {
      // Auto-consume the stream to get the response
      const consume = async () => {
        const iter = this[Symbol.asyncIterator]();
        let result = await iter.next();
        while (!result.done) {
          result = await iter.next();
        }
      };
      consume();
    }
    return this.responsePromise;
  }

  get partialResponse(): Response {
    return this.accumulator.response();
  }

  get textStream(): AsyncGenerator<string> {
    const self = this;
    async function* gen(): AsyncGenerator<string> {
      for await (const event of self) {
        if (event.type === StreamEventType.TEXT_DELTA) {
          yield event.delta;
        }
      }
    }
    return gen();
  }
}

function buildToolCall(tc: { id: string; name: string; arguments: Record<string, unknown> | string }) {
  return {
    id: tc.id,
    name: tc.name,
    arguments: typeof tc.arguments === "string" ? {} : tc.arguments,
    rawArguments: typeof tc.arguments === "string" ? tc.arguments : undefined,
  };
}

export function stream(options: StreamOptions): StreamResult {
  if (options.prompt !== undefined && options.messages !== undefined) {
    throw new ConfigurationError("Cannot specify both 'prompt' and 'messages'");
  }

  const client = options.client ?? getDefaultClient();

  if (options.tools) {
    for (const tool of options.tools) {
      const nameError = validateToolName(tool.name);
      if (nameError) {
        throw new ConfigurationError(`Invalid tool name "${tool.name}": ${nameError}`);
      }
      const params = tool.parameters;
      if (Object.keys(params).length > 0 && params["type"] !== "object") {
        throw new ConfigurationError(
          `Tool "${tool.name}" parameters must have "type": "object" at the root`,
        );
      }
    }
  }

  if (options.toolChoice) {
    const adapter = client.resolveProvider(options.provider);
    if (adapter.supportsToolChoice && !adapter.supportsToolChoice(options.toolChoice.mode)) {
      throw new UnsupportedToolChoiceError(adapter.name, options.toolChoice.mode);
    }
  }

  const maxRetries = options.maxRetries ?? 2;

  const policy: RetryPolicy = options.retryPolicy ?? {
    maxRetries,
    baseDelay: 1.0,
    maxDelay: 60.0,
    backoffMultiplier: 2.0,
    jitter: true,
  };

  const generatorFn = async function* (): AsyncGenerator<StreamEvent> {
    const messages: Message[] = [];
    if (options.system) {
      messages.push(systemMessage(options.system));
    }
    if (options.prompt !== undefined) {
      messages.push(userMessage(options.prompt));
    } else if (options.messages) {
      messages.push(...options.messages);
    }

    const maxToolRounds = options.maxToolRounds ?? 1;
    const steps: StepResult[] = [];

    const timeoutCfg = typeof options.timeout === "number"
      ? { total: options.timeout } : options.timeout;
    const totalMs = timeoutCfg?.total;
    const startTime = totalMs != null ? Date.now() : 0;

    for (let round = 0; round <= maxToolRounds; round++) {
      let remainingMs: number | undefined;
      if (totalMs != null) {
        remainingMs = totalMs - (Date.now() - startTime);
        if (remainingMs <= 0) {
          throw new RequestTimeoutError(
            `Total timeout of ${totalMs}ms exceeded`,
          );
        }
      }
      const request = {
        model: options.model,
        messages: [...messages],
        provider: options.provider,
        tools: options.tools,
        toolChoice: options.toolChoice,
        responseFormat: options.responseFormat,
        temperature: options.temperature,
        topP: options.topP,
        maxTokens: options.maxTokens,
        stopSequences: options.stopSequences,
        reasoningEffort: options.reasoningEffort,
        providerOptions: options.providerOptions,
        timeout: options.timeout !== undefined ? toAdapterTimeout(options.timeout, remainingMs) : undefined,
        abortSignal: options.abortSignal,
      };

      const accumulator = new StreamAccumulator(options.provider);

      // Use retry() to handle initial connection + first event read
      let firstEvent: StreamEvent | undefined;
      let connectedStream: AsyncGenerator<StreamEvent> | undefined;

      const connected = await retry(async () => {
        const iter = client.stream(request);
        const result = await iter.next();
        if (!result.done) {
          return { event: result.value, stream: iter };
        }
        return { event: undefined, stream: iter };
      }, policy);

      firstEvent = connected.event;
      connectedStream = connected.stream;

      // Yield the first event and remaining events
      if (firstEvent) {
        accumulator.process(firstEvent);
        if (firstEvent.type === StreamEventType.FINISH) {
          yield { ...firstEvent, response: accumulator.response() };
        } else {
          yield firstEvent;
        }
      }

      if (connectedStream) {
        for await (const event of connectedStream) {
          accumulator.process(event);
          if (event.type === StreamEventType.FINISH) {
            yield { ...event, response: accumulator.response() };
          } else {
            yield event;
          }
        }
      }

      const response = accumulator.response();
      const rawToolCalls = responseToolCalls(response);
      const hasToolCalls =
        response.finishReason.reason === "tool_calls" &&
        rawToolCalls.length > 0 &&
        options.tools &&
        options.tools.length > 0;

      if (hasToolCalls && round < maxToolRounds) {
        // Emit STEP_FINISH between tool execution rounds
        yield {
          type: StreamEventType.STEP_FINISH,
          finishReason: response.finishReason,
          usage: response.usage,
        };

        // Execute tool calls
        const toolResultPromises = rawToolCalls.map(async (tc) => {
          const toolDef = options.tools?.find((t) => t.name === tc.name);
          if (!toolDef?.execute) {
            return {
              toolCallId: tc.id,
              content: `Tool "${tc.name}" not found or has no execute handler`,
              isError: true,
            };
          }
          try {
            let args = typeof tc.arguments === "string" ? {} : tc.arguments;

            // Validate arguments against tool schema if parameters are defined
            if (toolDef.parameters && Object.keys(toolDef.parameters).length > 0) {
              const validation = validateJsonSchema(args, toolDef.parameters);
              if (!validation.valid) {
                const validationError = new InvalidToolCallError(`Tool argument validation failed: ${validation.errors}`);

                if (options.repairToolCall) {
                  const toolCall = buildToolCall(tc);
                  args = await options.repairToolCall(toolCall, validationError);
                } else {
                  return {
                    toolCallId: tc.id,
                    content: validationError.message,
                    isError: true,
                  };
                }
              }
            }

            const context: ToolExecutionContext = {
              messages,
              abortSignal: options.abortSignal,
              toolCallId: tc.id,
            };
            const result = await toolDef.execute(args, context);
            const content = typeof result === "string" ? result : JSON.stringify(result);
            return { toolCallId: tc.id, content, isError: false };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { toolCallId: tc.id, content: message, isError: true };
          }
        });

        const settled = await Promise.allSettled(toolResultPromises);
        const toolResults = settled.map((result, i) => {
          if (result.status === "fulfilled") {
            return result.value;
          }
          const tc = rawToolCalls[i];
          const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
          return {
            toolCallId: tc?.id ?? "",
            content: message,
            isError: true,
          };
        });

        // Build step result for stopWhen check
        const step: StepResult = {
          text: responseText(response),
          reasoning: responseReasoning(response) || undefined,
          toolCalls: rawToolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: typeof tc.arguments === "string" ? {} : tc.arguments,
            rawArguments: typeof tc.arguments === "string" ? tc.arguments : undefined,
          })),
          toolResults,
          finishReason: response.finishReason,
          usage: response.usage,
          response,
          warnings: response.warnings,
        };
        steps.push(step);

        if (options.stopWhen && options.stopWhen(steps)) {
          yield {
            type: StreamEventType.FINISH,
            finishReason: response.finishReason,
            usage: response.usage,
            response,
          };
          break;
        }

        // Append assistant message and tool results
        messages.push(response.message);
        for (const tr of toolResults) {
          const content = typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content);
          messages.push(toolResultMessage(tr.toolCallId, content, tr.isError));
        }
      } else {
        break;
      }
    }
  };

  return new StreamResultImpl(generatorFn, options.provider ?? "");
}
