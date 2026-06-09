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

  it("builds configured ACP commands as Discord slash commands", () => {
    const commands = buildDiscordSlashCommands(bridgeConfig({ slashCommands: { acpCommands: [{ name: "todo", description: "Manage todos", inputHint: "todo args" }] } }));
    const acp = commands.find((command) => command.name === "omp-todo");

    expect(acp).toMatchObject({ description: "Manage todos", type: ApplicationCommandType.ChatInput });
    expect(acp?.options).toEqual([expect.objectContaining({ name: "input", type: ApplicationCommandOptionType.String, required: false })]);
  });

  it("returns no commands when slash commands are disabled", () => {
    const commands = buildDiscordSlashCommands(bridgeConfig({ slashCommands: { enabled: false } }));

    expect(commands).toEqual([]);
  });
});
