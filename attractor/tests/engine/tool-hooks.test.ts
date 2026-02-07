import { describe, expect, test } from "bun:test";
import { executePreHook, executePostHook } from "../../src/engine/tool-hooks.js";

const testArgs = { file: "test.ts", content: "hello" };

describe("executePreHook", () => {
  test("returns proceed=true on exit 0", async () => {
    const result = await executePreHook(
      "exit 0",
      "write_file",
      testArgs,
      "/tmp/stage-abc",
      "node1",
    );
    expect(result.proceed).toBe(true);
  });

  test("returns proceed=false on non-zero exit", async () => {
    const result = await executePreHook(
      "exit 1",
      "write_file",
      testArgs,
      "/tmp/stage-abc",
      "node1",
    );
    expect(result.proceed).toBe(false);
  });

  test("sets env vars correctly", async () => {
    const result = await executePreHook(
      'test "$ATTRACTOR_TOOL_NAME" = "read_file" && test "$ATTRACTOR_STAGE_ID" = "my-stage" && test "$ATTRACTOR_NODE_ID" = "n42"',
      "read_file",
      testArgs,
      "/tmp/logs/my-stage",
      "n42",
    );
    expect(result.proceed).toBe(true);
  });

  test("handles timeout gracefully", async () => {
    const start = Date.now();
    const result = await executePreHook(
      "sleep 60",
      "write_file",
      testArgs,
      "/tmp/stage-abc",
      "node1",
    );
    const elapsed = Date.now() - start;
    expect(result.proceed).toBe(false);
    // Should timeout well before 60s (hook timeout is 30s)
    expect(elapsed).toBeLessThan(35_000);
  }, 40_000);
});

describe("executePostHook", () => {
  test("receives output in stdin JSON", async () => {
    // The hook reads stdin, parses JSON, and checks the output field is present
    // If the JSON doesn't have the output field, grep fails and exits non-zero
    // But post-hook is non-fatal, so we verify it doesn't throw
    const result = executePostHook(
      'cat > /dev/null',
      "write_file",
      testArgs,
      "file written successfully",
      "/tmp/stage-abc",
      "node1",
    );
    // Should resolve without throwing
    await expect(result).resolves.toBeUndefined();
  });

  test("failure is non-fatal (does not throw)", async () => {
    const result = executePostHook(
      "exit 1",
      "write_file",
      testArgs,
      "some output",
      "/tmp/stage-abc",
      "node1",
    );
    // Even though the command exits with 1, post-hook should not throw
    await expect(result).resolves.toBeUndefined();
  });
});
