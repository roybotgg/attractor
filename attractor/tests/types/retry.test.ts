import { describe, expect, test } from "bun:test";
import { delayForAttempt, PRESET_POLICIES } from "../../src/types/retry.js";
import type { BackoffConfig } from "../../src/types/retry.js";

describe("PRESET_POLICIES (spec 3.6)", () => {
  test("none: maxAttempts=1, no retries", () => {
    const p = PRESET_POLICIES["none"]!;
    expect(p.maxAttempts).toBe(1);
    expect(p.backoff.initialDelayMs).toBe(0);
    expect(p.backoff.jitter).toBe(false);
    expect(p.shouldRetry(new Error("anything"))).toBe(false);
  });

  test("standard: maxAttempts=5, initial=200ms, factor=2.0", () => {
    const p = PRESET_POLICIES["standard"]!;
    expect(p.maxAttempts).toBe(5);
    expect(p.backoff.initialDelayMs).toBe(200);
    expect(p.backoff.backoffFactor).toBe(2.0);
    expect(p.backoff.maxDelayMs).toBe(60000);
    expect(p.backoff.jitter).toBe(true);
  });

  test("aggressive: maxAttempts=5, initial=500ms, factor=2.0", () => {
    const p = PRESET_POLICIES["aggressive"]!;
    expect(p.maxAttempts).toBe(5);
    expect(p.backoff.initialDelayMs).toBe(500);
    expect(p.backoff.backoffFactor).toBe(2.0);
    expect(p.backoff.maxDelayMs).toBe(60000);
    expect(p.backoff.jitter).toBe(true);
  });

  test("linear: maxAttempts=3, initial=500ms, factor=1.0", () => {
    const p = PRESET_POLICIES["linear"]!;
    expect(p.maxAttempts).toBe(3);
    expect(p.backoff.initialDelayMs).toBe(500);
    expect(p.backoff.backoffFactor).toBe(1.0);
    expect(p.backoff.maxDelayMs).toBe(60000);
    expect(p.backoff.jitter).toBe(true);
  });

  test("patient: maxAttempts=3, initial=2000ms, factor=3.0", () => {
    const p = PRESET_POLICIES["patient"]!;
    expect(p.maxAttempts).toBe(3);
    expect(p.backoff.initialDelayMs).toBe(2000);
    expect(p.backoff.backoffFactor).toBe(3.0);
    expect(p.backoff.maxDelayMs).toBe(60000);
    expect(p.backoff.jitter).toBe(true);
  });

  test("exactly 5 preset policies defined", () => {
    expect(Object.keys(PRESET_POLICIES)).toEqual([
      "none",
      "standard",
      "aggressive",
      "linear",
      "patient",
    ]);
  });
});

describe("delayForAttempt (spec 3.6)", () => {
  const noJitter: BackoffConfig = {
    initialDelayMs: 200,
    backoffFactor: 2.0,
    maxDelayMs: 60000,
    jitter: false,
  };

  test("first attempt uses initialDelayMs", () => {
    expect(delayForAttempt(1, noJitter)).toBe(200);
  });

  test("exponential backoff: delay = initial * factor^(attempt-1)", () => {
    expect(delayForAttempt(2, noJitter)).toBe(400);
    expect(delayForAttempt(3, noJitter)).toBe(800);
    expect(delayForAttempt(4, noJitter)).toBe(1600);
    expect(delayForAttempt(5, noJitter)).toBe(3200);
  });

  test("delay is capped at maxDelayMs", () => {
    const config: BackoffConfig = {
      initialDelayMs: 200,
      backoffFactor: 2.0,
      maxDelayMs: 1000,
      jitter: false,
    };
    // attempt 4: 200 * 2^3 = 1600, capped at 1000
    expect(delayForAttempt(4, config)).toBe(1000);
  });

  test("linear backoff with factor=1.0 gives constant delay", () => {
    const config: BackoffConfig = {
      initialDelayMs: 500,
      backoffFactor: 1.0,
      maxDelayMs: 60000,
      jitter: false,
    };
    expect(delayForAttempt(1, config)).toBe(500);
    expect(delayForAttempt(2, config)).toBe(500);
    expect(delayForAttempt(3, config)).toBe(500);
  });

  test("jitter scales delay to [0.5x, 1.5x) range", () => {
    const config: BackoffConfig = {
      initialDelayMs: 1000,
      backoffFactor: 1.0,
      maxDelayMs: 60000,
      jitter: true,
    };
    const delays = Array.from({ length: 100 }, () => delayForAttempt(1, config));
    const min = Math.min(...delays);
    const max = Math.max(...delays);
    // All values should be in [500, 1500) (spec: delay * uniform(0.5, 1.5))
    expect(min).toBeGreaterThanOrEqual(500);
    expect(max).toBeLessThan(1500);
    // Should not all be the same (randomness)
    expect(new Set(delays).size).toBeGreaterThan(1);
  });

  test("returns integer (Math.floor applied)", () => {
    const config: BackoffConfig = {
      initialDelayMs: 333,
      backoffFactor: 1.5,
      maxDelayMs: 60000,
      jitter: false,
    };
    // 333 * 1.5 = 499.5 -> floor = 499
    expect(delayForAttempt(2, config)).toBe(499);
    expect(Number.isInteger(delayForAttempt(2, config))).toBe(true);
  });
});
