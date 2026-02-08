export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number | null;
}

export interface GrepOptions {
  caseInsensitive?: boolean;
  globFilter?: string;
  maxResults?: number;
  outputMode?: "content" | "files_with_matches" | "count";
}

export interface ExecutionEnvironment {
  readFile(path: string, offset?: number, limit?: number): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  listDirectory(path: string, depth?: number): Promise<DirEntry[]>;
  execCommand(
    command: string,
    timeoutMs: number,
    workingDir?: string,
    envVars?: Record<string, string>,
    abortSignal?: AbortSignal,
  ): Promise<ExecResult>;
  grep(pattern: string, path: string, options?: GrepOptions): Promise<string>;
  glob(pattern: string, path?: string): Promise<string[]>;
  initialize(): Promise<void>;
  cleanup(): Promise<void>;
  workingDirectory(): string;
  platform(): string;
  osVersion(): string;
}
