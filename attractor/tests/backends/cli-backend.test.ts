import { describe, test, expect } from "bun:test";
import { CliAgentBackend } from "../../src/backends/cli-backend.js";
import { ClaudeCodeBackend } from "../../src/backends/claude-code-backend.js";
import { CodexBackend } from "../../src/backends/codex-backend.js";
import { GeminiBackend } from "../../src/backends/gemini-backend.js";
import { Context } from "../../src/types/context.js";
import { StageStatus } from "../../src/types/outcome.js";
import { stringAttr } from "../../src/types/graph.js";
import type { Node } from "../../src/types/graph.js";
import type { BackendRunOptions } from "../../src/types/handler.js";

/** Concrete test subclass that uses a configurable shell command */
class TestCliBackend extends CliAgentBackend {
  protected buildArgs(
    _prompt: string,
    _node: Node,
    _options?: BackendRunOptions,
  ): string[] {
    return [...(this.config.defaultArgs ?? [])];
  }
}

/** Concrete test subclass that exposes buildArgs for testing */
class TestClaudeCodeBackend extends ClaudeCodeBackend {
  getArgs(prompt: string, node: Node, options?: BackendRunOptions): string[] {
    return this.buildArgs(prompt, node, options);
  }
}

function makeNode(id: string, attrs: Record<string, string> = {}): Node {
  const attributes = new Map(
    Object.entries(attrs).map(([k, v]) => [k, stringAttr(v)]),
  );
  return { id, attributes };
}

describe("CliAgentBackend", () => {
  test("collects stdout from successful subprocess", async () => {
    const backend = new TestCliBackend({ command: "cat" });
    const result = await backend.run(
      makeNode("test"),
      "hello world",
      new Context(),
    );
    expect(result).toBe("hello world");
  });

  test("returns FAIL outcome when command exits non-zero", async () => {
    const backend = new TestCliBackend({
      command: "bash",
      defaultArgs: ["-c", "exit 1"],
    });
    const result = await backend.run(
      makeNode("test"),
      "prompt",
      new Context(),
    );
    expect(typeof result).toBe("object");
    if (typeof result === "object") {
      expect(result.status).toBe(StageStatus.FAIL);
      expect(result.failureReason).toContain("exited with code 1");
    }
  });

  test("returns FAIL outcome when command not found", async () => {
    const backend = new TestCliBackend({
      command: "nonexistent-binary-12345",
    });
    const result = await backend.run(
      makeNode("test"),
      "prompt",
      new Context(),
    );
    expect(typeof result).toBe("object");
    if (typeof result === "object") {
      expect(result.status).toBe(StageStatus.FAIL);
      expect(result.failureReason).toContain("spawn error");
    }
  });

  test("returns FAIL outcome on timeout", async () => {
    const backend = new TestCliBackend({
      command: "sleep",
      defaultArgs: ["10"],
      timeoutMs: 100,
    });
    const result = await backend.run(
      makeNode("test"),
      "",
      new Context(),
    );
    expect(typeof result).toBe("object");
    if (typeof result === "object") {
      expect(result.status).toBe(StageStatus.FAIL);
      expect(result.failureReason).toContain("timed out");
    }
  });

  test("includes stderr in failure message", async () => {
    const backend = new TestCliBackend({
      command: "bash",
      defaultArgs: ["-c", "echo oops >&2; exit 1"],
    });
    const result = await backend.run(
      makeNode("test"),
      "",
      new Context(),
    );
    expect(typeof result).toBe("object");
    if (typeof result === "object") {
      expect(result.failureReason).toContain("oops");
    }
  });
});

describe("ClaudeCodeBackend", () => {
  test("includes --print in default args", () => {
    const backend = new TestClaudeCodeBackend({ command: "echo" });
    const args = backend.getArgs("prompt", makeNode("test"));
    expect(args).toContain("--print");
  });

  test("includes --model flag when llm_model attribute is set", () => {
    const backend = new TestClaudeCodeBackend({ command: "echo" });
    const args = backend.getArgs("prompt", makeNode("test", { llm_model: "opus" }));
    expect(args).toContain("--model");
    expect(args).toContain("opus");
  });
});

describe("CodexBackend", () => {
  test("is instantiable with defaults", () => {
    const backend = new CodexBackend();
    expect(backend).toBeDefined();
  });
});

describe("GeminiBackend", () => {
  test("is instantiable with defaults", () => {
    const backend = new GeminiBackend();
    expect(backend).toBeDefined();
  });
});
