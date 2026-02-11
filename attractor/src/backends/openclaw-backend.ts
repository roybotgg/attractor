import type { Node } from "../types/graph.js";
import type { Context } from "../types/context.js";
import type { Outcome } from "../types/outcome.js";
import type { CodergenBackend, BackendRunOptions } from "../types/handler.js";
import { StageStatus, createOutcome } from "../types/outcome.js";
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
    const args = ["agent", "--json", "--message", prompt];

    if (this.config.model) {
      // Use session-id to set model via the gateway
      // The model is set per-session, so we pass it as part of the session
    }

    if (this.config.sessionId) {
      args.push("--session-id", this.config.sessionId);
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
          const payloads = result.result?.payloads || [];
          const texts = payloads
            .map((p: any) => p.text)
            .filter((t: any) => typeof t === "string" && t.length > 0);
          resolve(texts.join("\n") || stdout);
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
