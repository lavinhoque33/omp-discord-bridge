import { ApplicationCommandOptionType, ApplicationCommandType } from "discord.js";
import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { buildDiscordSlashCommands } from "../src/slash-commands.js";

function bridgeConfig(discordOverrides: Record<string, unknown> = {}) {
  return normalizeConfig({ discord: { guilds: [{ id: "guild1" }], ...discordOverrides } });
}

describe("Discord slash commands", () => {
  it("builds guild chat-input commands from the default command prefix", () => {
    const commands = buildDiscordSlashCommands(bridgeConfig());

    expect(commands.map((command) => command.name)).toEqual(["omp", "omp-status", "omp-stop", "omp-new", "omp-compact"]);
    expect(commands).toHaveLength(5);
    expect(commands.every((command) => command.type === ApplicationCommandType.ChatInput)).toBe(true);
  });

  it("requires a string prompt option on the prompt command", () => {
    const commands = buildDiscordSlashCommands(bridgeConfig());
    const promptCommand = commands.find((command) => command.name === "omp");

    expect(promptCommand).toBeDefined();
    expect(promptCommand?.options).toEqual([
      expect.objectContaining({
        name: "prompt",
        type: ApplicationCommandOptionType.String,
        required: true,
      }),
    ]);
  });

  it("does not add options to control commands", () => {
    const commands = buildDiscordSlashCommands(bridgeConfig());

    for (const command of commands.filter((item) => item.name !== "omp")) {
      expect(command.options ?? []).toEqual([]);
    }
  });

  it("builds Discord-safe ACP commands directly without the OMP prefix", () => {
    const commands = buildDiscordSlashCommands(bridgeConfig({ slashCommands: { acpCommands: [{ name: "todo", description: "Manage todos", inputHint: "todo args" }] } }));
    const acp = commands.find((command) => command.name === "todo");

    expect(commands.some((command) => command.name === "omp-todo")).toBe(false);
    expect(acp).toMatchObject({ description: "Manage todos", type: ApplicationCommandType.ChatInput });
    expect(acp?.options).toEqual([expect.objectContaining({ name: "input", type: ApplicationCommandOptionType.String, required: false })]);
  });

  it("builds namespace runner slash commands for colon ACP commands", () => {
    const commands = buildDiscordSlashCommands(bridgeConfig({ slashCommands: { acpCommands: [
      { name: "skill:test-driven-development", description: "TDD", inputHint: "arguments" },
      { name: "codex:review", description: "Review with Codex", inputHint: "arguments" },
    ] } }));
    const skill = commands.find((command) => command.name === "skill");
    const codex = commands.find((command) => command.name === "codex");

    expect(skill?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "command", type: ApplicationCommandOptionType.String, required: true, autocomplete: true }),
      expect.objectContaining({ name: "input", type: ApplicationCommandOptionType.String, required: false }),
    ]));
    expect(codex?.options).toEqual(expect.arrayContaining([expect.objectContaining({ name: "command", autocomplete: true })]));
  });

  it("caps generated commands to Discord's top-level command budget", () => {
    const acpCommands = Array.from({ length: 120 }, (_, i) => ({ name: `cmd-${i}`, description: `Command ${i}` }));
    const commands = buildDiscordSlashCommands(bridgeConfig({ slashCommands: { acpCommands } }));

    expect(commands.length).toBeLessThanOrEqual(100);
  });

  it("returns no commands when slash commands are disabled", () => {
    const commands = buildDiscordSlashCommands(bridgeConfig({ slashCommands: { enabled: false } }));

    expect(commands).toEqual([]);
  });
});
