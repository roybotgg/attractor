import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CodergenHandler } from "../../src/handlers/codergen.js";
import { StageStatus, createOutcome } from "../../src/types/outcome.js";
import { Context } from "../../src/types/context.js";
import { stringAttr } from "../../src/types/graph.js";
import type { Node, Graph } from "../../src/types/graph.js";
import type { CodergenBackend, BackendRunOptions } from "../../src/types/handler.js";
import { FidelityMode } from "../../src/types/fidelity.js";

const TEST_DIR = join(import.meta.dir, ".tmp-codergen-test");

function makeNode(id: string, attrs: Record<string, string> = {}): Node {
  const attributes = new Map<string, ReturnType<typeof stringAttr>>();
  for (const [k, v] of Object.entries(attrs)) {
    attributes.set(k, stringAttr(v));
  }
  return { id, attributes };
}

function makeGraph(goal: string = ""): Graph {
  const attributes = new Map<string, ReturnType<typeof stringAttr>>();
  if (goal) {
    attributes.set("goal", stringAttr(goal));
  }
  return { name: "test", attributes, nodes: new Map(), edges: [], subgraphs: [] };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

describe("CodergenHandler", () => {
  describe("without backend (simulation)", () => {
    it("returns SUCCESS", async () => {
      const handler = new CodergenHandler();
      const outcome = await handler.execute(
        makeNode("plan"),
        new Context(),
        makeGraph(),
        TEST_DIR,
      );
      expect(outcome.status).toBe(StageStatus.SUCCESS);
    });

    it("writes prompt.md with node label as fallback", async () => {
      const handler = new CodergenHandler();
      await handler.execute(
        makeNode("plan", { label: "Plan the work" }),
        new Context(),
        makeGraph(),
        TEST_DIR,
      );
      const content = readFileSync(join(TEST_DIR, "plan", "prompt.md"), "utf-8");
      expect(content).toBe("Plan the work");
    });

    it("writes simulated response.md", async () => {
      const handler = new CodergenHandler();
      await handler.execute(makeNode("plan"), new Context(), makeGraph(), TEST_DIR);
      const content = readFileSync(join(TEST_DIR, "plan", "response.md"), "utf-8");
      expect(content).toContain("[Simulated]");
      expect(content).toContain("plan");
    });

    it("writes status.json", async () => {
      const handler = new CodergenHandler();
      await handler.execute(makeNode("plan"), new Context(), makeGraph(), TEST_DIR);
      const content = readFileSync(join(TEST_DIR, "plan", "status.json"), "utf-8");
      const status = JSON.parse(content);
      expect(status.outcome).toBe(StageStatus.SUCCESS);
      expect(status.status).toBe(StageStatus.SUCCESS);
    });

    it("sets last_stage and last_response in context updates", async () => {
      const handler = new CodergenHandler();
      const outcome = await handler.execute(
        makeNode("plan"),
        new Context(),
        makeGraph(),
        TEST_DIR,
      );
      expect(outcome.contextUpdates.last_stage).toBe("plan");
      expect(outcome.contextUpdates.last_response).toContain("[Simulated]");
    });

    it("uses node id when no label or prompt", async () => {
      const handler = new CodergenHandler();
      await handler.execute(makeNode("my_stage"), new Context(), makeGraph(), TEST_DIR);
      const content = readFileSync(join(TEST_DIR, "my_stage", "prompt.md"), "utf-8");
      expect(content).toBe("my_stage");
    });
  });

  describe("prompt handling", () => {
    it("does not expand $goal (handled by transform pipeline)", async () => {
      const handler = new CodergenHandler();
      await handler.execute(
        makeNode("plan", { prompt: "Implement: $goal" }),
        new Context(),
        makeGraph("build a calculator"),
        TEST_DIR,
      );
      const content = readFileSync(join(TEST_DIR, "plan", "prompt.md"), "utf-8");
      expect(content).toBe("Implement: $goal");
    });

    it("uses pre-expanded prompt from transform pipeline", async () => {
      const handler = new CodergenHandler();
      await handler.execute(
        makeNode("plan", { prompt: "Implement: build a calculator" }),
        new Context(),
        makeGraph("build a calculator"),
        TEST_DIR,
      );
      const content = readFileSync(join(TEST_DIR, "plan", "prompt.md"), "utf-8");
      expect(content).toBe("Implement: build a calculator");
    });

    it("prepends fidelity preamble for non-full modes", async () => {
      const handler = new CodergenHandler();
      const ctx = new Context();
      ctx.set("_fidelity.mode", FidelityMode.COMPACT);
      ctx.set("_fidelity.preamble", "Preamble line");
      await handler.execute(
        makeNode("plan", { prompt: "Implement the task" }),
        ctx,
        makeGraph(),
        TEST_DIR,
      );
      const content = readFileSync(join(TEST_DIR, "plan", "prompt.md"), "utf-8");
      expect(content).toContain("Preamble line");
      expect(content).toContain("Implement the task");
    });

    it("does not prepend fidelity preamble for full mode", async () => {
      const handler = new CodergenHandler();
      const ctx = new Context();
      ctx.set("_fidelity.mode", FidelityMode.FULL);
      ctx.set("_fidelity.preamble", "Preamble line");
      await handler.execute(
        makeNode("plan", { prompt: "Implement the task" }),
        ctx,
        makeGraph(),
        TEST_DIR,
      );
      const content = readFileSync(join(TEST_DIR, "plan", "prompt.md"), "utf-8");
      expect(content).toBe("Implement the task");
    });
  });

  describe("with stub backend", () => {
    it("returns backend string response", async () => {
      const backend: CodergenBackend = {
        run: async () => "Generated code here",
      };
      const handler = new CodergenHandler(backend);
      const outcome = await handler.execute(
        makeNode("impl"),
        new Context(),
        makeGraph(),
        TEST_DIR,
      );
      expect(outcome.status).toBe(StageStatus.SUCCESS);
      const content = readFileSync(join(TEST_DIR, "impl", "response.md"), "utf-8");
      expect(content).toBe("Generated code here");
    });

    it("returns backend Outcome directly", async () => {
      const customOutcome = createOutcome({
        status: StageStatus.FAIL,
        failureReason: "LLM refused",
      });
      const backend: CodergenBackend = {
        run: async () => customOutcome,
      };
      const handler = new CodergenHandler(backend);
      const outcome = await handler.execute(
        makeNode("impl"),
        new Context(),
        makeGraph(),
        TEST_DIR,
      );
      expect(outcome.status).toBe(StageStatus.FAIL);
      expect(outcome.failureReason).toBe("LLM refused");
    });

    it("handles backend errors gracefully", async () => {
      const backend: CodergenBackend = {
        run: async () => {
          throw new Error("API timeout");
        },
      };
      const handler = new CodergenHandler(backend);
      const outcome = await handler.execute(
        makeNode("impl"),
        new Context(),
        makeGraph(),
        TEST_DIR,
      );
      expect(outcome.status).toBe(StageStatus.FAIL);
      expect(outcome.failureReason).toContain("API timeout");
    });

    it("truncates last_response to 200 chars", async () => {
      const longResponse = "x".repeat(500);
      const backend: CodergenBackend = {
        run: async () => longResponse,
      };
      const handler = new CodergenHandler(backend);
      const outcome = await handler.execute(
        makeNode("impl"),
        new Context(),
        makeGraph(),
        TEST_DIR,
      );
      const lastResponse = String(outcome.contextUpdates.last_response ?? "");
      expect(lastResponse.length).toBe(200);
    });

    it("passes fidelityMode and threadId from context to backend", async () => {
      let capturedOptions: BackendRunOptions | undefined;
      const backend: CodergenBackend = {
        run: async (_node, _prompt, _ctx, options) => {
          capturedOptions = options;
          return "ok";
        },
      };
      const handler = new CodergenHandler(backend);
      const ctx = new Context();
      ctx.set("_fidelity.mode", FidelityMode.FULL);
      ctx.set("_fidelity.threadId", "thread-abc");
      await handler.execute(makeNode("impl"), ctx, makeGraph(), TEST_DIR);
      expect(capturedOptions?.fidelityMode).toBe(FidelityMode.FULL);
      expect(capturedOptions?.threadId).toBe("thread-abc");
    });

    it("omits fidelityMode when context has no fidelity", async () => {
      let capturedOptions: BackendRunOptions | undefined;
      const backend: CodergenBackend = {
        run: async (_node, _prompt, _ctx, options) => {
          capturedOptions = options;
          return "ok";
        },
      };
      const handler = new CodergenHandler(backend);
      await handler.execute(makeNode("impl"), new Context(), makeGraph(), TEST_DIR);
      expect(capturedOptions?.fidelityMode).toBeUndefined();
      expect(capturedOptions?.threadId).toBeUndefined();
    });

    it("omits fidelityMode when context has invalid fidelity string", async () => {
      let capturedOptions: BackendRunOptions | undefined;
      const backend: CodergenBackend = {
        run: async (_node, _prompt, _ctx, options) => {
          capturedOptions = options;
          return "ok";
        },
      };
      const handler = new CodergenHandler(backend);
      const ctx = new Context();
      ctx.set("_fidelity.mode", "invalid-mode");
      await handler.execute(makeNode("impl"), ctx, makeGraph(), TEST_DIR);
      expect(capturedOptions?.fidelityMode).toBeUndefined();
    });
  });
});
