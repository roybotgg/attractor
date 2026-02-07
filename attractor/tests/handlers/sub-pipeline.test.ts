import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SubPipelineHandler } from "../../src/handlers/sub-pipeline.js";
import { StartHandler } from "../../src/handlers/start.js";
import { ExitHandler } from "../../src/handlers/exit.js";
import { StageStatus, createOutcome } from "../../src/types/outcome.js";
import { Context } from "../../src/types/context.js";
import { stringAttr } from "../../src/types/graph.js";
import type { Node, Graph } from "../../src/types/graph.js";
import type { Handler } from "../../src/types/handler.js";
import { createHandlerRegistry } from "../../src/engine/runner.js";

const CHILD_DOT = `digraph child {
  start [shape=Mdiamond]
  work [shape=box]
  done [shape=Msquare]
  start -> work
  work -> done
}`;

let tmpDir: string;

function makeNode(id: string, attrs: Record<string, string> = {}): Node {
  const attributes = new Map(
    Object.entries(attrs).map(([k, v]) => [k, stringAttr(v)]),
  );
  return { id, attributes };
}

function makeGraph(): Graph {
  return {
    name: "parent",
    attributes: new Map(),
    nodes: new Map(),
    edges: [],
  };
}

function createStubRegistry(codergenHandler?: Handler) {
  const registry = createHandlerRegistry();
  registry.register("start", new StartHandler());
  registry.register("exit", new ExitHandler());
  if (codergenHandler) {
    registry.register("codergen", codergenHandler);
  } else {
    // Default stub that always succeeds
    registry.defaultHandler = {
      async execute() {
        return createOutcome({ status: StageStatus.SUCCESS, notes: "stub" });
      },
    };
  }
  return registry;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sub-pipeline-test-"));
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true });
  }
});

describe("SubPipelineHandler", () => {
  it("reads DOT file and runs child pipeline to success", async () => {
    const dotFile = join(tmpDir, "child.dot");
    writeFileSync(dotFile, CHILD_DOT);

    const registry = createStubRegistry();
    const handler = new SubPipelineHandler({ handlerRegistry: registry, logsRoot: tmpDir });
    const node = makeNode("sub1", { sub_pipeline: dotFile });
    const outcome = await handler.execute(node, new Context(), makeGraph(), tmpDir);

    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.notes).toContain("child");
  });

  it("maps child FAIL to parent FAIL", async () => {
    const dotFile = join(tmpDir, "child.dot");
    writeFileSync(dotFile, CHILD_DOT);

    const failHandler: Handler = {
      async execute() {
        return createOutcome({ status: StageStatus.FAIL, failureReason: "child failed" });
      },
    };
    const registry = createStubRegistry(failHandler);
    const handler = new SubPipelineHandler({ handlerRegistry: registry, logsRoot: tmpDir });
    const node = makeNode("sub1", { sub_pipeline: dotFile });
    const outcome = await handler.execute(node, new Context(), makeGraph(), tmpDir);

    expect(outcome.status).toBe(StageStatus.FAIL);
  });

  it("stores child results in context", async () => {
    const dotFile = join(tmpDir, "child.dot");
    writeFileSync(dotFile, CHILD_DOT);

    const registry = createStubRegistry();
    const handler = new SubPipelineHandler({ handlerRegistry: registry, logsRoot: tmpDir });
    const node = makeNode("sub1", { sub_pipeline: dotFile });
    const ctx = new Context();
    await handler.execute(node, ctx, makeGraph(), tmpDir);

    expect(ctx.get("sub_pipeline.sub1.status")).toBe(StageStatus.SUCCESS);
    expect(ctx.get("sub_pipeline.sub1.completedNodes")).toContain("start");
  });

  it("fails gracefully when DOT file not found", async () => {
    const registry = createStubRegistry();
    const handler = new SubPipelineHandler({ handlerRegistry: registry, logsRoot: tmpDir });
    const node = makeNode("sub1", { sub_pipeline: join(tmpDir, "nonexistent.dot") });
    const outcome = await handler.execute(node, new Context(), makeGraph(), tmpDir);

    expect(outcome.status).toBe(StageStatus.FAIL);
    expect(outcome.failureReason).toContain("Failed to read DOT file");
  });

  it("reads stack.child_dotfile as fallback attribute", async () => {
    const dotFile = join(tmpDir, "child.dot");
    writeFileSync(dotFile, CHILD_DOT);

    const registry = createStubRegistry();
    const handler = new SubPipelineHandler({ handlerRegistry: registry, logsRoot: tmpDir });
    const node = makeNode("sub1", { "stack.child_dotfile": dotFile });
    const outcome = await handler.execute(node, new Context(), makeGraph(), tmpDir);

    expect(outcome.status).toBe(StageStatus.SUCCESS);
  });
});
