/**
 * Tests for the CXDB TypeScript binary protocol client.
 *
 * These tests run against the real CXDB server (Docker container on localhost:9009).
 * Skip with: CXDB_SKIP_INTEGRATION=1 bun test
 */

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { CxdbClient } from "../../src/cxdb/client.js";
import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";

const CXDB_HOST = process.env.CXDB_HOST ?? "localhost";
const CXDB_PORT = parseInt(process.env.CXDB_PORT ?? "9009", 10);
const SKIP = process.env.CXDB_SKIP_INTEGRATION === "1";

describe.skipIf(SKIP)("CxdbClient (integration)", () => {
  let client: CxdbClient;

  beforeEach(async () => {
    client = new CxdbClient({ clientTag: "test-suite" });
    await client.connect(CXDB_HOST, CXDB_PORT);
  });

  afterEach(() => {
    client?.close();
  });

  test("connects and gets a session ID", () => {
    expect(client.getSessionId()).toBeGreaterThan(0n);
  });

  test("creates an empty context", async () => {
    const ctx = await client.createContext();
    expect(ctx.contextId).toBeGreaterThan(0n);
    expect(ctx.headTurnId).toBe(0n);
    expect(ctx.headDepth).toBe(0);
  });

  test("appends a turn and reads it back", async () => {
    const ctx = await client.createContext();
    const data = { 1: "user", 2: "Hello, world!" };
    const payload = new Uint8Array(msgpackEncode(data));

    const result = await client.appendTurn({
      contextId: ctx.contextId,
      typeId: "test.Message",
      typeVersion: 1,
      payload,
    });

    expect(result.contextId).toBe(ctx.contextId);
    expect(result.turnId).toBeGreaterThan(0n);
    expect(result.depth).toBe(0); // CXDB uses 0-based depth
    expect(result.payloadHash.length).toBe(32);

    // Read it back
    const turns = await client.getLast(ctx.contextId, 10);
    expect(turns.length).toBe(1);
    const turn = turns[0]!;
    expect(turn.turnId).toBe(result.turnId);
    expect(turn.depth).toBe(0); // 0-based
    expect(turn.typeId).toBe("test.Message");
    expect(turn.typeVersion).toBe(1);

    // Decode payload
    const decoded = msgpackDecode(turn.payload) as Record<number, string>;
    expect(decoded[1]).toBe("user");
    expect(decoded[2]).toBe("Hello, world!");
  });

  test("appends multiple turns and reads history", async () => {
    const ctx = await client.createContext();

    // Append 3 turns
    for (let i = 1; i <= 3; i++) {
      const data = { 1: `turn-${i}` };
      await client.append(ctx.contextId, "test.Message", 1, data);
    }

    const turns = await client.getLast(ctx.contextId, 10);
    expect(turns.length).toBe(3);

    // Turns should be oldest → newest (0-based depth)
    for (let i = 0; i < 3; i++) {
      const turn = turns[i]!;
      const decoded = msgpackDecode(turn.payload) as Record<number, string>;
      expect(decoded[1]).toBe(`turn-${i + 1}`);
      expect(turn.depth).toBe(i);
    }
  });

  test("get head tracks latest turn", async () => {
    const ctx = await client.createContext();
    let head = await client.getHead(ctx.contextId);
    expect(head.headTurnId).toBe(0n);
    expect(head.headDepth).toBe(0);

    const r1 = await client.append(ctx.contextId, "test.Message", 1, { 1: "first" });
    head = await client.getHead(ctx.contextId);
    expect(head.headTurnId).toBe(r1.turnId);
    expect(head.headDepth).toBe(0); // 0-based

    const r2 = await client.append(ctx.contextId, "test.Message", 1, { 1: "second" });
    head = await client.getHead(ctx.contextId);
    expect(head.headTurnId).toBe(r2.turnId);
    expect(head.headDepth).toBe(1); // 0-based
  });

  test("forks a context from a turn", async () => {
    const ctx = await client.createContext();
    const r1 = await client.append(ctx.contextId, "test.Message", 1, { 1: "base" });
    await client.append(ctx.contextId, "test.Message", 1, { 1: "branch-a" });

    // Fork from r1 (before branch-a)
    const forked = await client.forkContext(r1.turnId);
    expect(forked.contextId).not.toBe(ctx.contextId);
    expect(forked.headTurnId).toBe(r1.turnId);
    expect(forked.headDepth).toBe(0); // 0-based

    // Append to the fork
    await client.append(forked.contextId, "test.Message", 1, { 1: "branch-b" });

    // Fork should have 2 turns: base + branch-b
    const forkTurns = await client.getLast(forked.contextId, 10);
    expect(forkTurns.length).toBe(2);
    const forkDecoded0 = msgpackDecode(forkTurns[0]!.payload) as Record<number, string>;
    const forkDecoded1 = msgpackDecode(forkTurns[1]!.payload) as Record<number, string>;
    expect(forkDecoded0[1]).toBe("base");
    expect(forkDecoded1[1]).toBe("branch-b");

    // Original should still have 2 turns: base + branch-a
    const origTurns = await client.getLast(ctx.contextId, 10);
    expect(origTurns.length).toBe(2);
    const origDecoded1 = msgpackDecode(origTurns[1]!.payload) as Record<number, string>;
    expect(origDecoded1[1]).toBe("branch-a");
  });

  test("idempotency key is accepted without error", async () => {
    const ctx = await client.createContext();
    const data = { 1: "idempotent" };
    const key = `test-${Date.now()}-${Math.random()}`;

    const r1 = await client.append(ctx.contextId, "test.Message", 1, data, {
      idempotencyKey: key,
    });

    // Server parses but doesn't enforce idempotency in this build;
    // just verify the key doesn't cause an error
    expect(r1.turnId).toBeGreaterThan(0n);

    const r2 = await client.append(ctx.contextId, "test.Message", 1, data, {
      idempotencyKey: key,
    });

    // Both appends succeed (server doesn't dedup)
    expect(r2.turnId).toBeGreaterThan(0n);
  });

  test("getLast with limit", async () => {
    const ctx = await client.createContext();
    for (let i = 0; i < 5; i++) {
      await client.append(ctx.contextId, "test.Message", 1, { 1: `msg-${i}` });
    }

    const last2 = await client.getLast(ctx.contextId, 2);
    expect(last2.length).toBe(2);
    // Should be the LAST 2 turns (newest)
    const d0 = msgpackDecode(last2[0]!.payload) as Record<number, string>;
    const d1 = msgpackDecode(last2[1]!.payload) as Record<number, string>;
    expect(d0[1]).toBe("msg-3");
    expect(d1[1]).toBe("msg-4");
  });

  test("getLast on empty context returns empty array", async () => {
    const ctx = await client.createContext();
    const turns = await client.getLast(ctx.contextId, 10);
    expect(turns.length).toBe(0);
  });

  test("payload hash matches BLAKE3", async () => {
    const { blake3 } = await import("@noble/hashes/blake3.js");
    const ctx = await client.createContext();
    const data = { 1: "hash-test", 2: 42 };
    const payload = new Uint8Array(msgpackEncode(data));
    const expectedHash = blake3(payload);

    const result = await client.appendTurn({
      contextId: ctx.contextId,
      typeId: "test.Message",
      typeVersion: 1,
      payload,
    });

    expect(Buffer.from(result.payloadHash).toString("hex")).toBe(
      Buffer.from(expectedHash).toString("hex"),
    );
  });

  test("convenience append encodes msgpack correctly", async () => {
    const ctx = await client.createContext();
    const data = {
      1: "assistant",
      2: "The answer is 42",
      3: Date.now(),
    };

    await client.append(ctx.contextId, "test.ConversationItem", 1, data);

    const turns = await client.getLast(ctx.contextId, 1);
    expect(turns.length).toBe(1);
    const decoded = msgpackDecode(turns[0]!.payload) as Record<number, unknown>;
    expect(decoded[1]).toBe("assistant");
    expect(decoded[2]).toBe("The answer is 42");
    expect(decoded[3]).toBe(data[3]);
  });
});

describe("CxdbClient (unit)", () => {
  test("close on unconnected client is safe", () => {
    const client = new CxdbClient();
    expect(() => client.close()).not.toThrow();
  });

  test("operations on closed client throw", async () => {
    const client = new CxdbClient();
    expect(client.getSessionId()).toBe(0n);
    await expect(client.createContext()).rejects.toThrow("Not connected");
  });

  test("double connect throws", async () => {
    if (process.env.CXDB_SKIP_INTEGRATION === "1") return;

    const client = new CxdbClient({ clientTag: "double-connect-test" });
    await client.connect(
      process.env.CXDB_HOST ?? "localhost",
      parseInt(process.env.CXDB_PORT ?? "9009", 10),
    );

    await expect(
      client.connect(
        process.env.CXDB_HOST ?? "localhost",
        parseInt(process.env.CXDB_PORT ?? "9009", 10),
      ),
    ).rejects.toThrow("Already connected");

    client.close();
  });

  test("connect to invalid host times out", async () => {
    const client = new CxdbClient({ dialTimeoutMs: 500 });
    // Use a non-routable IP to force timeout
    await expect(client.connect("192.0.2.1", 9009)).rejects.toThrow();
  });
});
