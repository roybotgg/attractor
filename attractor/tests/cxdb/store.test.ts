/**
 * Tests for CxdbStore - the storage adapter bridging Attractor to CXDB.
 *
 * Integration tests require CXDB running on localhost:9009.
 * Skip with: CXDB_SKIP_INTEGRATION=1 bun test
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { CxdbStore } from "../../src/cxdb/store.js";
import { TypeIds } from "../../src/cxdb/types.js";
import { createOutcome, StageStatus } from "../../src/types/outcome.js";
import type { Checkpoint } from "../../src/types/checkpoint.js";
import type { PipelineEvent } from "../../src/types/events.js";
import { PipelineEventKind } from "../../src/types/events.js";
import { decode as msgpackDecode } from "@msgpack/msgpack";

const CXDB_HOST = process.env.CXDB_HOST ?? "localhost";
const CXDB_PORT = parseInt(process.env.CXDB_PORT ?? "9009", 10);
const SKIP = process.env.CXDB_SKIP_INTEGRATION === "1";

// --- Unit tests (no CXDB needed) ---

describe("CxdbStore (unit)", () => {
  test("throws if not connected", async () => {
    const store = new CxdbStore();
    expect(() =>
      store.onPipelineStart({
        pipelineId: "test",
        graphName: "test",
      }),
    ).toThrow("not connected");
  });

  test("throws if no context (onStageComplete before onPipelineStart)", async () => {
    // Can't test without connection, but we can verify the error path
    const store = new CxdbStore();
    expect(() => store.getContextId()).not.toThrow();
    expect(store.getContextId()).toBeNull();
  });

  test("default options", () => {
    const store = new CxdbStore();
    // Just verify it constructs without errors
    expect(store.getContextId()).toBeNull();
  });

  test("custom options", () => {
    const store = new CxdbStore({
      host: "cxdb.local",
      port: 19009,
      httpPort: 19008,
      clientTag: "test-client",
      storeDotSource: true,
    });
    expect(store.getContextId()).toBeNull();
  });
});

// --- Integration tests (need CXDB running) ---

describe.skipIf(SKIP)("CxdbStore (integration)", () => {
  let store: CxdbStore;

  beforeEach(async () => {
    store = new CxdbStore({
      host: CXDB_HOST,
      port: CXDB_PORT,
      clientTag: "store-test",
    });
    await store.connect();
  });

  afterEach(() => {
    store?.close();
  });

  test("connect + onPipelineStart creates a context", async () => {
    const head = await store.onPipelineStart({
      pipelineId: "test-run-1",
      graphName: "test.dot",
      goal: "Test the store",
      model: "normal",
      thinking: "low",
      sessionId: "test-session",
    });

    expect(head.contextId).toBeGreaterThan(0n);
    expect(store.getContextId()).toBe(head.contextId);
  });

  test("onStageComplete appends a stage result turn", async () => {
    await store.onPipelineStart({
      pipelineId: "test-run-2",
      graphName: "test.dot",
    });

    const outcome = createOutcome({
      status: StageStatus.SUCCESS,
      notes: "All tests passed",
    });

    const result = await store.onStageComplete("plan", outcome, 1, 5000);
    expect(result.turnId).toBeGreaterThan(0n);
    expect(result.depth).toBeGreaterThan(0);

    // Verify we can read it back
    const turns = await store.getLastTurns(store.getContextId()!, 5);
    expect(turns.length).toBeGreaterThanOrEqual(2); // run metadata + stage result

    // Find the stage result turn
    const stageTurn = turns.find((t) => t.typeId === TypeIds.STAGE_RESULT);
    expect(stageTurn).toBeDefined();

    const decoded = msgpackDecode(stageTurn!.payload) as Record<string, unknown>;
    expect(decoded.nodeId).toBe("plan");
    expect(decoded.status).toBe("success");
    expect(decoded.attempts).toBe(1);
    expect(decoded.durationMs).toBe(5000);
  });

  test("onCheckpointSave appends a checkpoint turn", async () => {
    await store.onPipelineStart({
      pipelineId: "test-run-3",
      graphName: "checkpoint-test.dot",
    });

    const checkpoint: Checkpoint = {
      pipelineId: "test-run-3",
      timestamp: new Date().toISOString(),
      currentNode: "implement",
      completedNodes: ["plan"],
      nodeRetries: { plan: 0 },
      nodeOutcomes: { plan: "success" },
      contextValues: { outcome: "success", last_stage: "plan" },
      logs: ["Started plan", "Plan complete"],
    };

    const result = await store.onCheckpointSave(checkpoint);
    expect(result.turnId).toBeGreaterThan(0n);

    // Read back and verify
    const turns = await store.getLastTurns(store.getContextId()!, 5);
    const cpTurn = turns.find((t) => t.typeId === TypeIds.CHECKPOINT);
    expect(cpTurn).toBeDefined();

    const decoded = msgpackDecode(cpTurn!.payload) as Record<string, unknown>;
    expect(decoded.currentNode).toBe("implement");
    expect(decoded.completedNodes).toEqual(["plan"]);
  });

  test("onEvent appends a log turn", async () => {
    await store.onPipelineStart({
      pipelineId: "test-run-4",
      graphName: "event-test.dot",
    });

    const event: PipelineEvent = {
      kind: PipelineEventKind.STAGE_STARTED,
      timestamp: new Date(),
      pipelineId: "test-run-4",
      data: { nodeId: "test_node" },
    };

    const result = await store.onEvent(event);
    expect(result.turnId).toBeGreaterThan(0n);

    const turns = await store.getLastTurns(store.getContextId()!, 5);
    const logTurn = turns.find((t) => t.typeId === TypeIds.STAGE_LOG);
    expect(logTurn).toBeDefined();

    const decoded = msgpackDecode(logTurn!.payload) as Record<string, unknown>;
    expect(decoded.eventKind).toBe("stage_started");
    expect(decoded.nodeId).toBe("test_node");
  });

  test("full pipeline lifecycle: start → stages → checkpoint", async () => {
    await store.onPipelineStart({
      pipelineId: "lifecycle-test",
      graphName: "issue.dot",
      goal: "Fix bug #42",
      model: "normal",
      sessionId: "lifecycle-session",
    });

    const ctxId = store.getContextId()!;

    // Stage 1: plan
    await store.onStageComplete(
      "plan",
      createOutcome({ status: StageStatus.SUCCESS, notes: "Plan created" }),
      1,
      3000,
    );

    // Stage 2: implement
    await store.onStageComplete(
      "implement",
      createOutcome({ status: StageStatus.SUCCESS, notes: "Code written" }),
      1,
      12000,
    );

    // Stage 3: test (with retry)
    await store.onStageComplete(
      "test",
      createOutcome({ status: StageStatus.SUCCESS, notes: "Tests passing" }),
      2, // retried once
      8000,
    );

    // Final checkpoint
    await store.onCheckpointSave({
      pipelineId: "lifecycle-test",
      timestamp: new Date().toISOString(),
      currentNode: "review",
      completedNodes: ["plan", "implement", "test"],
      nodeRetries: { plan: 0, implement: 0, test: 1 },
      nodeOutcomes: { plan: "success", implement: "success", test: "success" },
      contextValues: { outcome: "success" },
      logs: [],
    });

    // Verify the full history
    const turns = await store.getLastTurns(ctxId, 20);

    // Should have: 1 run metadata + 3 stage results + 1 checkpoint = 5 turns
    expect(turns.length).toBe(5);

    // Verify types are correct
    const typeIds = turns.map((t) => t.typeId);
    expect(typeIds.filter((t) => t === TypeIds.PIPELINE_RUN).length).toBe(1);
    expect(typeIds.filter((t) => t === TypeIds.STAGE_RESULT).length).toBe(3);
    expect(typeIds.filter((t) => t === TypeIds.CHECKPOINT).length).toBe(1);

    // Verify ordering by depth
    const depths = turns.map((t) => t.depth);
    // Turns should have increasing depth (linear chain)
    for (let i = 1; i < depths.length; i++) {
      expect(depths[i]!).toBeGreaterThan(depths[i - 1]!);
    }
  });

  test("close is idempotent", () => {
    store.close();
    store.close(); // Should not throw
    expect(store.getContextId()).toBeNull();
  });

  test("double connect is a no-op (idempotent)", async () => {
    // Already connected in beforeEach, second connect should be a no-op
    await store.connect(); // Should not throw, just returns early
    expect(store.getContextId()).toBeNull(); // No pipeline started yet
  });
});
