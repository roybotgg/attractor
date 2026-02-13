/**
 * CXDB integration for Attractor.
 *
 * Provides a TypeScript client for the CXDB binary protocol,
 * enabling pipeline run history tracking via the Turn DAG.
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
