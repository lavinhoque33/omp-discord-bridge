# OMP Discord Bridge

A production-ready Discord gateway for [OMP / Oh My Pi](https://omp.sh/). Mention your bot in an allowed Discord channel and the bridge creates a dedicated thread backed by a persistent OMP agent session. Follow-up messages, slash commands, stop/status controls, and attachments all stay scoped to that thread.

The project is intentionally small: a Node.js daemon, a SQLite queue/store, Discord slash-command sync, and an ACP-only OMP session adapter.

## Highlights

- **Thread-per-session workflow** — one Discord thread maps to one persistent OMP session directory.
- **Mention-triggered session creation** — restrict startup to approved guilds, parent channels, and users.
- **Durable SQLite state** — sessions and queued turns survive daemon restarts.
- **Serialized per-thread queue** — multiple users can enqueue turns safely while global concurrency stays bounded.
- **Live OMP controls** — use `status`, `stop`, `new`, and `compact` inside managed threads, or slash-command equivalents.
- **Session history threads** — `/sessions` in a project channel lists the OMP sessions recorded for that directory and opens a thread bound to the one you pick, so Discord continues the original session file.
- **Shared live sessions with your terminal** — while an omp TUI has a thread's session open, the thread joins it over omp's collab protocol: prompts from Discord run in the TUI's own session and everything the TUI does shows up in the thread.
- **Live rendering** — agent text streams into its own message (edited as it grows) and every tool call gets a message that flips from 🔧 to ✅/❌ with an output tail.
- **Discord slash commands** — syncs `/sessions`, `/omp`, `/omp-status`, `/omp-stop`, `/omp-new`, `/omp-compact`, and OMP ACP tools.
- **All ACP commands are invokable** — safe core ACP commands register directly (`/todo`, `/model`, `/tools`); namespaced commands use autocomplete runners (`/skill`, `/codex`, `/posthog`, etc.).
- **Configurable follow-ups** — either steer the currently running OMP turn or enqueue messages behind it.
- **Attachment context** — includes Discord attachment URLs in prompts up to a configurable byte limit.
- **Message chunking** — long blocks are split under Discord message limits.
- **OMP extension entrypoint** — package metadata exposes `dist/src/extension.js` for OMP to load.

Approval forwarding is intentionally out of scope: the ACP adapter currently auto-selects an allow option for headless operation.

## How it works

1. A user mentions the Discord bot in an allowed parent channel.
2. The daemon creates a thread named from the prompt.
3. The thread/session mapping is stored in SQLite.
4. Prompts from that thread are serialized through a per-thread queue.
5. The OMP ACP adapter runs the prompt and streams text and tool calls into the thread as they happen.
6. Later thread messages continue the same OMP session until `new`, `stop`, or daemon cleanup.

### Continuing an existing OMP session

Inside a channel that maps to a project directory (a `discord_sessions` row keyed by the channel id):

- `/sessions` — lists the OMP sessions recorded for that channel's `cwd` and posts a select menu (newest first, up to 25). A plain `sessions` message does the same.
- `open <id-prefix>` / `resume <id-prefix>` — opens the thread directly; the reference matches a session id prefix, any id substring, or part of the title.

Picking a session creates a thread whose record stores the chosen id in `resume_session_id`. The first message in that thread resumes the session over ACP (`session/resume`) instead of starting a new one, so the original session file keeps its history — and stays usable from the terminal. `new` in that thread clears the binding and starts a fresh session.

Opening a session also replays it: the bridge posts the most recent user/assistant messages into the new thread (last 20 entries, capped at 8000 characters, thinking and tool calls omitted — the header reports how many tool calls were skipped), so the Discord thread shows what was already said. The history comes from the live terminal session when one is attached, otherwise from ACP `session/load`.

Only one thread follows a session: opening the same session again retires the older thread (it points to the new one and refuses further prompts), so there is never a second writer.

### Live sessions with your terminal

omp processes do not share memory, so a TUI and a background ACP process writing the same session file each keep their own branch. The bridge avoids that by joining the TUI instead, as a writable guest over omp's `/collab` protocol, through a relay embedded in the daemon (`ws://127.0.0.1:7466`, nothing leaves the machine).

One-time setup on the machine running the daemon:

```bash
omp config set collab.autoStart control
omp config set collab.relayUrl ws://127.0.0.1:7466
```

TUIs started before this need a restart. From then on:

- While a TUI has the session open, the thread is attached to it (the thread says so). Messages from Discord run inside the TUI's session — queued behind or steered into whatever it is doing — and prompts typed in the terminal appear in the thread quoted as **🖥️ terminal**, followed by the streamed reply and tool calls.
- When the TUI closes or switches sessions, the thread detaches and later messages continue the session in a background ACP process, reloaded from the session file.
- If a TUI hosts the session but the bridge cannot join it, the turn fails with the reason instead of falling back to a background process, which would fork the session.
- Questions omp asks in the TUI (selectors, confirmations) are announced in the thread; answer them in the terminal.

The bridge finds hosts through `omp collab list` and watches `~/.omp/run/collab-hosts` for changes.

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
- OMP available as `omp` on `PATH` (or set `OMP_CLI_PATH` to the executable).
- A Discord bot token.
- Discord bot settings:
  - Message Content Intent enabled.
  - OAuth scopes: `bot` and `applications.commands`.
  - Permissions to read/send messages, create threads, send messages in threads, and use slash commands.
- OMP configured locally in the same environment where the daemon runs.

## Installation

```bash
git clone https://github.com/CarterMcAlister/omp-discord-bridge.git
cd omp-discord-bridge
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
  cwd: "~/Developer"
  sessionRoot: "~/.omp/agent/discord-sessions"
  model: null
  thinkingLevel: medium
runtime:
  databasePath: "~/.omp/agent/discord-bridge.sqlite"
  maxConcurrency: 2
  maxAttachmentBytes: 25000000
  followupMode: steer # steer | queue
  discordMessageLimit: 1900
collab:
  enabled: true
  relayPort: 7466
  displayName: discord
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
| `omp.cwd` | Working directory used for OMP sessions. |
| `omp.sessionRoot` | Directory where per-thread OMP session directories are created. |
| `runtime.followupMode` | `steer` sends follow-ups into the running turn when possible; `queue` always queues. |
| `runtime.maxConcurrency` | Maximum number of threads with active OMP turns at once. |
| `runtime.discordMessageLimit` | Chunk size cap for outbound Discord messages. |
| `collab.enabled` | Join omp TUIs hosting a thread's session and run the embedded relay (default `true`). |
| `collab.relayPort` | Port of the embedded relay on 127.0.0.1 (default `7466`); omp's `collab.relayUrl` must point at it. |
| `collab.displayName` | Name the bridge uses in the collab room (default `discord`). |

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
- live rendering (post-then-edit blocks, coalescing, chunking) and ACP update translation;
- the collab relay and guest end to end against a fake omp host, link parsing, and transcript extraction;
- OMP ACP launch helpers and fake session behavior.

## Repository layout

```text
src/collab.ts          omp collab guest: link parsing, encryption, joined TUI sessions
src/config.ts          YAML loading, defaults, validation
src/daemon.ts          daemon startup, Discord login, slash sync
src/discord.ts         Discord event handlers and permission checks
src/live.ts            live rendering of text/tool blocks into threads
src/omp-session.ts     OMP ACP and fake session adapters
src/queue.ts           per-thread queue runner and controls
src/relay.ts           embedded collab relay
src/render.ts          message chunking/thread-name rendering
src/router.ts          routes threads to a live TUI (collab) or a background ACP process
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
