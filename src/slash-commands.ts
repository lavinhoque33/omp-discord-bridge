import { ApplicationCommandOptionType, ApplicationCommandType, type Client, type RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import type { BridgeAvailableCommand, BridgeConfig } from "./types.js";

export const SLASH_CONTROL_COMMANDS = ["status", "stop", "new", "compact"] as const;
const DISCORD_TOP_LEVEL_COMMAND_LIMIT = 100;

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

export function isDiscordSafeCommandName(name: string): boolean {
  return /^[a-z0-9_-]{1,32}$/.test(name);
}

export function acpCommandNamespace(command: BridgeAvailableCommand): string | null {
  const colon = command.name.indexOf(":");
  if (colon <= 0) return null;
  const namespace = command.name.slice(0, colon);
  return isDiscordSafeCommandName(namespace) ? namespace : null;
}

export function discordCommandNameForAcpCommand(_config: BridgeConfig, command: BridgeAvailableCommand): string {
  return command.name;
}

function directAcpCommands(commands: BridgeAvailableCommand[]): BridgeAvailableCommand[] {
  return commands.filter((command) => !command.name.includes(":") && isDiscordSafeCommandName(command.name));
}

export function coreAcpCommands(commands: BridgeAvailableCommand[]): BridgeAvailableCommand[] {
  return directAcpCommands(commands);
}

function namespaceCommands(commands: BridgeAvailableCommand[]): string[] {
  return Array.from(new Set(commands.map(acpCommandNamespace).filter((namespace): namespace is string => Boolean(namespace)))).sort();
}

function acpInputOption(command: BridgeAvailableCommand): any {
  return {
    name: "input",
    description: truncate(command.inputHint ?? `Arguments for /${command.name}`, 100),
    type: ApplicationCommandOptionType.String,
    required: false,
  };
}

function namespaceRunnerOptions(namespace: string): any[] {
  return [
    {
      name: "command",
      description: truncate(`Command in the ${namespace} namespace`, 100),
      type: ApplicationCommandOptionType.String,
      required: true,
      autocomplete: true,
    },
    {
      name: "input",
      description: "Arguments for the selected OMP command",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
  ];
}

export function buildDiscordSlashCommands(config: BridgeConfig): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const { enabled, commandPrefix } = config.discord.slashCommands;
  if (!enabled) return [];

  const baseCommands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
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
  ];

  const used = new Set(baseCommands.map((command) => command.name));
  const acpCommands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [];
  for (const command of directAcpCommands(config.discord.slashCommands.acpCommands)) {
    if (used.has(command.name)) continue;
    used.add(command.name);
    acpCommands.push({
      name: command.name,
      description: truncate(command.description || `Run OMP /${command.name}`, 100),
      type: ApplicationCommandType.ChatInput,
      options: [acpInputOption(command)],
    });
  }

  for (const namespace of namespaceCommands(config.discord.slashCommands.acpCommands)) {
    if (used.has(namespace)) continue;
    used.add(namespace);
    acpCommands.push({
      name: namespace,
      description: truncate(`Run OMP ${namespace}:* commands`, 100),
      type: ApplicationCommandType.ChatInput,
      options: namespaceRunnerOptions(namespace),
    });
  }

  return [...baseCommands, ...acpCommands].slice(0, DISCORD_TOP_LEVEL_COMMAND_LIMIT);
}

export function resolveAcpSlashPrompt(config: BridgeConfig, commandName: string, getString: (name: string) => string | null): string | undefined {
  const direct = config.discord.slashCommands.acpCommands.find((command) => !command.name.includes(":") && command.name === commandName);
  if (direct) {
    const input = getString("input")?.trim() ?? "";
    return `/${direct.name}${input ? ` ${input}` : ""}`;
  }

  const namespaced = config.discord.slashCommands.acpCommands.filter((command) => acpCommandNamespace(command) === commandName);
  if (namespaced.length === 0) return undefined;
  const selected = getString("command")?.trim() ?? "";
  if (!selected) return undefined;
  const resolved = namespaced.find((command) => command.name === selected || command.name === `${commandName}:${selected}`);
  if (!resolved) return undefined;
  const input = getString("input")?.trim() ?? "";
  return `/${resolved.name}${input ? ` ${input}` : ""}`;
}

export function acpAutocompleteChoices(config: BridgeConfig, commandName: string, focused = ""): { name: string; value: string }[] {
  const normalizedFocused = focused.trim().toLowerCase();
  return config.discord.slashCommands.acpCommands
    .filter((command) => acpCommandNamespace(command) === commandName)
    .map((command) => command.name.slice(commandName.length + 1))
    .filter((suffix) => !normalizedFocused || suffix.toLowerCase().includes(normalizedFocused))
    .slice(0, 25)
    .map((suffix) => ({ name: suffix.slice(0, 100), value: suffix }));
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
