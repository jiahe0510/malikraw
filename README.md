# malikraw-agent-core

Minimal agent runtime with:

- gateway server
- local TUI
- configurable onboarding flow
- workspace-backed agent prompt context
- channel-based gateway routing
- explicit message/media dispatch tool
- enhanced memory with Redis + Postgres

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
- model generation defaults are `temperature=0.2`, `contextWindow=32768`, `maxTokens=4096`
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

### Feishu Document Tools

When the current channel is Feishu and valid Feishu app credentials are configured, the runtime also registers:

- `read_feishu_doc`
- `update_feishu_doc`

`read_feishu_doc` reads a `docx` URL directly, or resolves a `wiki` URL to its backing `docx` document before reading.

`update_feishu_doc` updates Feishu `docx` content from markdown text.

- `mode: "replace"` clears the current document body and writes the new content
- `mode: "append"` keeps the current document body and appends the new content

Current limits:

- only `docx` is writable
- `wiki` is supported only when it points to a `docx`
- `sheet` and `bitable` are not supported yet

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

Enhanced memory is split across Redis and Postgres.

### What Redis Does

Redis stores session state:

- recent messages for a session
- current task state
- fast lookups during an active conversation

### What Postgres Does

Postgres stores two query-indexed tables:

- `memory_items`
  - each row stores a user query and a memory content block derived from that turn
  - retrieval uses the new user query to match similar past queries
  - the matched `content` is injected back into the prompt as user memory
- `memory_tool_chain`
  - each row stores a user query and the tool call chain used for that query
  - retrieval also uses the new user query to match similar past queries
  - the matched tool chains are injected into the prompt as reusable tool paths

This is the durable layer. It survives restarts and is used for cross-session recall.

### What pgvector Does

`pgvector` improves query matching for both tables.

Without `pgvector`:

- retrieval falls back to text matching on stored queries and content

With `pgvector`:

- user queries can be embedded
- the system can match semantically similar past queries instead of only keyword matches

If `pgvector` is unavailable, enhanced memory still works. You only lose vector similarity search.

### What The Model Gets

- recent local context from Redis-backed session state
- matched memory content from `memory_items`
- matched tool chains from `memory_tool_chain`

### Current Memory Compression

Current session-history compression now has two layers:

- gateway/session-store compaction
  - conservative fallback based on message count and char size
- runtime prompt compaction
  - provider-driven, based on estimated token budget and model context settings
  - uses `contextWindow`, `maxTokens`, and `compact.thresholdTokens`
  - only compresses prior conversation history
  - does not compress the system prompt

When runtime compaction triggers:

- it first tries a micro-compact pass on old large tool outputs
- if that is not enough, it builds a structured session handoff block and keeps the recent tail
- if that is still not enough, it falls back to a model-generated summary using `COMPACT.md`
- older history is compressed into a synthetic `user` message starting with `[compacted_history]`
- recent history is kept
- recent history is aligned to a `user` boundary
- compaction guidance is read from workspace `COMPACT.md` by default
- compacted information is also written into `memory_items`
- if embeddings are enabled, it is indexed by the query embedding for later retrieval
- if the model still returns a context-length error at runtime, malikraw performs one more reactive compact pass and retries automatically

This keeps the active prompt smaller without dropping older context completely.

The current system does not yet do:

- advanced forgetting
- reranking beyond the current retrieval order

## TUI

```bash
malikraw tui
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
