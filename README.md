# OMP Discord Hermes Bridge

A Hermes-style Discord gateway for [OMP / Oh My Pi](https://omp.sh/): mention a Discord bot in an allowed channel, get a dedicated thread, and keep that thread bound to one persistent OMP agent session.

## What is implemented

- Always-on Discord daemon (`omp-discord-bridge`) using `discord.js`.
- Mention-triggered thread creation from parent channels.
- One Discord thread ↔ one OMP session mapping persisted in SQLite (`node:sqlite`).
- Per-thread serial queues plus configurable global concurrency.
- OMP RPC-mode adapter that launches `omp --mode rpc` via Bun by default, with a legacy SDK adapter available through `omp.mode: sdk`.
- Thread controls: `status`, `/status`, `stop`, `/stop`, `new`, `/new`, `compact`, `/compact`.
- Message chunking under Discord limits.
- Conservative attachment prompt inclusion with max-byte policy.
- OMP extension entrypoint exposing setup/status command metadata for OMP to load.

Approval forwarding is intentionally out of scope per the project note.

## Requirements

- Node.js 24+ (uses built-in `node:sqlite`).
- Discord bot token with Message Content Intent enabled.
- OMP configured locally (`omp` auth/model setup already works in the same environment).

## Install / run

```bash
npm install
npm run build
cp examples/discord-bridge.yml ~/.omp/agent/discord-bridge.yml
DISCORD_BOT_TOKEN=... npx omp-discord-bridge --config ~/.omp/agent/discord-bridge.yml
```

Or after publishing/linking:

```bash
npm link
omp-discord-bridge --config ~/.omp/agent/discord-bridge.yml
```

## Config

See `examples/discord-bridge.yml`.

Secrets stay in env vars; config stores `tokenEnv`, guild/channel IDs, OMP mode/cwd/session root, and runtime limits. `omp.mode` defaults to `rpc`; set `omp.mode: sdk` only to use the legacy in-process SDK adapter.

## Testing

```bash
npm run check
```

Tests cover config validation, render chunking, SQLite mappings/queues, worker serialization/abort/new-session controls, and Discord event orchestration with fakes.
