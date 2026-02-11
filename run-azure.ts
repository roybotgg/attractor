import { readFileSync } from "node:fs";
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
} from "./attractor/src/index.js";
import { SessionBackend } from "./attractor/src/backends/session-backend.js";
import { createOpenAIProfile } from "./coding-agent/src/profiles/openai-profile.js";
import { LocalExecutionEnvironment } from "./coding-agent/src/env/local-env.js";
import { Client } from "./unified-llm/src/client/client.js";
import { OpenAICompatibleAdapter } from "./unified-llm/src/providers/openai-compatible/adapter.js";

// --- Config ---
const AZURE_ENDPOINT = "https://skillup-ai209507648992.cognitiveservices.azure.com";
const DEPLOYMENT = "gpt-5-mini";
const API_VERSION = "2024-04-01-preview";
const API_KEY = process.env.AZURE_OPENAI_KEY;

if (!API_KEY) {
  console.error("AZURE_OPENAI_KEY not set");
  process.exit(1);
}

const REPO_PATH = "/home/rey/clawd/localrank-city";
const DOT_FILE = process.argv[2] || "pipeline.dot";

// --- LLM Client (Azure OpenAI via OpenAI-compatible adapter) ---
const adapter = new OpenAICompatibleAdapter({
  baseUrl: `${AZURE_ENDPOINT}/openai/deployments/${DEPLOYMENT}`,
  apiKey: API_KEY,
  defaultHeaders: {
    "api-key": API_KEY,
    "api-version": API_VERSION,
  },
});

const client = new Client({
  adapters: { "openai-compatible": adapter },
  defaultProvider: "openai-compatible",
});

// --- Execution Environment ---
const executionEnv = new LocalExecutionEnvironment({
  workingDir: REPO_PATH,
});

// --- Provider Profile (OpenAI-style tools) ---
const profile = createOpenAIProfile(DEPLOYMENT);

// --- Backend ---
const backend = new SessionBackend({
  providerProfile: profile,
  executionEnv,
  llmClient: client,
});

// --- Parse pipeline ---
const dotSource = readFileSync(DOT_FILE, "utf-8");
const graph = parse(dotSource);

// --- Handler registry ---
const registry = createHandlerRegistry();
registry.register("start", new StartHandler());
registry.register("exit", new ExitHandler());
registry.register("codergen", new CodergenHandler());
registry.register("conditional", new ConditionalHandler());

// --- Event streaming ---
const emitter = new PipelineEventEmitter();

(async () => {
  for await (const event of emitter.events()) {
    if (event.kind === PipelineEventKind.STAGE_STARTED) {
      console.log(`  → Stage: ${event.data["nodeId"]}`);
    }
    if (event.kind === PipelineEventKind.STAGE_COMPLETED) {
      console.log(`  ✓ Completed: ${event.data["nodeId"]} (${event.data["status"]})`);
    }
    if (event.kind === PipelineEventKind.PIPELINE_COMPLETED) {
      console.log(`\n✅ Pipeline finished: ${event.data["status"]}`);
    }
    if (event.kind === PipelineEventKind.PIPELINE_FAILED) {
      console.log(`\n❌ Pipeline failed: ${event.data["reason"]}`);
    }
  }
})();

// --- Run ---
const runner = new PipelineRunner({
  handlerRegistry: registry,
  backend,
  eventEmitter: emitter,
});

console.log(`Running pipeline: ${DOT_FILE}`);
console.log(`Repo: ${REPO_PATH}`);
console.log(`Model: ${DEPLOYMENT} (Azure OpenAI)`);
console.log("");

try {
  const result = await runner.run(graph);
  console.log(`\nOutcome: ${result.outcome.status}`);
  console.log(`Nodes completed: ${result.completedNodes.join(", ")}`);
} catch (err) {
  console.error("Pipeline error:", err);
  process.exit(1);
}
