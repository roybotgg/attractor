import { describe, test, expect } from "bun:test";
import { OpenAICompatibleAdapter } from "../../../src/providers/openai-compatible/adapter.js";
import {
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  ContextLengthError,
  ContentFilterError,
  QuotaExceededError,
  InvalidRequestError,
  RequestTimeoutError,
} from "../../../src/types/errors.js";

describe("OpenAICompatibleAdapter", () => {
  test("extracts Retry-After header on 429 rate limit", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({ error: { message: "Rate limited" } }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "30",
            },
          },
        );
      },
    });

    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://localhost:${server.port}`,
      });

      let caught: unknown;
      try {
        await adapter.complete({
          model: "test-model",
          messages: [],
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RateLimitError);
      expect((caught as RateLimitError).retryAfter).toBe(30);
    } finally {
      server.stop(true);
    }
  });

  test("extracts Retry-After HTTP-date header on 429 rate limit", async () => {
    const retryAt = new Date(Date.now() + 45_000).toUTCString();
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({ error: { message: "Rate limited" } }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": retryAt,
            },
          },
        );
      },
    });

    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://localhost:${server.port}`,
      });

      let caught: unknown;
      try {
        await adapter.complete({
          model: "test-model",
          messages: [],
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RateLimitError);
      const retryAfter = (caught as RateLimitError).retryAfter;
      expect(retryAfter).toBeDefined();
      expect(retryAfter).toBeGreaterThan(0);
    } finally {
      server.stop(true);
    }
  });

  test("maps 408 to RequestTimeoutError", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({ error: { message: "Request timeout" } }),
          { status: 408, headers: { "content-type": "application/json" } },
        );
      },
    });

    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://localhost:${server.port}`,
      });

      let caught: unknown;
      try {
        await adapter.complete({ model: "test-model", messages: [] });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RequestTimeoutError);
      const error = caught as RequestTimeoutError;
      expect(error.retryable).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("maps 413 to ContextLengthError", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({ error: { message: "Request too large" } }),
          { status: 413, headers: { "content-type": "application/json" } },
        );
      },
    });

    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://localhost:${server.port}`,
      });

      let caught: unknown;
      try {
        await adapter.complete({ model: "test-model", messages: [] });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ContextLengthError);
    } finally {
      server.stop(true);
    }
  });

  test("sets errorCode from response error code", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({ error: { code: "invalid_api_key", message: "Bad key" } }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      },
    });

    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://localhost:${server.port}`,
        apiKey: "test-key",
      });

      let caught: unknown;
      try {
        await adapter.complete({ model: "test-model", messages: [] });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AuthenticationError);
      expect((caught as AuthenticationError).errorCode).toBe("invalid_api_key");
    } finally {
      server.stop(true);
    }
  });

  test("maps content filter message to ContentFilterError", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({ error: { message: "Content policy violation" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      },
    });

    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://localhost:${server.port}`,
      });

      let caught: unknown;
      try {
        await adapter.complete({ model: "test-model", messages: [] });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ContentFilterError);
    } finally {
      server.stop(true);
    }
  });

  test("maps quota message to QuotaExceededError", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({ error: { message: "Billing quota exceeded" } }),
          { status: 402, headers: { "content-type": "application/json" } },
        );
      },
    });

    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://localhost:${server.port}`,
      });

      let caught: unknown;
      try {
        await adapter.complete({ model: "test-model", messages: [] });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(QuotaExceededError);
    } finally {
      server.stop(true);
    }
  });

  test("maps not_found message in fallback to NotFoundError", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({ error: { message: "Model does not exist" } }),
          { status: 418, headers: { "content-type": "application/json" } },
        );
      },
    });

    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://localhost:${server.port}`,
      });

      let caught: unknown;
      try {
        await adapter.complete({ model: "test-model", messages: [] });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(NotFoundError);
    } finally {
      server.stop(true);
    }
  });

  test("maps auth message in fallback to AuthenticationError", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({ error: { message: "Invalid API key provided" } }),
          { status: 418, headers: { "content-type": "application/json" } },
        );
      },
    });

    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://localhost:${server.port}`,
      });

      let caught: unknown;
      try {
        await adapter.complete({ model: "test-model", messages: [] });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AuthenticationError);
    } finally {
      server.stop(true);
    }
  });

  test("maps 422 to InvalidRequestError", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({ error: { message: "Unprocessable" } }),
          { status: 422, headers: { "content-type": "application/json" } },
        );
      },
    });

    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://localhost:${server.port}`,
      });

      let caught: unknown;
      try {
        await adapter.complete({ model: "test-model", messages: [] });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(InvalidRequestError);
    } finally {
      server.stop(true);
    }
  });

  test("supportsNativeJsonSchema defaults to false", () => {
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: "http://localhost:9999",
    });
    expect(adapter.supportsNativeJsonSchema).toBe(false);
  });

  test("supportsNativeJsonSchema can be set to true", () => {
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: "http://localhost:9999",
      supportsNativeJsonSchema: true,
    });
    expect(adapter.supportsNativeJsonSchema).toBe(true);
  });

  test("request.timeout overrides adapter timeout", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            model: "test-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Hello" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://localhost:${server.port}`,
        timeout: { request: 1, streamRead: 1 },
      });

      // Using a longer request timeout should allow the request to succeed
      const response = await adapter.complete({
        model: "test-model",
        messages: [],
        timeout: { request: 5000, streamRead: 5000 },
      });

      expect(response.provider).toBe("openai-compatible");
    } finally {
      server.stop(true);
    }
  });
});
