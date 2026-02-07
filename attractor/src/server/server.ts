import type { PipelineRunnerConfig } from "../engine/runner.js";
import type { RouteContext, PipelineRecord } from "./routes.js";
import { handleRequest } from "./routes.js";

export interface ServerConfig {
  port?: number;
  hostname?: string;
  runnerConfig: PipelineRunnerConfig;
}

export interface AttractorServer {
  start(): void;
  stop(): void;
  port: number;
  pipelines: Map<string, PipelineRecord>;
}

export function createServer(config: ServerConfig): AttractorServer {
  const pipelines = new Map<string, PipelineRecord>();
  const routeContext: RouteContext = {
    pipelines,
    runnerConfig: config.runnerConfig,
  };

  const server = Bun.serve({
    port: config.port ?? 0,
    hostname: config.hostname ?? "127.0.0.1",
    fetch(request: Request): Promise<Response> {
      return handleRequest(request, routeContext);
    },
  });

  return {
    start() {
      // Bun.serve starts automatically
    },
    stop() {
      server.stop();
    },
    get port() {
      return server.port ?? 0;
    },
    pipelines,
  };
}
