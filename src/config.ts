import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type { BridgeConfig, GuildPolicy } from "./types.js";

export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

function asOptionalBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value == null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function asOptionalString(value: unknown, fallback: string, field: string): string {
  if (value == null) return fallback;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function normalizeAcpCommandMode(value: unknown): BridgeConfig["discord"]["slashCommands"]["acpCommandMode"] {
  if (value === "auto" || value === "core") return value;
  return "explicit";
}

function normalizeAcpCommands(value: unknown): BridgeConfig["discord"]["slashCommands"]["acpCommands"] {
  if (value == null) return [];
  if (value === "auto" || value === "core") return [];
  if (!Array.isArray(value)) throw new Error("discord.slashCommands.acpCommands must be an array");
  return value.map((command, index) => {
    if (!command || typeof command !== "object") throw new Error(`discord.slashCommands.acpCommands[${index}] must be an object`);
    const item = command as Record<string, unknown>;
    const name = asOptionalString(item.name, "", `discord.slashCommands.acpCommands[${index}].name`);
    if (!/^[a-z0-9_:-]{1,128}$/.test(name)) throw new Error(`discord.slashCommands.acpCommands[${index}].name must be 1-128 lowercase ACP command chars`);
    return {
      name,
      description: asOptionalString(item.description, `Run OMP /${name}`, `discord.slashCommands.acpCommands[${index}].description`),
      ...(typeof item.inputHint === "string" ? { inputHint: item.inputHint } : {}),
    };
  });
}

function normalizeSlashCommandPrefix(value: unknown): string {
  const commandPrefix = asOptionalString(value, "omp", "discord.slashCommands.commandPrefix");
  if (!/^[a-z0-9_-]{1,20}$/.test(commandPrefix)) {
    throw new Error("discord.slashCommands.commandPrefix must be 1-20 chars and contain only lowercase letters, numbers, hyphen, or underscore");
  }
  return commandPrefix;
}

export function normalizeConfig(raw: unknown): BridgeConfig {
  if (!raw || typeof raw !== "object") throw new Error("config must be an object");
  const data = raw as Record<string, any>;
  const discord = data.discord ?? {};
  const omp = data.omp ?? {};
  const runtime = data.runtime ?? {};
  const slashCommands = discord.slashCommands ?? {};
  const guildsRaw = discord.guilds;
  if (!Array.isArray(guildsRaw) || guildsRaw.length === 0) {
    throw new Error("discord.guilds must contain at least one guild policy");
  }
  const guilds: GuildPolicy[] = guildsRaw.map((guild: any, index: number) => {
    if (!guild?.id || typeof guild.id !== "string") throw new Error(`discord.guilds[${index}].id is required`);
    return {
      id: guild.id,
      allowedChannels: asStringArray(guild.allowedChannels, `discord.guilds[${index}].allowedChannels`),
      allowedUsers: asStringArray(guild.allowedUsers, `discord.guilds[${index}].allowedUsers`),
      requireMention: guild.requireMention ?? true,
      threadAutoArchiveMinutes: guild.threadAutoArchiveMinutes ?? 1440,
      ...(typeof guild.cwd === "string" ? { cwd: expandHome(guild.cwd) } : {}),
    };
  });
  const cfg: BridgeConfig = {
    discord: {
      tokenEnv: discord.tokenEnv ?? "DISCORD_BOT_TOKEN",
      guilds,
      slashCommands: {
        enabled: asOptionalBoolean(slashCommands.enabled, true, "discord.slashCommands.enabled"),
        syncOnStart: asOptionalBoolean(slashCommands.syncOnStart, true, "discord.slashCommands.syncOnStart"),
        commandPrefix: normalizeSlashCommandPrefix(slashCommands.commandPrefix),
        acpCommandMode: normalizeAcpCommandMode(slashCommands.acpCommands),
        acpCommands: normalizeAcpCommands(slashCommands.acpCommands),
      },
    },
    omp: {
      cwd: expandHome(omp.cwd ?? process.cwd()),
      sessionRoot: expandHome(omp.sessionRoot ?? "~/.omp/agent/discord-sessions"),
      model: omp.model ?? null,
      thinkingLevel: omp.thinkingLevel ?? null,
    },
    runtime: {
      databasePath: expandHome(runtime.databasePath ?? "~/.omp/agent/discord-bridge.sqlite"),
      maxConcurrency: runtime.maxConcurrency ?? 2,
      maxAttachmentBytes: runtime.maxAttachmentBytes ?? 25_000_000,
      responseMode: runtime.responseMode ?? "final-only",
      followupMode: runtime.followupMode ?? "steer",
      discordMessageLimit: runtime.discordMessageLimit ?? 1900,
    },
  };
  if (typeof cfg.discord.tokenEnv !== "string" || cfg.discord.tokenEnv.length === 0) throw new Error("discord.tokenEnv is required");
  if (!["steer", "queue"].includes(cfg.runtime.followupMode)) throw new Error("runtime.followupMode must be either steer or queue");
  if (omp.mode && omp.mode !== "acp") throw new Error("omp.mode has been removed; the bridge only supports ACP mode");
  if (!Number.isInteger(cfg.runtime.maxConcurrency) || cfg.runtime.maxConcurrency < 1) throw new Error("runtime.maxConcurrency must be >= 1");
  if (!Number.isInteger(cfg.runtime.maxAttachmentBytes) || cfg.runtime.maxAttachmentBytes < 0) throw new Error("runtime.maxAttachmentBytes must be >= 0");
  if (!Number.isInteger(cfg.runtime.discordMessageLimit) || cfg.runtime.discordMessageLimit < 100 || cfg.runtime.discordMessageLimit > 2000) {
    throw new Error("runtime.discordMessageLimit must be between 100 and 2000");
  }
  return cfg;
}

export function loadConfig(filePath: string): BridgeConfig {
  const text = fs.readFileSync(expandHome(filePath), "utf8");
  return normalizeConfig(YAML.parse(text));
}

export function findGuildPolicy(config: BridgeConfig, guildId: string): GuildPolicy | undefined {
  return config.discord.guilds.find((guild) => guild.id === guildId);
}
