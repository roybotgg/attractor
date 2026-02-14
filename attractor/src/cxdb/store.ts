/**
 * CXDB StorageAdapter for Attractor pipelines.
 *
 * Bridges pipeline events (start, stage complete, checkpoint)
 * to CXDB turns via the binary protocol client.
 * Reads use the HTTP API for querying past runs.
 */

import { CxdbClient } from "./client.js";
import type { ContextHead, AppendResult } from "./client.js";
import {
  TypeIds,
  TypeVersions,
  type PipelineRunData,
  type StageResultData,
  type CheckpointData,
  type StageLogData,
} from "./types.js";
import type { Checkpoint } from "../types/checkpoint.js";
import type { Outcome } from "../types/outcome.js";
import type { PipelineEvent } from "../types/events.js";

export interface CxdbStoreOptions {
  /** CXDB host (default: localhost) */
  host?: string;
  /** CXDB binary protocol port (default: 9009) */
  port?: number;
  /** CXDB HTTP API port for reads (default: 9008) */
  httpPort?: number;
  /** Client tag for HELLO handshake */
  clientTag?: string;
  /** Whether to store DOT source in the run metadata */
  storeDotSource?: boolean;
}

export interface PipelineRunInfo {
  pipelineId: string;
  graphName: string;
  goal?: string;
  model?: string;
  thinking?: string;
  sessionId?: string;
  dotSource?: string;
  env?: Record<string, string>;
}

export class CxdbStore {
  private client: CxdbClient;
  private connected = false;
  private contextId: bigint | null = null;
  private options: Required<
    Pick<CxdbStoreOptions, "host" | "port" | "httpPort" | "clientTag" | "storeDotSource">
  >;

  constructor(options: CxdbStoreOptions = {}) {
    this.options = {
      host: options.host ?? "localhost",
      port: options.port ?? 9009,
      httpPort: options.httpPort ?? 9008,
      clientTag: options.clientTag ?? "attractor",
      storeDotSource: options.storeDotSource ?? false,
    };
    this.client = new CxdbClient({
      clientTag: this.options.clientTag,
    });
  }

  /** Connect to the CXDB binary protocol server. */
  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(this.options.host, this.options.port);
    this.connected = true;
  }

  /** Close the connection. */
  close(): void {
    if (this.connected) {
      this.client.close();
      this.connected = false;
      this.contextId = null;
    }
  }

  /** Returns the CXDB context ID for the current run, or null if not started. */
  getContextId(): bigint | null {
    return this.contextId;
  }

  /**
   * Called when a pipeline run starts.
   * Creates a new CXDB context and appends the run metadata as the first turn.
   */
  async onPipelineStart(info: PipelineRunInfo): Promise<ContextHead> {
    this.ensureConnected();

    // Create a fresh context
    const head = await this.client.createContext();
    this.contextId = head.contextId;

    // Append pipeline run metadata as first turn
    const data: PipelineRunData = {
      pipelineId: info.pipelineId,
      graphName: info.graphName,
      goal: info.goal,
      model: info.model,
      thinking: info.thinking,
      sessionId: info.sessionId,
      startedAt: new Date().toISOString(),
      env: info.env,
    };
    if (this.options.storeDotSource && info.dotSource) {
      data.dotSource = info.dotSource;
    }

    await this.client.append(
      this.contextId,
      TypeIds.PIPELINE_RUN,
      TypeVersions[TypeIds.PIPELINE_RUN],
      data,
    );

    return head;
  }

  /**
   * Called when a stage completes.
   * Appends a StageResult turn to the pipeline's context.
   */
  async onStageComplete(
    nodeId: string,
    outcome: Outcome,
    attempts: number,
    durationMs?: number,
  ): Promise<AppendResult> {
    this.ensureConnected();
    this.ensureContext();

    const data: StageResultData = {
      nodeId,
      status: outcome.status,
      durationMs,
      attempts,
      notes: outcome.notes || undefined,
      failureReason: outcome.failureReason || undefined,
      contextUpdates:
        Object.keys(outcome.contextUpdates).length > 0
          ? (outcome.contextUpdates as Record<string, string | number | boolean>)
          : undefined,
      completedAt: new Date().toISOString(),
    };

    return this.client.append(
      this.contextId!,
      TypeIds.STAGE_RESULT,
      TypeVersions[TypeIds.STAGE_RESULT],
      data,
    );
  }

  /**
   * Called on checkpoint saves.
   * Appends the full checkpoint as a turn for resume capability.
   */
  async onCheckpointSave(checkpoint: Checkpoint): Promise<AppendResult> {
    this.ensureConnected();
    this.ensureContext();

    const data: CheckpointData = {
      pipelineId: checkpoint.pipelineId,
      timestamp: checkpoint.timestamp,
      currentNode: checkpoint.currentNode,
      completedNodes: checkpoint.completedNodes,
      nodeRetries: checkpoint.nodeRetries,
      nodeOutcomes: checkpoint.nodeOutcomes,
      contextValues: checkpoint.contextValues as Record<
        string,
        string | number | boolean
      >,
      logs: checkpoint.logs,
    };

    return this.client.append(
      this.contextId!,
      TypeIds.CHECKPOINT,
      TypeVersions[TypeIds.CHECKPOINT],
      data,
    );
  }

  /**
   * Append a pipeline event as a log turn.
   */
  async onEvent(event: PipelineEvent): Promise<AppendResult> {
    this.ensureConnected();
    this.ensureContext();

    const data: StageLogData = {
      eventKind: event.kind,
      nodeId: (event.data as Record<string, unknown>)?.nodeId as
        | string
        | undefined,
      timestamp: event.timestamp.toISOString(),
      data: event.data as Record<string, unknown>,
    };

    return this.client.append(
      this.contextId!,
      TypeIds.STAGE_LOG,
      TypeVersions[TypeIds.STAGE_LOG],
      data,
    );
  }

  // --- Read methods (HTTP API) ---

  /**
   * List recent pipeline runs by querying CXDB contexts via HTTP.
   * Returns raw context metadata.
   */
  async listRuns(limit = 20): Promise<unknown[]> {
    const url = `http://${this.options.host}:${this.options.httpPort}/v1/contexts?limit=${limit}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`CXDB HTTP error: ${resp.status} ${resp.statusText}`);
    }
    const body = (await resp.json()) as { contexts?: unknown[] };
    return body.contexts ?? [];
  }

  /**
   * Get turns for a specific context (pipeline run) via HTTP.
   * Useful for replaying history or loading checkpoints.
   */
  async getRunTurns(
    contextId: bigint | string,
    limit = 100,
  ): Promise<unknown[]> {
    const id =
      typeof contextId === "bigint" ? contextId.toString() : contextId;
    const url = `http://${this.options.host}:${this.options.httpPort}/v1/contexts/${id}/turns?limit=${limit}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`CXDB HTTP error: ${resp.status} ${resp.statusText}`);
    }
    const body = (await resp.json()) as { turns?: unknown[] };
    return body.turns ?? [];
  }

  /**
   * Get the last N turns from a context via the binary protocol.
   * More efficient for getting recent state.
   */
  async getLastTurns(contextId: bigint, limit = 10) {
    this.ensureConnected();
    return this.client.getLast(contextId, limit);
  }

  // --- Internal ---

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error("CxdbStore not connected. Call connect() first.");
    }
  }

  private ensureContext(): void {
    if (this.contextId === null) {
      throw new Error(
        "No active context. Call onPipelineStart() first.",
      );
    }
  }
}
