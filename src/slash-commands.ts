import { ApplicationCommandOptionType, ApplicationCommandType, type Client, type RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import type { BridgeAvailableCommand, BridgeConfig } from "./types.js";

export const SLASH_CONTROL_COMMANDS = ["status", "stop", "new", "compact"] as const;

export function discordCommandNameForAcpCommand(config: BridgeConfig, command: BridgeAvailableCommand): string {
  return `${config.discord.slashCommands.commandPrefix}-${command.name}`.slice(0, 32);
}

export function buildDiscordSlashCommands(config: BridgeConfig): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const { enabled, commandPrefix } = config.discord.slashCommands;
  if (!enabled) return [];

  return [
    {
      name: commandPrefix,
      description: "Send a prompt to OMP",
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          name: "prompt",
          description: "Prompt to send to OMP",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    ...SLASH_CONTROL_COMMANDS.map((command): RESTPostAPIChatInputApplicationCommandsJSONBody => ({
      name: `${commandPrefix}-${command}`,
      description: `Run OMP ${command}`,
      type: ApplicationCommandType.ChatInput,
      options: [],
    })),
    ...config.discord.slashCommands.acpCommands.map((command): RESTPostAPIChatInputApplicationCommandsJSONBody => ({
      name: discordCommandNameForAcpCommand(config, command),
      description: command.description.slice(0, 100),
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          name: "input",
          description: command.inputHint ?? `Arguments for /${command.name}`,
          type: ApplicationCommandOptionType.String,
          required: false,
        },
      ],
    })),
  ];
}

export async function syncDiscordSlashCommands(client: Client, config: BridgeConfig): Promise<void> {
  const { enabled, syncOnStart } = config.discord.slashCommands;
  if (!enabled || !syncOnStart) return;

  const commands = buildDiscordSlashCommands(config);
  if (commands.length === 0) {
    throw new Error("discord slash command sync is enabled but no commands were built");
  }

  for (const guildPolicy of config.discord.guilds) {
    const guild = await client.guilds.fetch(guildPolicy.id);
    await guild.commands.set(commands);
  }
}
