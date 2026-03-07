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
- `agents.json`

During onboarding, available skills are discovered from the repository [`skills`](/Users/jiahezhao/malikraw/skills) directory. The selected skill directories are copied into the workspace under `~/.malikraw/workspace/skills/`.

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
- Config files live under `~/.malikraw/config/`
- Bundled skills live under [`skills`](/Users/jiahezhao/malikraw/skills)
- System prompt templates live in [`templates/system`](/Users/jiahezhao/malikraw/templates/system)
- Environment variables can still override saved config at runtime
