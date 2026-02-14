/**
 * TypeScript client for the CXDB binary protocol.
 *
 * Implements the frame-based TCP protocol for creating contexts,
 * appending turns, forking, and querying the turn DAG.
 *
 * Protocol spec: 16-byte frame header (LE) + payload
 *   [len: u32] [msg_type: u16] [flags: u16] [req_id: u64]
 */

import { Socket } from "net";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import { blake3 } from "@noble/hashes/blake3.js";

// --- Constants ---

/** Binary protocol message types */
export const MsgType = {
  HELLO: 1,
  CTX_CREATE: 2,
  CTX_FORK: 3,
  GET_HEAD: 4,
  APPEND: 5,
  GET_LAST: 6,
  GET_BLOB: 9,
  ERROR: 255,
} as const;

/** Payload encoding */
export const Encoding = {
  MSGPACK: 1,
} as const;

/** Compression */
export const Compression = {
  NONE: 0,
  ZSTD: 1,
} as const;

const FRAME_HEADER_SIZE = 16;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_DIAL_TIMEOUT_MS = 5_000;

// --- Types ---

export interface CxdbClientOptions {
  /** Connection timeout in ms (default: 5000) */
  dialTimeoutMs?: number;
  /** Per-request timeout in ms (default: 30000) */
  requestTimeoutMs?: number;
  /** Client identifier tag sent in HELLO */
  clientTag?: string;
}

export interface ContextHead {
  contextId: bigint;
  headTurnId: bigint;
  headDepth: number;
}

export interface AppendRequest {
  contextId: bigint;
  /** Parent turn ID. 0n = use current head. */
  parentTurnId?: bigint;
  typeId: string;
  typeVersion: number;
  /** Raw msgpack-encoded payload bytes */
  payload: Uint8Array;
  /** Optional idempotency key for safe retries */
  idempotencyKey?: string;
}

export interface AppendResult {
  contextId: bigint;
  turnId: bigint;
  depth: number;
  payloadHash: Uint8Array;
}

export interface TurnRecord {
  turnId: bigint;
  parentId: bigint;
  depth: number;
  typeId: string;
  typeVersion: number;
  encoding: number;
  compression: number;
  payloadHash: Uint8Array;
  payload: Uint8Array;
}

export class CxdbServerError extends Error {
  constructor(
    public readonly code: number,
    public readonly detail: string,
  ) {
    super(`cxdb server error ${code}: ${detail}`);
    this.name = "CxdbServerError";
  }
}

export class CxdbClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CxdbClientError";
  }
}

// --- Frame I/O ---

interface Frame {
  msgType: number;
  flags: number;
  reqId: bigint;
  payload: Buffer;
}

function writeFrameHeader(
  len: number,
  msgType: number,
  flags: number,
  reqId: bigint,
): Buffer {
  const buf = Buffer.alloc(FRAME_HEADER_SIZE);
  buf.writeUInt32LE(len, 0);
  buf.writeUInt16LE(msgType, 4);
  buf.writeUInt16LE(flags, 6);
  buf.writeBigUInt64LE(reqId, 8);
  return buf;
}

function parseFrameHeader(buf: Buffer): {
  len: number;
  msgType: number;
  flags: number;
  reqId: bigint;
} {
  return {
    len: buf.readUInt32LE(0),
    msgType: buf.readUInt16LE(4),
    flags: buf.readUInt16LE(6),
    reqId: buf.readBigUInt64LE(8),
  };
}

// --- Client ---

/**
 * CXDB binary protocol client.
 *
 * This client uses a single pending request model — only one request/response
 * can be in-flight at a time per connection. Do not issue concurrent operations
 * on the same client instance. For parallel workloads, create multiple clients.
 *
 * The receive buffer grows via Buffer.concat on each data chunk. This is fine
 * for short-lived pipeline runs but not ideal for long-lived connections with
 * large payloads. Consider a ring buffer if this becomes a hot path.
 */
export class CxdbClient {
  private socket: Socket | null = null;
  private reqIdCounter = 0n;
  private requestTimeoutMs: number;
  private clientTag: string;
  private sessionId = 0n;
  private closed = false;

  // Buffer for incoming data (frame reassembly)
  private recvBuf = Buffer.alloc(0);
  private pendingResolve:
    | ((frame: Frame) => void)
    | null = null;
  private pendingReject:
    | ((err: Error) => void)
    | null = null;

  constructor(private readonly options: CxdbClientOptions = {}) {
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.clientTag = options.clientTag ?? "attractor-ts";
  }

  /** Connect to a CXDB server and perform the HELLO handshake. */
  async connect(host: string, port: number): Promise<void> {
    if (this.socket) {
      throw new CxdbClientError("Already connected");
    }

    const dialTimeout =
      this.options.dialTimeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS;

    await new Promise<void>((resolve, reject) => {
      const socket = new Socket();
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new CxdbClientError(`Connection timeout after ${dialTimeout}ms`));
      }, dialTimeout);

      socket.connect(port, host, () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve();
      });

      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(new CxdbClientError(`Connection failed: ${err.message}`));
      });
    });

    // Set up data handler for frame reassembly
    this.socket!.on("data", (chunk: Buffer) => {
      this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
      this.tryDeliverFrame();
    });

    this.socket!.on("error", (err) => {
      if (this.pendingReject) {
        this.pendingReject(
          new CxdbClientError(`Socket error: ${err.message}`),
        );
        this.pendingResolve = null;
        this.pendingReject = null;
      }
    });

    this.socket!.on("close", () => {
      this.closed = true;
      if (this.pendingReject) {
        this.pendingReject(new CxdbClientError("Connection closed"));
        this.pendingResolve = null;
        this.pendingReject = null;
      }
    });

    // Perform HELLO handshake
    await this.sendHello();
  }

  /** Close the connection. */
  close(): void {
    if (this.socket && !this.closed) {
      this.closed = true;
      this.socket.destroy();
      this.socket = null;
    }
  }

  /** Returns the session ID assigned by the server. */
  getSessionId(): bigint {
    return this.sessionId;
  }

  /** Create a new context. baseTurnId=0n for empty context. */
  async createContext(baseTurnId = 0n): Promise<ContextHead> {
    const payload = Buffer.alloc(8);
    payload.writeBigUInt64LE(baseTurnId, 0);

    const resp = await this.sendRequest(MsgType.CTX_CREATE, payload);
    return parseContextHead(resp.payload);
  }

  /** Fork a context from a specific turn (O(1) branch). */
  async forkContext(baseTurnId: bigint): Promise<ContextHead> {
    const payload = Buffer.alloc(8);
    payload.writeBigUInt64LE(baseTurnId, 0);

    const resp = await this.sendRequest(MsgType.CTX_FORK, payload);
    return parseContextHead(resp.payload);
  }

  /** Get the current head of a context. */
  async getHead(contextId: bigint): Promise<ContextHead> {
    const payload = Buffer.alloc(8);
    payload.writeBigUInt64LE(contextId, 0);

    const resp = await this.sendRequest(MsgType.GET_HEAD, payload);
    return parseContextHead(resp.payload);
  }

  /** Append a turn to a context. */
  async appendTurn(req: AppendRequest): Promise<AppendResult> {
    const parentTurnId = req.parentTurnId ?? 0n;

    // Compute BLAKE3 hash of payload
    const hash = blake3(req.payload);

    // Build payload buffer
    const typeIdBytes = Buffer.from(req.typeId, "utf-8");
    const idempotencyKeyBytes = req.idempotencyKey
      ? Buffer.from(req.idempotencyKey, "utf-8")
      : Buffer.alloc(0);

    // Calculate total size
    const totalSize =
      8 + // contextId
      8 + // parentTurnId
      4 + // typeId len
      typeIdBytes.length + // typeId
      4 + // typeVersion
      4 + // encoding
      4 + // compression
      4 + // uncompressed len
      32 + // content hash
      4 + // payload len
      req.payload.length + // payload
      4 + // idempotency key len
      idempotencyKeyBytes.length; // idempotency key

    const buf = Buffer.alloc(totalSize);
    let offset = 0;

    // contextId
    buf.writeBigUInt64LE(req.contextId, offset);
    offset += 8;

    // parentTurnId
    buf.writeBigUInt64LE(parentTurnId, offset);
    offset += 8;

    // typeId
    buf.writeUInt32LE(typeIdBytes.length, offset);
    offset += 4;
    typeIdBytes.copy(buf, offset);
    offset += typeIdBytes.length;

    // typeVersion
    buf.writeUInt32LE(req.typeVersion, offset);
    offset += 4;

    // encoding (msgpack)
    buf.writeUInt32LE(Encoding.MSGPACK, offset);
    offset += 4;

    // compression (none)
    buf.writeUInt32LE(Compression.NONE, offset);
    offset += 4;

    // uncompressed len
    buf.writeUInt32LE(req.payload.length, offset);
    offset += 4;

    // content hash (BLAKE3-256)
    Buffer.from(hash).copy(buf, offset);
    offset += 32;

    // payload
    buf.writeUInt32LE(req.payload.length, offset);
    offset += 4;
    Buffer.from(req.payload).copy(buf, offset);
    offset += req.payload.length;

    // idempotency key
    buf.writeUInt32LE(idempotencyKeyBytes.length, offset);
    offset += 4;
    if (idempotencyKeyBytes.length > 0) {
      idempotencyKeyBytes.copy(buf, offset);
    }

    const resp = await this.sendRequest(MsgType.APPEND, buf);
    return parseAppendResult(resp.payload);
  }

  /** Get the last N turns from a context. */
  async getLast(
    contextId: bigint,
    limit = 10,
    includePayload = true,
  ): Promise<TurnRecord[]> {
    const payload = Buffer.alloc(16);
    payload.writeBigUInt64LE(contextId, 0);
    payload.writeUInt32LE(limit, 8);
    payload.writeUInt32LE(includePayload ? 1 : 0, 12);

    const resp = await this.sendRequest(MsgType.GET_LAST, payload);
    return parseTurnRecords(resp.payload);
  }

  // --- Convenience: encode + append ---

  /**
   * Encode a JS object as msgpack and append it as a turn.
   * This is the most common usage pattern.
   */
  async append(
    contextId: bigint,
    typeId: string,
    typeVersion: number,
    data: unknown,
    options?: {
      parentTurnId?: bigint;
      idempotencyKey?: string;
    },
  ): Promise<AppendResult> {
    const payload = msgpackEncode(data);
    return this.appendTurn({
      contextId,
      typeId,
      typeVersion,
      payload: new Uint8Array(payload),
      parentTurnId: options?.parentTurnId,
      idempotencyKey: options?.idempotencyKey,
    });
  }

  // --- Internal ---

  private async sendHello(): Promise<void> {
    const tagBytes = Buffer.from(this.clientTag, "utf-8");

    // HELLO payload: protocol_version(u16) + tag_len(u16) + tag + meta_len(u32)
    // Note: Go client uses u16 for protocol_version and tag_len
    const payload = Buffer.alloc(2 + 2 + tagBytes.length + 4);
    let offset = 0;

    payload.writeUInt16LE(1, offset); // protocol version
    offset += 2;

    payload.writeUInt16LE(tagBytes.length, offset);
    offset += 2;

    tagBytes.copy(payload, offset);
    offset += tagBytes.length;

    payload.writeUInt32LE(0, offset); // no JSON metadata

    const reqId = this.nextReqId();
    await this.writeFrame(MsgType.HELLO, 0, reqId, payload);

    const resp = await this.readFrame();

    if (resp.msgType === MsgType.ERROR) {
      throw parseServerError(resp.payload);
    }

    if (resp.msgType !== MsgType.HELLO) {
      throw new CxdbClientError(
        `Unexpected HELLO response type: ${resp.msgType}`,
      );
    }

    // Parse response: session_id (u64) + protocol_version (u16)
    if (resp.payload.length >= 8) {
      this.sessionId = resp.payload.readBigUInt64LE(0);
    }
  }

  private async sendRequest(
    msgType: number,
    payload: Buffer,
  ): Promise<Frame> {
    this.ensureConnected();

    const reqId = this.nextReqId();
    await this.writeFrame(msgType, 0, reqId, payload);

    const resp = await this.readFrame();

    if (resp.msgType === MsgType.ERROR) {
      throw parseServerError(resp.payload);
    }

    return resp;
  }

  private async writeFrame(
    msgType: number,
    flags: number,
    reqId: bigint,
    payload: Buffer,
  ): Promise<void> {
    const header = writeFrameHeader(payload.length, msgType, flags, reqId);
    const frame = Buffer.concat([header, payload]);

    return new Promise<void>((resolve, reject) => {
      this.socket!.write(frame, (err) => {
        if (err) reject(new CxdbClientError(`Write failed: ${err.message}`));
        else resolve();
      });
    });
  }

  private readFrame(): Promise<Frame> {
    return new Promise<Frame>((resolve, reject) => {
      if (this.pendingResolve) {
        reject(
          new CxdbClientError(
            "Concurrent request not supported (single connection)",
          ),
        );
        return;
      }

      const timer = setTimeout(() => {
        this.pendingResolve = null;
        this.pendingReject = null;
        reject(new CxdbClientError("Request timeout"));
      }, this.requestTimeoutMs);

      this.pendingResolve = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.pendingReject = (err) => {
        clearTimeout(timer);
        reject(err);
      };

      // Check if we already have a complete frame buffered
      this.tryDeliverFrame();
    });
  }

  private tryDeliverFrame(): void {
    if (!this.pendingResolve) return;

    if (this.recvBuf.length < FRAME_HEADER_SIZE) return;

    const header = parseFrameHeader(this.recvBuf);
    const totalLen = FRAME_HEADER_SIZE + header.len;

    if (this.recvBuf.length < totalLen) return;

    const payload = this.recvBuf.subarray(FRAME_HEADER_SIZE, totalLen);
    this.recvBuf = Buffer.from(this.recvBuf.subarray(totalLen));

    const frame: Frame = {
      msgType: header.msgType,
      flags: header.flags,
      reqId: header.reqId,
      payload: Buffer.from(payload),
    };

    const resolve = this.pendingResolve!;
    this.pendingResolve = null;
    this.pendingReject = null;
    resolve(frame);
  }

  private nextReqId(): bigint {
    this.reqIdCounter += 1n;
    return this.reqIdCounter;
  }

  private ensureConnected(): void {
    if (!this.socket || this.closed) {
      throw new CxdbClientError("Not connected");
    }
  }
}

// --- Response parsers ---

function parseContextHead(payload: Buffer): ContextHead {
  if (payload.length < 20) {
    throw new CxdbClientError(
      `Context head too short: ${payload.length} bytes`,
    );
  }
  return {
    contextId: payload.readBigUInt64LE(0),
    headTurnId: payload.readBigUInt64LE(8),
    headDepth: payload.readUInt32LE(16),
  };
}

function parseAppendResult(payload: Buffer): AppendResult {
  if (payload.length < 52) {
    throw new CxdbClientError(
      `Append result too short: ${payload.length} bytes`,
    );
  }
  return {
    contextId: payload.readBigUInt64LE(0),
    turnId: payload.readBigUInt64LE(8),
    depth: payload.readUInt32LE(16),
    payloadHash: new Uint8Array(payload.subarray(20, 52)),
  };
}

function parseTurnRecords(data: Buffer): TurnRecord[] {
  if (data.length < 4) {
    throw new CxdbClientError("Turn records too short");
  }

  const count = data.readUInt32LE(0);
  let offset = 4;
  const records: TurnRecord[] = [];

  for (let i = 0; i < count; i++) {
    const turnId = data.readBigUInt64LE(offset);
    offset += 8;

    const parentId = data.readBigUInt64LE(offset);
    offset += 8;

    const depth = data.readUInt32LE(offset);
    offset += 4;

    const typeIdLen = data.readUInt32LE(offset);
    offset += 4;

    const typeId = data.subarray(offset, offset + typeIdLen).toString("utf-8");
    offset += typeIdLen;

    const typeVersion = data.readUInt32LE(offset);
    offset += 4;

    const encoding = data.readUInt32LE(offset);
    offset += 4;

    const compression = data.readUInt32LE(offset);
    offset += 4;

    // uncompressed_len
    const _uncompressedLen = data.readUInt32LE(offset);
    offset += 4;

    const payloadHash = new Uint8Array(data.subarray(offset, offset + 32));
    offset += 32;

    const payloadLen = data.readUInt32LE(offset);
    offset += 4;

    const payload = new Uint8Array(data.subarray(offset, offset + payloadLen));
    offset += payloadLen;

    records.push({
      turnId,
      parentId,
      depth,
      typeId,
      typeVersion,
      encoding,
      compression,
      payloadHash,
      payload,
    });
  }

  return records;
}

function parseServerError(payload: Buffer): CxdbServerError {
  if (payload.length < 8) {
    return new CxdbServerError(0, "unknown error");
  }
  const code = payload.readUInt32LE(0);
  const detailLen = payload.readUInt32LE(4);
  let detail = "";
  if (detailLen > 0 && detailLen <= payload.length - 8) {
    detail = payload.subarray(8, 8 + detailLen).toString("utf-8");
  }
  return new CxdbServerError(code, detail);
}
