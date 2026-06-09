# OMP Discord Hermes Bridge

A production-ready Discord gateway for [OMP / Oh My Pi](https://omp.sh/). Mention your bot in an allowed Discord channel and the bridge creates a dedicated thread backed by a persistent OMP agent session. Follow-up messages, slash commands, stop/status controls, and attachments all stay scoped to that thread.

The project is intentionally small: a Node.js daemon, a SQLite queue/store, Discord slash-command sync, and adapters for OMP RPC/ACP sessions.

## Highlights

- **Thread-per-session workflow** — one Discord thread maps to one persistent OMP session directory.
- **Mention-triggered session creation** — restrict startup to approved guilds, parent channels, and users.
- **Durable SQLite state** — sessions and queued turns survive daemon restarts.
- **Serialized per-thread queue** — multiple users can enqueue turns safely while global concurrency stays bounded.
- **Live OMP controls** — use `status`, `stop`, `new`, and `compact` inside managed threads, or slash-command equivalents.
- **Discord slash commands** — syncs `/omp`, `/omp-status`, `/omp-stop`, `/omp-new`, `/omp-compact`, and OMP ACP tools.
- **All ACP commands are invokable** — safe core ACP commands register directly (`/todo`, `/model`, `/tools`); namespaced commands use autocomplete runners (`/skill`, `/codex`, `/posthog`, etc.).
- **Configurable follow-ups** — either steer the currently running OMP turn or enqueue messages behind it.
- **Attachment context** — includes Discord attachment URLs in prompts up to a configurable byte limit.
- **Message chunking** — responses are split under Discord message limits.
- **OMP extension entrypoint** — package metadata exposes `dist/src/extension.js` for OMP to load.

Approval forwarding is intentionally out of scope: the ACP adapter currently auto-selects an allow option for headless operation.

## How it works

1. A user mentions the Discord bot in an allowed parent channel.
2. The daemon creates a thread named from the prompt.
3. The thread/session mapping is stored in SQLite.
4. Prompts from that thread are serialized through a per-thread queue.
5. The selected OMP adapter runs the prompt and streams the final response back to Discord.
6. Later thread messages continue the same OMP session until `new`, `stop`, or daemon cleanup.

## Slash-command model

Discord limits top-level application commands and disallows `:` in command names, while OMP ACP can expose many namespaced commands such as `skill:test-driven-development`. The bridge therefore uses a hybrid command model:

| OMP command shape | Discord command |
| --- | --- |
| `todo` | `/todo input:<args>` |
| `model` | `/model input:<args>` |
| `skill:test-driven-development` | `/skill command:test-driven-development input:<args>` |
| `codex:review` | `/codex command:review input:<args>` |

The daemon discovers OMP ACP commands at startup when `discord.slashCommands.acpCommands: auto` is enabled, then syncs the Discord command set for each configured guild.

Bridge/session commands remain prefixed to avoid collisions:

- `/omp prompt:<text>`
- `/omp-status`
- `/omp-stop`
- `/omp-new`
- `/omp-compact`

## Requirements

- Node.js **24+** (`node:sqlite` is used directly).
- Bun available on `PATH` for the default OMP RPC/ACP process launch.
- A Discord bot token.
- Discord bot settings:
  - Message Content Intent enabled.
  - OAuth scopes: `bot` and `applications.commands`.
  - Permissions to read/send messages, create threads, send messages in threads, and use slash commands.
- OMP configured locally in the same environment where the daemon runs.

## Installation

```bash
git clone https://github.com/CarterMcAlister/omp-discord-hermes-bridge.git
cd omp-discord-hermes-bridge
npm install
npm run build
```

Create a config file:

```bash
mkdir -p ~/.omp/agent
cp examples/discord-bridge.yml ~/.omp/agent/discord-bridge.yml
```

Edit the guild/channel IDs in `~/.omp/agent/discord-bridge.yml`, then provide the Discord token via the configured environment variable:

```bash
export DISCORD_BOT_TOKEN="..."
node dist/src/daemon.js --config ~/.omp/agent/discord-bridge.yml
```

After linking or package installation, you can use the binary:

```bash
npm link
omp-discord-bridge --config ~/.omp/agent/discord-bridge.yml
```

## Configuration

See [`examples/discord-bridge.yml`](examples/discord-bridge.yml) for a complete example.

```yaml
discord:
  tokenEnv: DISCORD_BOT_TOKEN
  slashCommands:
    enabled: true
    syncOnStart: true
    commandPrefix: omp
    acpCommands: auto
  guilds:
    - id: "123456789012345678"
      allowedChannels: ["234567890123456789"]
      allowedUsers: []
      requireMention: true
      threadAutoArchiveMinutes: 1440
omp:
  mode: rpc # rpc | acp | sdk
  cwd: "~/Developer"
  sessionRoot: "~/.omp/agent/discord-sessions"
  model: null
  thinkingLevel: medium
runtime:
  databasePath: "~/.omp/agent/discord-bridge.sqlite"
  maxConcurrency: 2
  maxAttachmentBytes: 25000000
  responseMode: edit-preview-then-final
  followupMode: steer # steer | queue
  discordMessageLimit: 1900
```

### Important settings

| Setting | Description |
| --- | --- |
| `discord.tokenEnv` | Environment variable containing the Discord bot token. |
| `discord.guilds[].allowedChannels` | Parent channels where mention-triggered sessions may start. Empty means any channel in the guild. |
| `discord.guilds[].allowedUsers` | User allowlist. Empty means any user in an allowed channel. |
| `discord.guilds[].requireMention` | Require a bot mention to start a new thread. |
| `discord.slashCommands.syncOnStart` | Replace guild slash commands with the generated command set on daemon startup. |
| `discord.slashCommands.acpCommands` | `auto`, `core`, or an explicit array of ACP command metadata. |
| `omp.mode` | `rpc` is the default process adapter; `acp` uses Agent Client Protocol; `sdk` is a legacy in-process adapter. |
| `omp.cwd` | Working directory used for OMP sessions. |
| `omp.sessionRoot` | Directory where per-thread OMP session directories are created. |
| `runtime.followupMode` | `steer` sends follow-ups into the running turn when possible; `queue` always queues. |
| `runtime.maxConcurrency` | Maximum number of threads with active OMP turns at once. |
| `runtime.discordMessageLimit` | Chunk size cap for outbound Discord messages. |

### Explicit ACP command list

If you do not want automatic discovery, provide explicit commands:

```yaml
discord:
  slashCommands:
    acpCommands:
      - name: todo
        description: Manage OMP todos
        inputHint: todo arguments
      - name: skill:test-driven-development
        description: Run the TDD skill
        inputHint: task description
```

## Discord setup checklist

1. Create a Discord application and bot in the Developer Portal.
2. Enable Message Content Intent for the bot.
3. Invite the bot with `bot` and `applications.commands` scopes.
4. Grant channel/thread permissions in the target guild.
5. Put guild and parent-channel IDs in the YAML config.
6. Start the daemon and confirm it logs in.
7. Mention the bot in an allowed parent channel to create a managed thread.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run check
```

`npm run check` runs typechecking, the Vitest suite, and a production build.

The test suite covers:

- config normalization and validation;
- Discord message/thread orchestration;
- slash-command generation and ACP namespace routing;
- SQLite session and queue persistence;
- queue serialization, stop/new-session controls, and response rendering;
- OMP RPC/ACP launch helpers and fake session behavior.

## Repository layout

```text
src/config.ts          YAML loading, defaults, validation
src/daemon.ts          daemon startup, Discord login, slash sync
src/discord.ts         Discord event handlers and permission checks
src/omp-session.ts     OMP RPC, ACP, SDK, and fake session adapters
src/queue.ts           per-thread queue runner and controls
src/render.ts          message chunking/thread-name rendering
src/slash-commands.ts  slash command generation/autocomplete/routing
src/store.ts           SQLite persistence
tests/                 Vitest coverage for the daemon pieces
examples/              sample YAML config
docs/                  design notes and investigations
```

## Operational notes

- Run the daemon under your preferred service manager for production use.
- Keep the bot token in an environment variable or secret manager; never store it in YAML.
- `syncOnStart: true` replaces the configured guild command set with the generated commands for this bot.
- If Discord command changes do not appear immediately, wait a few seconds and reload the Discord client.
- `node_modules/`, `dist/`, local databases, and env files are intentionally git-ignored.

## License

MIT — see [`LICENSE`](LICENSE).
