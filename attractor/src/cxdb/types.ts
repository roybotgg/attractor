/**
 * CXDB type registry for Attractor pipeline data.
 *
 * Defines the type IDs, versions, and schemas for structured
 * data stored as CXDB turns.
 */

// --- Type IDs (reverse-DNS convention) ---

export const TypeIds = {
  /** Pipeline run metadata (first turn in a context) */
  PIPELINE_RUN: "attractor.pipeline.run",
  /** Stage execution result */
  STAGE_RESULT: "attractor.stage.result",
  /** Checkpoint snapshot (full pipeline state) */
  CHECKPOINT: "attractor.pipeline.checkpoint",
  /** Pipeline log entry (event stream) */
  STAGE_LOG: "attractor.stage.log",
} as const;

export type TypeId = (typeof TypeIds)[keyof typeof TypeIds];

// --- Current versions ---

export const TypeVersions: Record<TypeId, number> = {
  [TypeIds.PIPELINE_RUN]: 1,
  [TypeIds.STAGE_RESULT]: 1,
  [TypeIds.CHECKPOINT]: 1,
  [TypeIds.STAGE_LOG]: 1,
};

// --- Data schemas (what gets msgpack-encoded as turn payloads) ---

/** Metadata for a pipeline run — the first turn appended to a new context. */
export interface PipelineRunData {
  pipelineId: string;
  graphName: string;
  goal?: string;
  dotSource?: string;
  model?: string;
  thinking?: string;
  sessionId?: string;
  startedAt: string; // ISO-8601
  env?: Record<string, string>;
}

/** Result of a single stage execution. */
export interface StageResultData {
  nodeId: string;
  status: string; // StageStatus value
  durationMs?: number;
  attempts: number;
  notes?: string;
  failureReason?: string;
  contextUpdates?: Record<string, string | number | boolean>;
  completedAt: string; // ISO-8601
}

/** Full checkpoint snapshot for resume capability. */
export interface CheckpointData {
  pipelineId: string;
  timestamp: string; // ISO-8601
  currentNode: string;
  completedNodes: string[];
  nodeRetries: Record<string, number>;
  nodeOutcomes: Record<string, string>;
  contextValues: Record<string, string | number | boolean>;
  logs: string[];
}

/** A log entry from the pipeline event stream. */
export interface StageLogData {
  eventKind: string;
  nodeId?: string;
  message?: string;
  timestamp: string; // ISO-8601
  data?: Record<string, unknown>;
}
