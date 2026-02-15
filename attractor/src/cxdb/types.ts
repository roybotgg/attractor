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

// --- Field tag mappings (integer keys for CXDB projection) ---
// These must match the bundle registered with the CXDB server.

export const FieldTags = {
  [TypeIds.PIPELINE_RUN]: {
    pipelineId: 1,
    graphName: 2,
    goal: 3,
    dotSource: 4,
    model: 5,
    thinking: 6,
    sessionId: 7,
    startedAt: 8,
    env: 9,
  } as Record<string, number>,

  [TypeIds.STAGE_RESULT]: {
    nodeId: 1,
    status: 2,
    durationMs: 3,
    attempts: 4,
    notes: 5,
    failureReason: 6,
    contextUpdates: 7,
    completedAt: 8,
  } as Record<string, number>,

  [TypeIds.CHECKPOINT]: {
    pipelineId: 1,
    timestamp: 2,
    currentNode: 3,
    completedNodes: 4,
    nodeRetries: 5,
    nodeOutcomes: 6,
    contextValues: 7,
    logs: 8,
  } as Record<string, number>,

  [TypeIds.STAGE_LOG]: {
    eventKind: 1,
    nodeId: 2,
    message: 3,
    timestamp: 4,
    data: 5,
  } as Record<string, number>,
} as const;

/**
 * Convert a string-keyed data object to integer-tagged keys
 * for CXDB projection compatibility. Strips undefined values.
 */
export function toTagged(
  typeId: TypeId,
  data: Record<string, unknown>,
): Record<number, unknown> {
  const tags = FieldTags[typeId];
  const result: Record<number, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const tag = tags[key];
    if (tag !== undefined) {
      result[tag] = value;
    }
  }
  return result;
}

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
