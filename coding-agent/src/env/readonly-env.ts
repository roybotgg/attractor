import type {
  ExecutionEnvironment,
  ExecResult,
  DirEntry,
  GrepOptions,
} from "../types/execution-env.js";

export class ReadOnlyExecutionEnvironment implements ExecutionEnvironment {
  private readonly inner: ExecutionEnvironment;

  constructor(inner: ExecutionEnvironment) {
    this.inner = inner;
  }

  readFile(path: string, offset?: number, limit?: number): Promise<string> {
    return this.inner.readFile(path, offset, limit);
  }

  async writeFile(_path: string, _content: string): Promise<void> {
    throw new Error("Write operations are disabled in read-only mode");
  }

  fileExists(path: string): Promise<boolean> {
    return this.inner.fileExists(path);
  }

  listDirectory(path: string, depth?: number): Promise<DirEntry[]> {
    return this.inner.listDirectory(path, depth);
  }

  execCommand(
    command: string,
    timeoutMs: number,
    workingDir?: string,
    envVars?: Record<string, string>,
    abortSignal?: AbortSignal,
  ): Promise<ExecResult> {
    return this.inner.execCommand(command, timeoutMs, workingDir, envVars, abortSignal);
  }

  grep(pattern: string, path: string, options?: GrepOptions): Promise<string> {
    return this.inner.grep(pattern, path, options);
  }

  glob(pattern: string, path?: string): Promise<string[]> {
    return this.inner.glob(pattern, path);
  }

  initialize(): Promise<void> {
    return this.inner.initialize();
  }

  cleanup(): Promise<void> {
    return this.inner.cleanup();
  }

  workingDirectory(): string {
    return this.inner.workingDirectory();
  }

  platform(): string {
    return this.inner.platform();
  }

  osVersion(): string {
    return this.inner.osVersion();
  }
}
