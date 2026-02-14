import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  parse,
  PipelineRunner,
  createHandlerRegistry,
  StartHandler,
  ExitHandler,
  CodergenHandler,
  ConditionalHandler,
  PipelineEventEmitter,
  PipelineEventKind,
} from "./attractor/src/index.ts";
import { OpenClawBackend } from "./attractor/src/backends/openclaw-backend.ts";
import { CxdbStore } from "./attractor/src/cxdb/store.ts";

// --- Config ---
const MODEL = process.env.ATTRACTOR_MODEL || "normal"; // Sonnet 4.5 by default
const THINKING = process.env.ATTRACTOR_THINKING || "low";
const TIMEOUT = parseInt(process.env.ATTRACTOR_TIMEOUT || "600", 10);
const DOT_FILE = process.argv[2] || "pipeline.dot";
const SESSION_ID = process.env.ATTRACTOR_SESSION_ID || `attractor-${randomUUID().slice(0, 8)}`;

// CXDB config (set CXDB_ENABLED=1 to activate)
const CXDB_ENABLED = process.env.CXDB_ENABLED === "1";
const CXDB_HOST = process.env.CXDB_HOST || "localhost";
const CXDB_PORT = parseInt(process.env.CXDB_PORT || "9009", 10);
const CXDB_HTTP_PORT = parseInt(process.env.CXDB_HTTP_PORT || "9008", 10);

// --- Backend (OpenClaw agent CLI) ---
const backend = new OpenClawBackend({
  model: MODEL,
  thinking: THINKING,
  timeoutSeconds: TIMEOUT,
  sessionId: SESSION_ID,
});

// --- Parse pipeline (with env var expansion) ---
let dotSource = readFileSync(DOT_FILE, "utf-8");

// Expand $ENV_VAR references in the DOT source before parsing.
// Matches $UPPER_CASE_VARS (letters, digits, underscores) — won't touch $goal (lowercase).
dotSource = dotSource.replace(/\$([A-Z][A-Z0-9_]*)\b/g, (_match, varName) => {
  return process.env[varName] ?? _match;
});

const graph = parse(dotSource);

// --- Handler registry ---
const registry = createHandlerRegistry();
registry.register("start", new StartHandler());
registry.register("exit", new ExitHandler());
registry.register("codergen", new CodergenHandler(backend));
registry.register("conditional", new ConditionalHandler());

// --- Event streaming ---
const emitter = new PipelineEventEmitter();

(async () => {
  for await (const event of emitter.events()) {
    const ts = new Date().toISOString().slice(11, 19);
    if (event.kind === PipelineEventKind.STAGE_STARTED) {
      console.log(`[${ts}]  → Stage: ${event.data["nodeId"]}`);
    }
    if (event.kind === PipelineEventKind.STAGE_COMPLETED) {
      console.log(`[${ts}]  ✓ Completed: ${event.data["nodeId"]} (${event.data["status"]})`);
    }
    if (event.kind === PipelineEventKind.STAGE_RETRYING) {
      console.log(`[${ts}]  ⟳ Retrying: ${event.data["nodeId"]} (attempt ${event.data["attempt"]})`);
    }
    if (event.kind === PipelineEventKind.PIPELINE_COMPLETED) {
      console.log(`[${ts}]\n✅ Pipeline finished: ${event.data["status"]}`);
    }
    if (event.kind === PipelineEventKind.PIPELINE_FAILED) {
      console.log(`[${ts}]\n❌ Pipeline failed: ${event.data["reason"]}`);
    }
  }
})();

// --- Run ---
const cxdbStore = CXDB_ENABLED
  ? new CxdbStore({ host: CXDB_HOST, port: CXDB_PORT, httpPort: CXDB_HTTP_PORT })
  : undefined;

const runner = new PipelineRunner({
  handlerRegistry: registry,
  backend,
  eventEmitter: emitter,
  cxdbStore,
});

console.log(`Pipeline: ${DOT_FILE}`);
console.log(`Model: ${MODEL} | Thinking: ${THINKING} | Session: ${SESSION_ID}`);
if (CXDB_ENABLED) {
  console.log(`CXDB: ${CXDB_HOST}:${CXDB_PORT} (tracking enabled)`);
}
console.log("");

try {
  if (cxdbStore) {
    await cxdbStore.connect();
  }
  const result = await runner.run(graph);
  console.log(`\nOutcome: ${result.outcome.status}`);
  console.log(`Nodes completed: ${result.completedNodes.join(", ")}`);
  if (cxdbStore) {
    const ctxId = cxdbStore.getContextId();
    if (ctxId !== null) {
      console.log(`CXDB context: ${ctxId.toString()}`);
    }
    cxdbStore.close();
  }
} catch (err) {
  console.error("Pipeline error:", err);
  if (cxdbStore) cxdbStore.close();
  process.exit(1);
}
