import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagerLoopHandler } from "../../src/handlers/manager-loop.js";
import type {
  ChildProcessSpawner,
  ChildProcess,
} from "../../src/handlers/manager-loop.js";
import { StageStatus } from "../../src/types/outcome.js";
import { Context } from "../../src/types/context.js";
import { stringAttr, integerAttr } from "../../src/types/graph.js";
import type { Node, Graph, AttributeValue } from "../../src/types/graph.js";
import type { Checkpoint } from "../../src/types/checkpoint.js";

let tmpDir: string;

function makeNode(
  id: string,
  attrs: Record<string, AttributeValue> = {},
): Node {
  return { id, attributes: new Map(Object.entries(attrs)) };
}

function makeGraph(): Graph {
  return {
    name: "parent",
    attributes: new Map(),
    nodes: new Map(),
    edges: [],
  };
}

function writeCheckpoint(dir: string, checkpoint: Checkpoint): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "checkpoint.json"),
    JSON.stringify(checkpoint),
    "utf-8",
  );
}

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    timestamp: new Date().toISOString(),
    currentNode: "work",
    completedNodes: ["start", "work"],
    nodeRetries: {},
    contextValues: { outcome: "success" },
    logs: [],
    ...overrides,
  };
}

/**
 * Creates a mock spawner that resolves its waitForCompletion after the
 * specified number of poll cycles (observe calls). The checkpoint is
 * written to childLogsRoot before returning.
 */
function createMockSpawner(opts: {
  exitCode?: number;
  checkpoint?: Checkpoint;
  resolveImmediately?: boolean;
}): { spawner: ChildProcessSpawner; calls: Array<{ dotFile: string; logsRoot: string }>; killed: { value: boolean } } {
  const calls: Array<{ dotFile: string; logsRoot: string }> = [];
  const killed = { value: false };

  const spawner: ChildProcessSpawner = (
    dotFile: string,
    logsRoot: string,
  ): ChildProcess => {
    const childLogsRoot = join(logsRoot, "child");
    mkdirSync(childLogsRoot, { recursive: true });
    calls.push({ dotFile, logsRoot });

    // Write checkpoint if provided
    if (opts.checkpoint) {
      writeCheckpoint(childLogsRoot, opts.checkpoint);
    }

    const exitCode = opts.exitCode ?? 0;

    return {
      childLogsRoot,
      waitForCompletion: () => {
        if (opts.resolveImmediately) {
          return Promise.resolve({ exitCode });
        }
        // Never resolve by default (let the loop control flow)
        return new Promise(() => {});
      },
      kill: () => {
        killed.value = true;
      },
    };
  };

  return { spawner, calls, killed };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "manager-loop-test-"));
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true });
  }
});

describe("ManagerLoopHandler", () => {
  it("auto-starts child subprocess", async () => {
    const checkpoint = makeCheckpoint();
    const { spawner, calls } = createMockSpawner({
      exitCode: 0,
      checkpoint,
      resolveImmediately: true,
    });

    const handler = new ManagerLoopHandler({ spawner });
    const node = makeNode("mgr", {
      "stack.child_dotfile": stringAttr("/path/to/child.dot"),
      "manager.max_cycles": integerAttr(2),
      "manager.poll_interval": integerAttr(0),
    });

    await handler.execute(node, new Context(), makeGraph(), tmpDir);

    expect(calls.length).toBe(1);
    const firstCall = calls.at(0);
    expect(firstCall).toBeDefined();
    expect(firstCall?.dotFile).toBe("/path/to/child.dot");
  });

  it("observes child checkpoint data into context", async () => {
    const checkpoint = makeCheckpoint({
      currentNode: "step2",
      completedNodes: ["start", "step1", "step2"],
      contextValues: { outcome: "success", "custom.key": "custom-value" },
    });
    const { spawner } = createMockSpawner({
      exitCode: 0,
      checkpoint,
      resolveImmediately: true,
    });

    const handler = new ManagerLoopHandler({ spawner });
    const node = makeNode("mgr", {
      "stack.child_dotfile": stringAttr("/path/to/child.dot"),
      "manager.max_cycles": integerAttr(2),
      "manager.poll_interval": integerAttr(0),
    });
    const ctx = new Context();

    await handler.execute(node, ctx, makeGraph(), tmpDir);

    expect(ctx.get("stack.child.currentNode")).toBe("step2");
    expect(ctx.get("stack.child.completedNodes")).toBe("start,step1,step2");
    expect(ctx.get("stack.child.context.custom.key")).toBe("custom-value");
  });

  it("returns SUCCESS when child completes successfully", async () => {
    const checkpoint = makeCheckpoint({ contextValues: { outcome: "success" } });
    const { spawner } = createMockSpawner({
      exitCode: 0,
      checkpoint,
      resolveImmediately: true,
    });

    const handler = new ManagerLoopHandler({ spawner });
    const node = makeNode("mgr", {
      "stack.child_dotfile": stringAttr("/path/to/child.dot"),
      "manager.max_cycles": integerAttr(3),
      "manager.poll_interval": integerAttr(0),
    });

    const outcome = await handler.execute(
      node,
      new Context(),
      makeGraph(),
      tmpDir,
    );

    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.notes).toContain("child completed successfully");
  });

  it("returns FAIL when child fails", async () => {
    const checkpoint = makeCheckpoint({
      contextValues: { outcome: "fail" },
    });
    const { spawner } = createMockSpawner({
      checkpoint,
    });

    const handler = new ManagerLoopHandler({ spawner });
    const node = makeNode("mgr", {
      "stack.child_dotfile": stringAttr("/path/to/child.dot"),
      "manager.max_cycles": integerAttr(2),
      "manager.poll_interval": integerAttr(0),
    });

    const outcome = await handler.execute(
      node,
      new Context(),
      makeGraph(),
      tmpDir,
    );

    expect(outcome.status).toBe(StageStatus.FAIL);
    expect(outcome.failureReason).toContain("child pipeline failed");
  });

  it("returns FAIL when max_cycles exceeded", async () => {
    // No checkpoint, child never completes
    const { spawner, killed } = createMockSpawner({});

    const handler = new ManagerLoopHandler({ spawner });
    const node = makeNode("mgr", {
      "stack.child_dotfile": stringAttr("/path/to/child.dot"),
      "manager.max_cycles": integerAttr(3),
      "manager.poll_interval": integerAttr(0),
      "manager.actions": stringAttr("observe"),
    });

    const outcome = await handler.execute(
      node,
      new Context(),
      makeGraph(),
      tmpDir,
    );

    expect(outcome.status).toBe(StageStatus.FAIL);
    expect(outcome.failureReason).toContain("max_cycles (3) exceeded");
    expect(killed.value).toBe(true);
  });

  it("evaluates stop condition and triggers early exit", async () => {
    // Checkpoint sets a context value that the stop condition checks
    const checkpoint = makeCheckpoint({
      contextValues: { outcome: "success", "quality.score": "95" },
    });
    const { spawner, killed } = createMockSpawner({
      checkpoint,
    });

    const handler = new ManagerLoopHandler({ spawner });
    const node = makeNode("mgr", {
      "stack.child_dotfile": stringAttr("/path/to/child.dot"),
      "manager.max_cycles": integerAttr(10),
      "manager.poll_interval": integerAttr(0),
      "manager.stop_condition": stringAttr(
        "stack.child.context.quality.score=95",
      ),
      "manager.actions": stringAttr("observe"),
    });

    const outcome = await handler.execute(
      node,
      new Context(),
      makeGraph(),
      tmpDir,
    );

    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.notes).toContain("stop condition met");
    expect(killed.value).toBe(true);
  });

  it("writes intervention file when steer action is present", async () => {
    const checkpoint = makeCheckpoint({
      contextValues: { outcome: "fail" },
    });
    const { spawner } = createMockSpawner({
      checkpoint,
    });

    const handler = new ManagerLoopHandler({ spawner });
    const node = makeNode("mgr", {
      "stack.child_dotfile": stringAttr("/path/to/child.dot"),
      "manager.max_cycles": integerAttr(2),
      "manager.poll_interval": integerAttr(0),
      "manager.actions": stringAttr("observe,steer"),
    });

    await handler.execute(node, new Context(), makeGraph(), tmpDir);

    const interventionPath = join(tmpDir, "child", "intervention.json");
    expect(existsSync(interventionPath)).toBe(true);

    const intervention = JSON.parse(readFileSync(interventionPath, "utf-8"));
    expect(intervention.source).toBe("mgr");
    expect(intervention.cycle).toBe(1);
  });

  it("uses default poll_interval when not specified", async () => {
    const checkpoint = makeCheckpoint({ contextValues: { outcome: "fail" } });
    const { spawner } = createMockSpawner({
      checkpoint,
    });

    const handler = new ManagerLoopHandler({ spawner });
    // No manager.poll_interval attribute set
    const node = makeNode("mgr", {
      "stack.child_dotfile": stringAttr("/path/to/child.dot"),
      "manager.max_cycles": integerAttr(1),
      "manager.actions": stringAttr("observe"),
    });

    // This should still work -- using the default 45s poll interval
    // Since max_cycles is 1, it will either return from checkpoint check or max_cycles
    const outcome = await handler.execute(
      node,
      new Context(),
      makeGraph(),
      tmpDir,
    );

    // With max_cycles=1 and the fail checkpoint, we get FAIL from checkpoint detection
    expect(outcome.status).toBe(StageStatus.FAIL);
  });
});
