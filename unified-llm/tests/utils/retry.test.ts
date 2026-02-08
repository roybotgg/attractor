import { describe, test, expect } from "bun:test";
import { retry, computeDelay } from "../../src/utils/retry.js";
import type { RetryPolicy } from "../../src/utils/retry.js";
import { SDKError, ServerError, InvalidRequestError, ProviderError } from "../../src/types/errors.js";

describe("retry", () => {
  const fastPolicy: RetryPolicy = {
    maxRetries: 3,
    baseDelay: 0.001,
    maxDelay: 0.01,
    backoffMultiplier: 2.0,
    jitter: false,
  };

  test("returns result on first success", async () => {
    const result = await retry(() => Promise.resolve("ok"), fastPolicy);
    expect(result).toBe("ok");
  });

  test("retries on retryable errors and succeeds", async () => {
    let attempts = 0;
    const result = await retry(async () => {
      attempts++;
      if (attempts < 3) {
        throw new ServerError("server error", "test");
      }
      return "recovered";
    }, fastPolicy);
    expect(result).toBe("recovered");
    expect(attempts).toBe(3);
  });

  test("throws after max retries exhausted", async () => {
    let attempts = 0;
    await expect(
      retry(async () => {
        attempts++;
        throw new ServerError("server error", "test");
      }, fastPolicy),
    ).rejects.toThrow("server error");
    expect(attempts).toBe(4); // initial + 3 retries
  });

  test("does not retry non-retryable errors", async () => {
    let attempts = 0;
    await expect(
      retry(async () => {
        attempts++;
        throw new InvalidRequestError("bad request", "test");
      }, fastPolicy),
    ).rejects.toThrow("bad request");
    expect(attempts).toBe(1);
  });

  test("calls onRetry callback", async () => {
    const retryAttempts: number[] = [];
    let attempts = 0;
    const policyWithCallback: RetryPolicy = {
      ...fastPolicy,
      maxRetries: 2,
      onRetry: (_error, attempt, _delay) => {
        retryAttempts.push(attempt);
      },
    };

    await retry(async () => {
      attempts++;
      if (attempts < 3) {
        throw new SDKError("retryable", true);
      }
      return "done";
    }, policyWithCallback);

    expect(retryAttempts).toEqual([1, 2]);
  });

  test("does not retry non-Error throws", async () => {
    await expect(
      retry(async () => {
        throw "string error";
      }, fastPolicy),
    ).rejects.toBe("string error");
  });

  test("throws immediately when retryAfter exceeds maxDelay", async () => {
    let attempts = 0;
    const error = new ProviderError("rate limited", "test", {
      retryable: true,
      statusCode: 429,
      retryAfter: 999,
    });
    await expect(
      retry(async () => {
        attempts++;
        throw error;
      }, { ...fastPolicy, maxDelay: 60 }),
    ).rejects.toThrow("rate limited");
    expect(attempts).toBe(1);
  });
});

describe("computeDelay", () => {
  const policy: RetryPolicy = {
    maxRetries: 3,
    baseDelay: 1.0,
    maxDelay: 60.0,
    backoffMultiplier: 2.0,
    jitter: false,
  };

  test("returns retryAfter when within maxDelay", () => {
    expect(computeDelay(0, policy, 5)).toBe(5);
  });

  test("returns -1 when retryAfter exceeds maxDelay", () => {
    expect(computeDelay(0, policy, 100)).toBe(-1);
  });

  test("computes exponential backoff without jitter", () => {
    expect(computeDelay(0, policy)).toBe(1.0);
    expect(computeDelay(1, policy)).toBe(2.0);
    expect(computeDelay(2, policy)).toBe(4.0);
  });

  test("caps delay at maxDelay", () => {
    expect(computeDelay(10, policy)).toBe(60.0);
  });

  test("applies jitter in range [0.5, 1.5) of base delay", () => {
    const jitterPolicy: RetryPolicy = { ...policy, jitter: true };
    const results: number[] = [];
    // Run multiple times to verify range
    const baseDelay = 1.0; // attempt 0, backoff = 1.0
    let allInRange = true;
    let count = 0;
    while (count < 100) {
      const delay = computeDelay(0, jitterPolicy);
      results.push(delay);
      if (delay < baseDelay * 0.5 || delay >= baseDelay * 1.5) {
        allInRange = false;
      }
      count++;
    }
    expect(allInRange).toBe(true);
    // Verify we get some spread (not all the same value)
    const unique = new Set(results.map((r) => Math.round(r * 100)));
    expect(unique.size).toBeGreaterThan(1);
  });
});
