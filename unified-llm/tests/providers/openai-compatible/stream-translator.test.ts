import { describe, test, expect } from "bun:test";
import { translateStream } from "../../../src/providers/openai-compatible/stream-translator.js";
import type { SSEEvent } from "../../../src/utils/sse.js";
import { StreamEventType } from "../../../src/types/stream-event.js";
import type { StreamEvent } from "../../../src/types/stream-event.js";

async function* makeSSEStream(
  events: SSEEvent[],
): AsyncGenerator<SSEEvent> {
  for (const event of events) {
    yield event;
  }
}

async function collectEvents(
  gen: AsyncGenerator<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe("OpenAI-Compatible Stream Translator", () => {
  test("translates text streaming events", async () => {
    const sseEvents: SSEEvent[] = [
      {
        event: "message",
        data: JSON.stringify({
          id: "chatcmpl-001",
          model: "llama-3-70b",
          choices: [
            { index: 0, delta: { role: "assistant", content: "" } },
          ],
        }),
      },
      {
        event: "message",
        data: JSON.stringify({
          id: "chatcmpl-001",
          model: "llama-3-70b",
          choices: [{ index: 0, delta: { content: "Hello" } }],
        }),
      },
      {
        event: "message",
        data: JSON.stringify({
          id: "chatcmpl-001",
          model: "llama-3-70b",
          choices: [{ index: 0, delta: { content: " world" } }],
        }),
      },
      {
        event: "message",
        data: JSON.stringify({
          id: "chatcmpl-001",
          model: "llama-3-70b",
          choices: [
            { index: 0, delta: {}, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
        }),
      },
      { event: "message", data: "[DONE]" },
    ];

    const events = await collectEvents(
      translateStream(makeSSEStream(sseEvents)),
    );

    expect(events[0]?.type).toBe(StreamEventType.STREAM_START);
    expect(events[1]?.type).toBe(StreamEventType.TEXT_START);
    // First chunk has empty content string which emits a delta
    expect(events[2]).toMatchObject({
      type: StreamEventType.TEXT_DELTA,
      delta: "",
    });
    expect(events[3]).toMatchObject({
      type: StreamEventType.TEXT_DELTA,
      delta: "Hello",
    });
    expect(events[4]).toMatchObject({
      type: StreamEventType.TEXT_DELTA,
      delta: " world",
    });
    expect(events[5]?.type).toBe(StreamEventType.TEXT_END);
    expect(events[6]?.type).toBe(StreamEventType.FINISH);
  });

  test("translates tool call streaming events", async () => {
    const sseEvents: SSEEvent[] = [
      {
        event: "message",
        data: JSON.stringify({
          id: "chatcmpl-002",
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: "call_123",
                    type: "function",
                    function: { name: "get_weather", arguments: "" },
                  },
                ],
              },
            },
          ],
        }),
      },
      {
        event: "message",
        data: JSON.stringify({
          id: "chatcmpl-002",
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '{"city":' } },
                ],
              },
            },
          ],
        }),
      },
      {
        event: "message",
        data: JSON.stringify({
          id: "chatcmpl-002",
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '"SF"}' } },
                ],
              },
            },
          ],
        }),
      },
      {
        event: "message",
        data: JSON.stringify({
          id: "chatcmpl-002",
          model: "gpt-4o",
          choices: [
            { index: 0, delta: {}, finish_reason: "tool_calls" },
          ],
        }),
      },
      { event: "message", data: "[DONE]" },
    ];

    const events = await collectEvents(
      translateStream(makeSSEStream(sseEvents)),
    );

    expect(events[0]?.type).toBe(StreamEventType.STREAM_START);
    expect(events[1]).toEqual({
      type: StreamEventType.TOOL_CALL_START,
      toolCallId: "call_123",
      toolName: "get_weather",
    });
    // First chunk has empty arguments delta
    expect(events[2]).toEqual({
      type: StreamEventType.TOOL_CALL_DELTA,
      toolCallId: "call_123",
      argumentsDelta: "",
    });
    expect(events[3]).toEqual({
      type: StreamEventType.TOOL_CALL_DELTA,
      toolCallId: "call_123",
      argumentsDelta: '{"city":',
    });
    expect(events[4]).toEqual({
      type: StreamEventType.TOOL_CALL_DELTA,
      toolCallId: "call_123",
      argumentsDelta: '"SF"}',
    });
    expect(events[5]).toEqual({
      type: StreamEventType.TOOL_CALL_END,
      toolCallId: "call_123",
    });
    expect(events[6]?.type).toBe(StreamEventType.FINISH);
    if (events[6]?.type === StreamEventType.FINISH) {
      expect(events[6].finishReason.reason).toBe("tool_calls");
    }
  });

  test("handles [DONE] sentinel", async () => {
    const sseEvents: SSEEvent[] = [
      {
        event: "message",
        data: JSON.stringify({
          id: "chatcmpl-003",
          model: "llama-3-70b",
          choices: [
            { index: 0, delta: { content: "Hi" }, finish_reason: "stop" },
          ],
        }),
      },
      { event: "message", data: "[DONE]" },
    ];

    const events = await collectEvents(
      translateStream(makeSSEStream(sseEvents)),
    );

    // Should not throw on [DONE]
    const types = events.map((e) => e.type);
    expect(types).toContain(StreamEventType.FINISH);
  });

  test("extracts model and id from first chunk", async () => {
    const sseEvents: SSEEvent[] = [
      {
        event: "message",
        data: JSON.stringify({
          id: "chatcmpl-004",
          model: "llama-3.1-70b-instruct",
          choices: [
            { index: 0, delta: { role: "assistant", content: "" } },
          ],
        }),
      },
    ];

    const events = await collectEvents(
      translateStream(makeSSEStream(sseEvents)),
    );

    const start = events[0];
    if (start?.type === StreamEventType.STREAM_START) {
      expect(start.model).toBe("llama-3.1-70b-instruct");
      expect(start.id).toBe("chatcmpl-004");
    }
  });

  test("finish event maps stop correctly", async () => {
    const sseEvents: SSEEvent[] = [
      {
        event: "message",
        data: JSON.stringify({
          id: "chatcmpl-005",
          model: "llama-3-70b",
          choices: [
            { index: 0, delta: { content: "Done" }, finish_reason: "stop" },
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 5,
            total_tokens: 10,
          },
        }),
      },
      { event: "message", data: "[DONE]" },
    ];

    const events = await collectEvents(
      translateStream(makeSSEStream(sseEvents)),
    );

    const finish = events.find((e) => e.type === StreamEventType.FINISH);
    if (finish?.type === StreamEventType.FINISH) {
      expect(finish.finishReason.reason).toBe("stop");
      expect(finish.usage?.inputTokens).toBe(5);
      expect(finish.usage?.outputTokens).toBe(5);
      expect(finish.usage?.totalTokens).toBe(10);
    }
  });

  test("finish event maps length correctly", async () => {
    const sseEvents: SSEEvent[] = [
      {
        event: "message",
        data: JSON.stringify({
          id: "chatcmpl-006",
          model: "llama-3-70b",
          choices: [
            {
              index: 0,
              delta: { content: "..." },
              finish_reason: "length",
            },
          ],
        }),
      },
      { event: "message", data: "[DONE]" },
    ];

    const events = await collectEvents(
      translateStream(makeSSEStream(sseEvents)),
    );

    const finish = events.find((e) => e.type === StreamEventType.FINISH);
    if (finish?.type === StreamEventType.FINISH) {
      expect(finish.finishReason.reason).toBe("length");
    }
  });

  test("skips invalid JSON data", async () => {
    const sseEvents: SSEEvent[] = [
      { event: "message", data: "not json" },
      {
        event: "message",
        data: JSON.stringify({
          id: "chatcmpl-007",
          model: "llama-3-70b",
          choices: [
            { index: 0, delta: { content: "OK" }, finish_reason: "stop" },
          ],
        }),
      },
      { event: "message", data: "[DONE]" },
    ];

    const events = await collectEvents(
      translateStream(makeSSEStream(sseEvents)),
    );

    // Should still get valid events after skipping bad JSON
    expect(events.length).toBeGreaterThan(0);
    const textDelta = events.find((e) => e.type === StreamEventType.TEXT_DELTA);
    if (textDelta?.type === StreamEventType.TEXT_DELTA) {
      expect(textDelta.delta).toBe("OK");
    }
  });

  test("complete stream lifecycle with text and tool calls", async () => {
    const sseEvents: SSEEvent[] = [
      {
        event: "message",
        data: JSON.stringify({
          id: "chatcmpl-008",
          model: "gpt-4o",
          choices: [
            { index: 0, delta: { role: "assistant", content: "Let me check." } },
          ],
        }),
      },
      {
        event: "message",
        data: JSON.stringify({
          id: "chatcmpl-008",
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              delta: {
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "search", arguments: '{"q":"test"}' },
                  },
                ],
              },
            },
          ],
        }),
      },
      {
        event: "message",
        data: JSON.stringify({
          id: "chatcmpl-008",
          model: "gpt-4o",
          choices: [
            { index: 0, delta: {}, finish_reason: "tool_calls" },
          ],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 40,
            total_tokens: 60,
          },
        }),
      },
      { event: "message", data: "[DONE]" },
    ];

    const events = await collectEvents(
      translateStream(makeSSEStream(sseEvents)),
    );

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      StreamEventType.STREAM_START,
      StreamEventType.TEXT_START,
      StreamEventType.TEXT_DELTA,
      StreamEventType.TEXT_END,
      StreamEventType.TOOL_CALL_START,
      StreamEventType.TOOL_CALL_DELTA,
      StreamEventType.TOOL_CALL_END,
      StreamEventType.FINISH,
    ]);

    const finishEvent = events[events.length - 1];
    if (finishEvent?.type === StreamEventType.FINISH) {
      expect(finishEvent.finishReason.reason).toBe("tool_calls");
      expect(finishEvent.usage?.inputTokens).toBe(20);
      expect(finishEvent.usage?.outputTokens).toBe(40);
      expect(finishEvent.usage?.totalTokens).toBe(60);
    }
  });
});
