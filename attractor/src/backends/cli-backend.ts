import { spawn } from "node:child_process";
import type { Node } from "../types/graph.js";
import type { Context } from "../types/context.js";
import type { Outcome } from "../types/outcome.js";
import type { CodergenBackend, BackendRunOptions } from "../types/handler.js";
import { StageStatus, createOutcome } from "../types/outcome.js";

export interface CliAgentConfig {
  /** The CLI command to invoke (e.g. "claude", "codex", "gemini") */
  command: string;
  /** Default arguments appended to every invocation */
  defaultArgs?: string[];
  /** Environment variables to set for the subprocess */
  env?: Record<string, string>;
  /** Timeout in milliseconds. Default: 300_000 (5 min) */
  timeoutMs?: number;
}

/**
 * Abstract base for CLI-agent backends that spawn a subprocess,
 * pass a prompt via stdin, and collect stdout as the response.
 */
export abstract class CliAgentBackend implements CodergenBackend {
  protected readonly config: CliAgentConfig;

  constructor(config: CliAgentConfig) {
    this.config = config;
  }

  /** Subclasses override to build CLI-specific argument lists. */
  protected abstract buildArgs(
    prompt: string,
    node: Node,
    options?: BackendRunOptions,
  ): string[];

  async run(
    node: Node,
    prompt: string,
    _context: Context,
    options?: BackendRunOptions,
  ): Promise<string | Outcome> {
    const args = this.buildArgs(prompt, node, options);
    const timeoutMs = this.config.timeoutMs ?? 300_000;

    return new Promise<string | Outcome>((resolve) => {
      const child = spawn(this.config.command, args, {
        env: { ...process.env, ...this.config.env },
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
            failureReason: `CLI agent timed out after ${timeoutMs}ms`,
          }),
        );
      }, timeoutMs);

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        resolve(
          createOutcome({
            status: StageStatus.FAIL,
            failureReason: `CLI agent spawn error: ${err.message}`,
          }),
        );
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        if (code !== 0) {
          resolve(
            createOutcome({
              status: StageStatus.FAIL,
              failureReason: `CLI agent exited with code ${String(code)}${stderr ? ": " + stderr.slice(0, 500) : ""}`,
            }),
          );
          return;
        }
        resolve(stdout);
      });

      // Send prompt via stdin
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
