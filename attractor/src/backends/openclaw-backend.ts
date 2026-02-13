import type { Node } from "../types/graph.js";
import type { Context } from "../types/context.js";
import type { Outcome } from "../types/outcome.js";
import type { CodergenBackend, BackendRunOptions } from "../types/handler.js";
import { StageStatus, createOutcome } from "../types/outcome.js";
import { getStringAttr } from "../types/graph.js";
import { spawn } from "node:child_process";

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

    // Set model via environment variable (openclaw respects OPENCLAW_MODEL)
    const env = { ...process.env };
    if (effectiveModel) {
      env.OPENCLAW_MODEL = effectiveModel;
      console.log(`[OpenClaw] Node ${node.id}: using model="${effectiveModel}", session="${sessionId}"`);
    }

    return new Promise<string | Outcome>((resolve) => {
      const child = spawn(this.config.command ?? "openclaw", args, {
        env,
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
          const payloads = result.result?.payloads || [];
          const texts = payloads
            .map((p: any) => p.text)
            .filter((t: any) => typeof t === "string" && t.length > 0);
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
}
