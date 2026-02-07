#!/usr/bin/env bun

import { createServer } from "../src/server/server.js";
import { createHandlerRegistry } from "../src/engine/runner.js";
import { StartHandler } from "../src/handlers/start.js";
import { ExitHandler } from "../src/handlers/exit.js";
import { CodergenHandler } from "../src/handlers/codergen.js";
import { ConditionalHandler } from "../src/handlers/conditional.js";

const port = parseInt(process.env["ATTRACTOR_PORT"] ?? "3000", 10);
const hostname = process.env["ATTRACTOR_HOST"] ?? "127.0.0.1";

const handlerRegistry = createHandlerRegistry();
handlerRegistry.register("start", new StartHandler());
handlerRegistry.register("exit", new ExitHandler());
handlerRegistry.register("codergen", new CodergenHandler());
handlerRegistry.register("conditional", new ConditionalHandler());

const server = createServer({
  port,
  hostname,
  runnerConfig: { handlerRegistry },
});

console.log(`Attractor server listening on http://${hostname}:${server.port}`);
