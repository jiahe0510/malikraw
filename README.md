# malikraw-agent-core

Minimal agent runtime with:

- gateway server
- local TUI
- configurable onboarding flow
- workspace-backed agent prompt context
- channel-based gateway routing
- explicit message/media dispatch tool
- enhanced memory with Redis + Postgres
- experimental A2A orchestration primitives for async root/step workflows

## Experimental A2A Orchestration

The repository now includes a minimal async orchestration layer under `src/a2a/`.

Current scope:

- `A2AOrchestrator` for root-task and step-task state transitions
- `StepWorkerRuntime` for dumb async workers that only execute assignments and emit events
- `InMemoryTaskStore` and `InMemoryEventBus` for single-process prototyping
- `FileArtifactStore` for durable large-result handoff via `outputRef`

This layer is intentionally separate from the synchronous `runtime.ask() -> runAgentLoop()` path. The intended model is:

- main agent acts as the only orchestrator
- sub-agents receive `step.assignment`
- workers emit `step.started`, `step.progress`, `step.completed`, `step.failed`
- orchestration decides whether to enqueue follow-up steps such as `A -> B`

When the gateway server starts, it now also exposes experimental task APIs:

- `POST /api/tasks`
- `POST /api/tasks/plan-and-run`
- `GET /api/tasks`
- `GET /api/tasks/:id`
- `GET /api/tasks/:id/steps`
- `GET /api/tasks/:id/events`

These APIs use:

- file-backed task store under `~/.malikraw/.runtime/a2a/`
- in-memory event bus
- one worker per configured agent id
- optional `agent-cards.json` for AI routing

No extra config file is required for the current prototype. The configured `agents[]` entries are reused as worker ids.
If `agent-cards.json` is present, the orchestrator uses it for task-kind routing and injects each assigned worker's own card into the worker prompt.

Example `agent-cards.json`:

```json
{
  "agents": [
    {
      "agentId": "main",
      "description": "Workflow orchestrator that plans and routes async tasks.",
      "taskKinds": ["route_tasks", "plan_workflow"],
      "capabilities": ["routing", "planning"]
    },
    {
      "agentId": "sub-a",
      "description": "Analyze repositories and identify implementation issues.",
      "taskKinds": ["analyze_repo", "inspect_codebase"],
      "capabilities": ["repo_scan", "code_analysis", "bug_finding"]
    },
    {
      "agentId": "sub-b",
      "description": "Summarize findings into concise user-facing reports.",
      "taskKinds": ["summarize_findings", "write_report"],
      "capabilities": ["summarization", "report_writing"]
    }
  ]
}
```

Minimal example:

```bash
curl -X POST http://127.0.0.1:5050/api/tasks \
  -H 'content-type: application/json' \
  -d '{
    "input": {
      "query": "Analyze this repo and produce a summary"
    },
    "workflow": {
      "transitions": [
        {
          "on": "analyze",
          "when": { "path": "needB", "equals": true },
          "createStep": {
            "stepName": "sub-b",
            "taskKind": "summarize_findings",
            "requiredCapabilities": ["report_writing"],
            "workflowNodeId": "summarize",
            "inputFromOutputPath": "payloadForB"
          }
        }
      ]
    },
    "initialStep": {
      "stepName": "sub-a",
      "agentId": "sub-a",
      "workflowNodeId": "analyze",
      "input": {
        "userRequest": "Analyze the repo. Return strict JSON with fields needB, payloadForB, and finalOutput when applicable."
      }
    }
  }'
```

Query status:

```bash
curl http://127.0.0.1:5050/api/tasks
curl http://127.0.0.1:5050/api/tasks/<rootTaskId>
curl http://127.0.0.1:5050/api/tasks/<rootTaskId>/steps
curl http://127.0.0.1:5050/api/tasks/<rootTaskId>/events
```

Natural-language planning example:

```bash
curl -X POST http://127.0.0.1:5050/api/tasks/plan-and-run \
  -H 'content-type: application/json' \
  -d '{
    "request": "Analyze the current repository, and if you find important issues, produce a concise final summary."
  }'
```

Task runtime files are stored under:

- `~/.malikraw/.runtime/a2a/roots/<rootTaskId>/root.json`
- `~/.malikraw/.runtime/a2a/roots/<rootTaskId>/steps/*.json`
- `~/.malikraw/.runtime/a2a/roots/<rootTaskId>/events.json`
- `~/.malikraw/.runtime/a2a/roots/<rootTaskId>/chain.ndjson`
- `~/.malikraw/.runtime/a2a/artifacts/...`

Worker step input currently accepts either:

- a plain string, treated as `userRequest`
- an object containing `userRequest` or `prompt`

If an agent returns valid JSON text, the worker stores it as structured output. Otherwise the raw text is used as the step output.

Routing rules:

- if `createStep.agentId` is present, that agent is used directly
- otherwise `createStep.taskKind` is required
- the router first scores candidate agent cards by `taskKinds` and `requiredCapabilities`
- if one candidate wins clearly, routing is rule-based
- if multiple candidates tie, the orchestrator asks the router model to choose from those candidate cards and return strict JSON

## Requirements

- Node.js 20+
- npm

## Install

```bash
cd malikraw
npm install
npm run build
npm link
```

After `npm link`, use the CLI directly:

```bash
malikraw onboard
malikraw start
malikraw stop
malikraw restart
malikraw status
malikraw tui
```

## Onboard

Run the step-by-step setup wizard:

```bash
malikraw onboard
```

This writes config files under `~/.malikraw/config/`, including:

- `system.json`
- `providers.json`
- `agent-provider-mapping.json`
- `workspace.json`
- `channels.json`
- `tools.json`
- `agents.json`
- `memory.json`

During onboarding, available skills are discovered from the repository `skills/` directory. The selected skill directories are copied into the workspace under `~/.malikraw/workspace/skills/`.

Current onboarding defaults:

- one agent only: `main`
- workspace is fixed to `~/.malikraw/workspace`
- model generation defaults are fixed to `temperature=0.2`, `maxTokens=4096`
- HTTP channel is disabled by default
- Feishu channel only requires `appId` and `appSecret`
- skills / tools / channels are selected with space-toggle prompts

## Service Commands

If you already have config saved from onboarding, the gateway runs as a background service:

```bash
malikraw start
malikraw stop
malikraw restart
malikraw status
```

The gateway listens on `127.0.0.1:<gatewayPort>`. Default port is `5050`.
Service metadata and logs are stored under `~/.malikraw/.runtime/service/`.

Health check:

```bash
curl http://127.0.0.1:5050/health
```

Example chat request:

```bash
curl -X POST http://127.0.0.1:5050/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"read the workspace status","channelId":"http","sessionId":"demo"}'
```

## Channels And Message Dispatch

The gateway owns routing. Channels only implement transport-specific send/receive behavior.

- inbound: `channel -> gateway -> agent runtime`
- outbound: `agent runtime -> gateway -> target channel`

Each conversation is keyed by:

```text
agentId:channelId:sessionId
```

The built-in `message` tool provides explicit outbound dispatch. It returns a structured message request, and the gateway routes it to the target channel by calling that channel's `sendMessage`.

Example tool intent:

```json
{
  "content": "Here is the chart",
  "media": [
    { "path": "artifacts/chart.png" }
  ]
}
```

This is important for Feishu. File/image sending no longer relies only on parsing natural-language replies. If `media` is present, the Feishu channel uses the structured media pipeline.

## Feishu Channel

Feishu supports:

- text replies
- markdown-style interactive cards
- image upload + send
- file upload + send

The Feishu channel now has two outbound paths:

- normal text/card output from the final assistant response
- structured `media[]` dispatch from the `message` tool or extracted tool results

For attachments, the channel uploads media first and then sends a message with the returned Feishu key.

## Built-in Tools

### Web Search Tool

The built-in `web_search` tool uses Brave Search API.

You can configure the Brave API key in `malikraw onboard`. The tool also falls back to:

```bash
export BRAVE_SEARCH_API_KEY=your_brave_api_key
```

The tool calls Brave's web search endpoint and returns compact results with `title`, `url`, and `description`.

### Message Tool

The built-in `message` tool lets the agent send a structured outbound message through the gateway.

Supported fields:

- `content`
- optional target overrides: `channelId`, `sessionId`, `agentId`, `userId`, `projectId`
- `media[]`

Each media item supports:

- `path`
- optional `kind`
- optional `fileName`
- optional `caption`

Media paths are resolved inside the workspace and validated before dispatch.

## Enhanced Memory

Enhanced memory is the current minimal long-running memory system. It is intentionally simple and is split across Redis and Postgres.

### What Redis Does

Redis stores short-lived session state:

- recent messages for a session
- current task state
- fast session lookups during ongoing conversations

This is the short-term layer. It is optimized for current conversation continuity, not long-term recall.

### What Postgres Does

Postgres stores long-lived memory:

- semantic memory
  - stable facts such as user preferences, project constraints, tech stack choices
- episodic memory
  - summaries of notable tasks, decisions, and outcomes

This is the durable layer. It survives restarts and is what allows cross-session recall.

### What pgvector Does

`pgvector` only improves episodic retrieval.

Without `pgvector`:

- episodic memory falls back to text matching

With `pgvector`:

- episodic summaries can be embedded
- user queries can be embedded
- the system retrieves semantically similar past episodes instead of only keyword matches

That means:

- Postgres gives you durable memory storage
- pgvector makes episodic recall smarter

If `pgvector` is unavailable, enhanced memory still works. You only lose vector similarity search for episodes.

### Why Redis + Postgres Improves Memory

This split keeps prompt quality and latency under control:

- Redis keeps the active session cheap and fast
- Postgres keeps important information durable
- pgvector improves finding relevant older episodes

So the model gets:

- recent local context from Redis-backed session state
- stable facts and prior episodes from Postgres
- better episodic recall if pgvector is enabled

### Current Memory Compression

Current session-history compression is intentionally conservative.

When session history grows too large:

- compaction triggers based on total history size
- older history is compressed into a synthetic `user` message starting with `[compacted_history]`
- recent history is kept
- recent history is aligned to a `user` boundary
- long-term recent history keeps only `user` / `assistant` messages
- `tool` messages are removed from recent history and folded into the compacted summary

This is designed to avoid prompt-template breakage in backends like LM Studio / Qwen while still preserving enough context for the next turn.

The current system does not yet do:

- advanced forgetting
- reflection memory
- procedural memory
- graph memory
- complex reranking

## TUI

```bash
malikraw tui
```

The TUI now supports A2A task commands in addition to chat:

```text
/task help
/task list
/task run <natural language>
/task get <rootTaskId>
/task steps <rootTaskId>
/task events <rootTaskId>
/task create <json>
```

The TUI registers itself as the `tui` channel and keeps a local in-memory session.

## Development

Build:

```bash
npm run build
```

Run tests:

```bash
npm test
```

## CI/CD

- CI runs on GitHub Actions for pushes to `main` and pull requests
- npm publish is handled by GitHub Actions on version tags like `v0.1.0`
- npm publishing requires an `NPM_TOKEN` repository secret with publish access

## Notes

- Default workspace path is `~/.malikraw/workspace`
- Default workspace prompt file is `~/.malikraw/workspace/AGENT.md`
- Default memory file is `~/.malikraw/workspace/MEMORY.md`
- Config files live under `~/.malikraw/config/`
- Bundled skills live under `skills/`
- System prompt templates live under `templates/system/`
