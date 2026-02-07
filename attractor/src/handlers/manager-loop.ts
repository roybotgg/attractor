import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Handler } from "../types/handler.js";
import type { Node, Graph } from "../types/graph.js";
import type { Context } from "../types/context.js";
import type { Outcome } from "../types/outcome.js";
import { getStringAttr, getIntegerAttr } from "../types/graph.js";
import { StageStatus, createOutcome } from "../types/outcome.js";
import { evaluateCondition } from "../conditions/evaluator.js";
import type { Checkpoint } from "../types/checkpoint.js";

export type ChildProcess = {
  childLogsRoot: string;
  waitForCompletion: () => Promise<{ exitCode: number }>;
  kill: () => void;
};

export type ChildProcessSpawner = (
  dotFile: string,
  logsRoot: string,
) => ChildProcess;

function defaultSpawner(dotFile: string, logsRoot: string): ChildProcess {
  const childLogsRoot = join(logsRoot, "child");
  mkdirSync(childLogsRoot, { recursive: true });

  const proc = Bun.spawn(["bun", "run", dotFile], {
    cwd: logsRoot,
    env: { ...process.env, ATTRACTOR_LOGS_ROOT: childLogsRoot },
    stdout: "ignore",
    stderr: "ignore",
  });

  return {
    childLogsRoot,
    waitForCompletion: async () => {
      const exitCode = await proc.exited;
      return { exitCode };
    },
    kill: () => {
      proc.kill();
    },
  };
}

export interface ManagerLoopHandlerConfig {
  spawner?: ChildProcessSpawner;
}

export class ManagerLoopHandler implements Handler {
  private readonly spawner: ChildProcessSpawner;

  constructor(config: ManagerLoopHandlerConfig = {}) {
    this.spawner = config.spawner ?? defaultSpawner;
  }

  async execute(
    node: Node,
    context: Context,
    _graph: Graph,
    logsRoot: string,
  ): Promise<Outcome> {
    const dotFile = getStringAttr(node.attributes, "stack.child_dotfile");
    if (dotFile === "") {
      return createOutcome({
        status: StageStatus.FAIL,
        failureReason: `Node ${node.id}: missing stack.child_dotfile attribute`,
      });
    }

    const pollIntervalMs =
      getIntegerAttr(node.attributes, "manager.poll_interval", 45) * 1000;
    const maxCycles = getIntegerAttr(
      node.attributes,
      "manager.max_cycles",
      1000,
    );
    const stopCondition = getStringAttr(
      node.attributes,
      "manager.stop_condition",
    );
    const actionsStr = getStringAttr(
      node.attributes,
      "manager.actions",
      "observe,wait",
    );
    const actions = actionsStr.split(",").map((a) => a.trim());

    // Start child subprocess
    const child = this.spawner(dotFile, logsRoot);

    let childCompleted = false;
    let childExitCode = -1;

    // Start waiting for completion in the background
    void child.waitForCompletion().then((result) => {
      childCompleted = true;
      childExitCode = result.exitCode;
      return result;
    });

    try {
      // Observation loop
      let cycle = 0;
      while (cycle < maxCycles) {
        cycle++;

        // observe: read child checkpoint
        if (actions.includes("observe")) {
          const checkpointPath = join(
            child.childLogsRoot,
            "checkpoint.json",
          );
          if (existsSync(checkpointPath)) {
            try {
              const raw = readFileSync(checkpointPath, "utf-8");
              const checkpoint: unknown = JSON.parse(raw);
              if (isCheckpointLike(checkpoint)) {
                context.set(
                  "stack.child.status",
                  checkpoint.currentNode,
                );
                context.set(
                  "stack.child.completedNodes",
                  checkpoint.completedNodes.join(","),
                );
                context.set(
                  "stack.child.currentNode",
                  checkpoint.currentNode,
                );

                // Ingest child context values
                for (const [key, value] of Object.entries(
                  checkpoint.contextValues,
                )) {
                  context.set(`stack.child.context.${key}`, value);
                }
              }
            } catch {
              // Checkpoint read/parse failure is non-fatal
            }
          }
        }

        // steer: write intervention file
        if (actions.includes("steer")) {
          const interventionDir = child.childLogsRoot;
          mkdirSync(interventionDir, { recursive: true });
          const interventionPath = join(
            interventionDir,
            "intervention.json",
          );
          const intervention = {
            timestamp: new Date().toISOString(),
            cycle,
            source: node.id,
          };
          writeFileSync(
            interventionPath,
            JSON.stringify(intervention, null, 2),
            "utf-8",
          );
        }

        // evaluate stop condition
        if (stopCondition !== "") {
          const dummyOutcome = createOutcome({
            status: StageStatus.SUCCESS,
          });
          if (evaluateCondition(stopCondition, dummyOutcome, context)) {
            child.kill();
            return createOutcome({
              status: StageStatus.SUCCESS,
              notes: `Manager ${node.id}: stop condition met at cycle ${cycle}`,
            });
          }
        }

        // check if child completed or failed
        if (childCompleted) {
          if (childExitCode === 0) {
            return createOutcome({
              status: StageStatus.SUCCESS,
              notes: `Manager ${node.id}: child completed successfully`,
            });
          }
          return createOutcome({
            status: StageStatus.FAIL,
            failureReason: `Manager ${node.id}: child exited with code ${String(childExitCode)}`,
          });
        }

        // Check checkpoint for terminal state
        const checkpointPath = join(
          child.childLogsRoot,
          "checkpoint.json",
        );
        if (existsSync(checkpointPath)) {
          try {
            const raw = readFileSync(checkpointPath, "utf-8");
            const checkpoint: unknown = JSON.parse(raw);
            if (isCheckpointLike(checkpoint)) {
              const outcome = checkpoint.contextValues["outcome"];
              if (outcome === "fail") {
                child.kill();
                return createOutcome({
                  status: StageStatus.FAIL,
                  failureReason: `Manager ${node.id}: child pipeline failed`,
                });
              }
            }
          } catch {
            // non-fatal
          }
        }

        // wait
        if (actions.includes("wait")) {
          await new Promise((resolve) =>
            setTimeout(resolve, pollIntervalMs),
          );
        }
      }

      // max_cycles exceeded
      child.kill();
      return createOutcome({
        status: StageStatus.FAIL,
        failureReason: `Manager ${node.id}: max_cycles (${String(maxCycles)}) exceeded`,
      });
    } catch (err: unknown) {
      child.kill();
      const message = err instanceof Error ? err.message : String(err);
      return createOutcome({
        status: StageStatus.FAIL,
        failureReason: `Manager ${node.id}: unexpected error: ${message}`,
      });
    }
  }
}

function isCheckpointLike(
  data: unknown,
): data is Checkpoint {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj["currentNode"] === "string" &&
    Array.isArray(obj["completedNodes"]) &&
    typeof obj["contextValues"] === "object" &&
    obj["contextValues"] !== null
  );
}
