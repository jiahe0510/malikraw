# malikraw-agent-core

Minimal agent runtime with:

- gateway server
- local TUI
- configurable onboarding flow
- workspace-backed agent prompt context
- channel-based gateway routing

## Requirements

- Node.js 20+
- npm

## Install

```bash
cd /Users/jiahezhao/malikraw
npm install
```

## Build

```bash
npm run build
```

## Onboard

Run the step-by-step setup wizard:

```bash
npm run build
npm run onboard
```

This writes config files under `~/.malikraw/config/`, including:

- `system.json`
- `providers.json`
- `agent-provider-mapping.json`
- `workspace.json`
- `agents.json`

## Start The Gateway

If you already have config saved from onboarding:

```bash
npm run build
npm start
```

The gateway listens on `127.0.0.1:<gatewayPort>`. Default port is `5050`.

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

## Run The TUI

```bash
npm run build
npm run tui
```

The TUI registers itself as the `tui` channel and keeps a local in-memory session.

## Run Tests

```bash
npm test
```

This runs:

```bash
npm run build
node --test dist/test/**/*.test.js
```

## Notes

- Default workspace path is `~/.malikraw/workspace`
- Default workspace prompt file is `~/.malikraw/workspace/AGENT.md`
- System prompt templates live in [`templates/system`](/Users/jiahezhao/malikraw/templates/system)
- Environment variables can still override saved config at runtime
