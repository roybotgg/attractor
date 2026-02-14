/**
 * CXDB integration for Attractor.
 *
 * Provides a TypeScript client for the CXDB binary protocol,
 * type registry for pipeline data, and a storage adapter
 * for tracking pipeline runs as a turn DAG.
 */

export {
  CxdbClient,
  CxdbServerError,
  CxdbClientError,
  MsgType,
  Encoding,
  Compression,
} from "./client.js";

export type {
  CxdbClientOptions,
  ContextHead,
  AppendRequest,
  AppendResult,
  TurnRecord,
} from "./client.js";

export {
  TypeIds,
  TypeVersions,
} from "./types.js";

export type {
  TypeId,
  PipelineRunData,
  StageResultData,
  CheckpointData,
  StageLogData,
} from "./types.js";

export {
  CxdbStore,
} from "./store.js";

export type {
  CxdbStoreOptions,
  PipelineRunInfo,
} from "./store.js";
