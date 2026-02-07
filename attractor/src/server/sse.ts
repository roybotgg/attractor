import type { PipelineEvent } from "../types/events.js";

/**
 * Creates an SSE-compatible ReadableStream from an async generator of PipelineEvents.
 */
export function createSSEStream(
  events: AsyncGenerator<PipelineEvent>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await events.next();
      if (done) {
        controller.close();
        return;
      }
      const data = JSON.stringify({
        kind: value.kind,
        timestamp: value.timestamp.toISOString(),
        pipelineId: value.pipelineId,
        data: value.data,
      });
      controller.enqueue(encoder.encode(`data: ${data}\n\n`));
    },
    cancel() {
      events.return(undefined);
    },
  });
}
