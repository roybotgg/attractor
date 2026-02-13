import type { Node } from "../types/graph.js";
import type { Context } from "../types/context.js";
import type { Outcome } from "../types/outcome.js";
import type { CodergenBackend, BackendRunOptions } from "../types/handler.js";
import { StageStatus, createOutcome } from "../types/outcome.js";
import { getStringAttr } from "../types/graph.js";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface OpenClawBackendConfig {
  /** Model alias: "default", "normal", "deep", "quick", "opus46", "gemini" */
  model?: string;
  /** Thinking level: "off", "minimal", "low", "medium", "high" */
  thinking?: string;
  /** Timeout in seconds for each agent turn. Default: 600 */
  timeoutSeconds?: number;
  /** Session id — reuse across nodes for context continuity */
  sessionId?: string;
  /** CLI command to invoke. Default: "openclaw" */
  command?: string;
  /** Agent id for session store resolution. Default: "main" */
  agentId?: string;
  /** OpenClaw state dir. Default: ~/.openclaw */
  stateDir?: string;
}

/**
 * Attractor backend that delegates to OpenClaw's `openclaw agent` CLI.
 * Uses the gateway's model routing (GitHub Copilot, etc.) — no separate API keys needed.
 */
export class OpenClawBackend implements CodergenBackend {
  private readonly config: OpenClawBackendConfig;

  constructor(config?: OpenClawBackendConfig) {
    this.config = config ?? {};
  }

  async run(
    node: Node,
    prompt: string,
    _context: Context,
    _options?: BackendRunOptions,
  ): Promise<string | Outcome> {
    // Determine model for this node: node attribute > config > undefined
    const nodeModel = getStringAttr(node.attributes, "model", "");
    const effectiveModel = nodeModel || this.config.model;

    // If node specifies its own model, use a unique session ID to avoid conflicts
    let sessionId = this.config.sessionId;
    if (nodeModel && sessionId) {
      sessionId = `${sessionId}-${node.id}`;
    }

    // Set per-session model override via the gateway's session store.
    // The openclaw agent CLI reads modelOverride from sessions.json to select
    // which model to use for inference. We patch it before spawning the agent.
    if (effectiveModel && sessionId) {
      try {
        this.patchSessionModel(sessionId, effectiveModel);
        console.log(`[OpenClaw] Node ${node.id}: model="${effectiveModel}", session="${sessionId}"`);
      } catch (err) {
        console.warn(`[OpenClaw] Failed to set model for ${node.id}: ${err}`);
      }
    }

    const args = ["agent", "--json", "--message", prompt];

    if (sessionId) {
      args.push("--session-id", sessionId);
    }

    if (this.config.thinking) {
      args.push("--thinking", this.config.thinking);
    }

    if (this.config.timeoutSeconds) {
      args.push("--timeout", String(this.config.timeoutSeconds));
    }

    const timeoutMs = (this.config.timeoutSeconds ?? 600) * 1000 + 5000; // extra 5s buffer

    return new Promise<string | Outcome>((resolve) => {
      const child = spawn(this.config.command ?? "openclaw", args, {
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve(
          createOutcome({
            status: StageStatus.FAIL,
            failureReason: `OpenClaw agent timed out after ${timeoutMs}ms`,
          }),
        );
      }, timeoutMs);

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        resolve(
          createOutcome({
            status: StageStatus.FAIL,
            failureReason: `OpenClaw agent spawn error: ${err.message}`,
          }),
        );
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        if (code !== 0) {
          resolve(
            createOutcome({
              status: StageStatus.FAIL,
              failureReason: `OpenClaw agent exited with code ${String(code)}${stderr ? ": " + stderr.slice(0, 1000) : ""}`,
            }),
          );
          return;
        }

        // Parse JSON output to extract the agent's reply
        try {
          const result = JSON.parse(stdout);
          if (result.status !== "ok") {
            resolve(
              createOutcome({
                status: StageStatus.FAIL,
                failureReason: `OpenClaw agent returned status: ${result.status}`,
              }),
            );
            return;
          }
          // Extract text from payloads array
          const payloads: Array<Record<string, unknown>> = result.result?.payloads || [];
          const texts = payloads
            .map((p: Record<string, unknown>) => p.text)
            .filter((t: unknown): t is string => typeof t === "string" && (t as string).length > 0);
          const fullResponse = texts.join("\n") || stdout;

          // Check for explicit failure/retry markers in agent output.
          // This enables Attractor's conditional edge routing (e.g. test -> implement
          // on outcome=fail) instead of always returning SUCCESS.
          const upperResponse = fullResponse.toUpperCase();
          if (upperResponse.includes("STAGE_FAILED")) {
            resolve(
              createOutcome({
                status: StageStatus.FAIL,
                failureReason: fullResponse.slice(0, 1000),
              }),
            );
            return;
          }
          if (upperResponse.includes("STAGE_RETRY")) {
            resolve(
              createOutcome({
                status: StageStatus.RETRY,
                failureReason: fullResponse.slice(0, 1000),
              }),
            );
            return;
          }

          resolve(fullResponse);
        } catch {
          // If not valid JSON, return raw stdout
          resolve(stdout);
        }
      });

      // Close stdin immediately (non-interactive)
      child.stdin.end();
    });
  }

  /**
   * Patch the OpenClaw session store to set modelOverride for a given session.
   *
   * The gateway stores session state in a JSON file at:
   *   <stateDir>/agents/<agentId>/sessions/sessions.json
   *
   * The `openclaw agent` CLI resolves sessions by matching the --session-id
   * value against sessionId fields in the store. When modelOverride is set
   * on a session entry, the gateway uses that model for inference.
   *
  /**
   * Patches the session store with modelOverride for the given session.
   * Uses synchronous FS reads/writes — safe given sequential pipeline execution,
   * but would race if stages were parallelized. Keep sequential unless adding file locking.
   *
   * This is the same mechanism used by the `session_status` tool and
   * `sessions_spawn` to set per-session models.
   */
  private patchSessionModel(sessionId: string, model: string): void {
    const stateDir = this.config.stateDir
      ?? process.env.OPENCLAW_STATE_DIR
      ?? join(process.env.HOME ?? "/root", ".openclaw");
    const agentId = this.config.agentId ?? "main";
    const storePath = join(stateDir, "agents", agentId, "sessions", "sessions.json");

    let store: Record<string, any> = {};
    try {
      store = JSON.parse(readFileSync(storePath, "utf-8"));
    } catch {
      // Store doesn't exist yet — we'll create it
      mkdirSync(dirname(storePath), { recursive: true });
    }

    // Find existing session entry by sessionId, or find by session key pattern
    let targetKey: string | undefined;
    for (const [key, entry] of Object.entries(store)) {
      if (entry?.sessionId === sessionId) {
        targetKey = key;
        break;
      }
    }

    if (targetKey) {
      // Patch existing entry
      store[targetKey] = {
        ...store[targetKey],
        modelOverride: model,
        updatedAt: Date.now(),
      };
    } else {
      // Create a minimal session entry so the agent picks up the model
      // The agent CLI will flesh it out on first run
      const key = `agent:${this.config.agentId ?? "main"}:cli:${sessionId}`;
      store[key] = {
        sessionId,
        modelOverride: model,
        updatedAt: Date.now(),
      };
    }

    writeFileSync(storePath, JSON.stringify(store), "utf-8");
  }
}
