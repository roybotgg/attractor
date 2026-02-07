# Attractor v2 - Deferred Items

All items from v1 have been implemented in v2.

1. **HTTP Server Mode** (spec 9.5) - REST API, SSE events, web human gates -- DONE (`src/server/`)
2. **Full ManagerLoopHandler** (spec 4.11) - child pipeline spawning, telemetry, guard/steer -- DONE (`src/handlers/manager-loop.ts`)
3. **CLI Agent Backends** - Claude Code/Codex/Gemini subprocess management -- DONE (`src/backends/cli-backend.ts`, `claude-code-backend.ts`, `codex-backend.ts`, `gemini-backend.ts`)
4. **Context Fidelity Implementation** (spec 5.4) - full/truncate/compact/summary modes with template-based preamble -- DONE (`src/engine/fidelity.ts`)
5. **Tool Call Hooks** (spec 9.7) - pre/post shell hooks around LLM tool calls -- DONE (`src/engine/tool-hooks.ts`)
6. **Pipeline Composition** (spec 9.4) - sub-pipeline nodes, graph merging transform -- DONE (`src/handlers/sub-pipeline.ts`, `src/transforms/graph-merge.ts`)
7. **Artifact Store File Backing** (spec 5.5) - 100KB threshold disk storage -- DONE (`src/types/artifact.ts`)
8. **ConsoleInterviewer Robustness** - timeout, default answers, input validation, ANSI formatting -- DONE (`src/interviewer/console.ts`)
9. **loop_restart Edge Attribute** (spec 2.7, 3.2) - terminate and re-launch with fresh log dir -- DONE (`src/engine/runner.ts`)
10. **Parallel Handler Advanced Policies** - k_of_n, quorum, first_success join; fail_fast error; bounded parallelism -- DONE (`src/handlers/parallel.ts`, `src/types/parallel.ts`)
