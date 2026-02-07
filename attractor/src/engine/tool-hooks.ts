import { spawn } from "node:child_process";
import { basename } from "node:path";

const HOOK_TIMEOUT_MS = 30_000;

export function executePreHook(
  command: string,
  toolName: string,
  args: Record<string, unknown>,
  stageDir: string,
  nodeId: string,
): Promise<{ proceed: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      env: {
        ...process.env,
        ATTRACTOR_TOOL_NAME: toolName,
        ATTRACTOR_STAGE_ID: basename(stageDir),
        ATTRACTOR_NODE_ID: nodeId,
      },
      stdio: ["pipe", "ignore", "ignore"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ proceed: false });
    }, HOOK_TIMEOUT_MS);

    child.on("error", () => {
      clearTimeout(timer);
      resolve({ proceed: false });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ proceed: code === 0 });
    });

    const payload = JSON.stringify({ tool: toolName, arguments: args });
    child.stdin.write(payload);
    child.stdin.end();
  });
}

export function executePostHook(
  command: string,
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  stageDir: string,
  nodeId: string,
): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      env: {
        ...process.env,
        ATTRACTOR_TOOL_NAME: toolName,
        ATTRACTOR_STAGE_ID: basename(stageDir),
        ATTRACTOR_NODE_ID: nodeId,
      },
      stdio: ["pipe", "ignore", "ignore"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, HOOK_TIMEOUT_MS);

    child.on("error", () => {
      clearTimeout(timer);
      resolve();
    });

    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });

    const payload = JSON.stringify({ tool: toolName, arguments: args, output });
    child.stdin.write(payload);
    child.stdin.end();
  });
}
