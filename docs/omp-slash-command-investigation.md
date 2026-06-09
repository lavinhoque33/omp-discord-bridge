# Investigation: exposing all OMP ACP commands as Discord slash commands

## Probe

A live ACP session against the installed `@oh-my-pi/pi-coding-agent` package advertised 146 available commands via ACP `available_commands_update`.

Breakdown by command namespace:

| Namespace | Count |
| --- | ---: |
| core/no namespace | 31 |
| `skill:` | 97 |
| `codex:` | 7 |
| `ralph-loop:` | 3 |
| `commit-commands:` | 3 |
| `posthog:` | 3 |
| `pr-review-toolkit:` | 1 |
| `claude-md-management:` | 1 |

Sample commands:

```text
model, fast, export, dump, share, browser, todo, session, jobs, usage,
changelog, tools, context, mcp, ssh, fresh, compact, shake, memory, rename,
move, marketplace, plugins, reload-plugins, force, green, review, commit,
gen-commit-msg, review-changes, init
```

## Discord constraints that matter

Discord application command payloads impose hard UX/API constraints:

- Top-level command names are limited to 1-32 lowercase command characters.
- Descriptions are limited to 1-100 characters.
- A bot is effectively capped at 100 top-level application commands per scope.
- Slash command choices/autocomplete responses return at most 25 visible choices at a time.
- Subcommands/subcommand groups also run into 25-option shape limits, so one giant grouped `/omp` command cannot directly contain 146 subcommands.

## Why “one Discord command per OMP command” does not fit

The current OMP ACP command surface cannot be mirrored one-to-one as top-level Discord slash commands:

- 146 OMP commands + existing bridge commands would require about 151 top-level commands, over Discord's 100-command cap.
- 115 OMP command names contain `:` (`skill:...`, `codex:...`, etc.), which is invalid in Discord slash command names.
- Sanitizing `:` to `-` still produces collisions/truncation problems. Example collision after Discord's 32-char cap: `skill:configuring-experiment-analytics` and `skill:configuring-experiment-rollout` both collapse toward `omp-skill-configuring-experiment...`.
- 88 descriptions exceed Discord's 100-character description limit.
- `skill:` alone has 97 commands, so it cannot fit into a single command's 25 subcommands either.

## Recommended implementation

Use a hybrid design:

1. Keep the existing specific bridge/control commands:
   - `/omp`
   - `/omp-status`
   - `/omp-stop`
   - `/omp-new`
   - `/omp-compact`

2. Auto-register safe core ACP commands as direct Discord commands without an `omp-` prefix:
   - `/model`, `/fast`, `/todo`, `/session`, etc.
   - These are the 31 no-namespace commands with Discord-safe names.
   - They can reuse the existing optional `input` string option.

3. Add namespace runners for every namespaced command family:
   - `/skill command:<autocomplete> input:<optional string>`
   - `/codex command:<autocomplete> input:<optional string>`
   - `/posthog command:<autocomplete> input:<optional string>`

   The `command` option should autocomplete against the full 146-command ACP list and send the selected ACP command as:

   ```text
   /<selected-command> <input>
   ```

   Examples:

   ```text
   /skill command:test-driven-development input:strictly TDD this feature
   /codex command:review input:current diff
   /todo input:list
   ```

4. Cache ACP command metadata at daemon startup and refresh periodically/on demand:
   - Current implementation can already open an ACP session and read `availableCommands()`.
   - Add a small command registry/cache in the daemon, not per interaction.
   - Sync Discord commands after ACP discovery, not before.

5. Do not set `guild.commands.set()` with a naive 146-command list; it will either exceed Discord limits or create invalid payloads.

## Optional next step

Implement `acpCommands: "auto" | "core" | explicit[]` config:

- `explicit[]`: current behavior.
- `core`: auto-register only safe core commands as direct slash commands.
- `auto`: register safe core direct commands plus namespace runners/autocomplete for every ACP command.

This gives the desired “all OMP commands invokable by Discord slash command” behavior without violating Discord API limits.
