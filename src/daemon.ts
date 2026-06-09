#!/usr/bin/env node
import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { BridgeStore } from "./store.js";
import { ThreadQueueRunner } from "./queue.js";
import { AcpOmpSessionFactory } from "./omp-session.js";
import { createDiscordClient, DiscordThreadMessenger, handleDiscordInteraction, handleDiscordMessage } from "./discord.js";
import { coreAcpCommands, syncDiscordSlashCommands } from "./slash-commands.js";
import type { BridgeAvailableCommand, BridgeConfig, DiscordSessionRecord, OmpSessionFactory } from "./types.js";

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

async function discoverAcpCommands(config: BridgeConfig): Promise<BridgeAvailableCommand[]> {
  const discoverySessionDir = path.join(config.omp.sessionRoot, ".slash-command-discovery");
  fs.mkdirSync(discoverySessionDir, { recursive: true });
  const now = new Date().toISOString();
  const record: DiscordSessionRecord = {
    threadId: "slash-command-discovery",
    guildId: "discord-bridge",
    parentChannelId: "discord-bridge",
    triggerMessageId: "slash-command-discovery",
    sessionFile: null,
    sessionDir: discoverySessionDir,
    cwd: config.omp.cwd,
    model: config.omp.model,
    thinkingLevel: config.omp.thinkingLevel,
    createdByUserId: "discord-bridge",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const factory = new AcpOmpSessionFactory();
  try {
    const handle = await factory.open(record);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const commands = await handle.availableCommands?.() ?? [];
      if (commands.length > 0) return commands;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return await handle.availableCommands?.() ?? [];
  } finally {
    factory.close?.();
  }
}

export async function hydrateAcpSlashCommands(config: BridgeConfig): Promise<void> {
  const mode = config.discord.slashCommands.acpCommandMode;
  if (mode === "explicit") return;
  const discovered = await discoverAcpCommands(config);
  config.discord.slashCommands.acpCommands = mode === "core" ? coreAcpCommands(discovered) : discovered;
  console.log(`Discovered ${discovered.length} OMP ACP commands; registering ${config.discord.slashCommands.acpCommands.length} according to ${mode} slash mode.`);
}

export async function startDaemon(configPath: string): Promise<{ stop(): Promise<void> }> {
  const config = loadConfig(configPath);
  await hydrateAcpSlashCommands(config);
  const token = process.env[config.discord.tokenEnv];
  if (!token) throw new Error(`Missing Discord token env var ${config.discord.tokenEnv}`);
  const client = createDiscordClient();
  const store = new BridgeStore(config.runtime.databasePath);
  store.recoverRunning();
  const messenger = new DiscordThreadMessenger(client);
  const omp: OmpSessionFactory = new AcpOmpSessionFactory();
  const runner = new ThreadQueueRunner({ store, omp, messenger, messageLimit: config.runtime.discordMessageLimit, maxConcurrency: config.runtime.maxConcurrency });
  client.on("messageCreate", (message) => { void handleDiscordMessage({ config, store, runner }, message).catch((error) => console.error("message handling failed", error)); });
  client.on("interactionCreate", (interaction) => { void handleDiscordInteraction({ config, store, runner }, interaction).catch((error) => console.error("interaction handling failed", error)); });
  await client.login(token);
  await syncDiscordSlashCommands(client, config);
  for (const threadId of store.queuedThreadIds()) runner.poke(threadId);
  console.log(`OMP Discord bridge logged in as ${client.user?.tag ?? client.user?.id ?? "unknown bot"}`);
  return { stop: async () => { await client.destroy(); omp.close?.(); store.close(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const configPath = arg("--config", process.env.OMP_DISCORD_BRIDGE_CONFIG ?? `${process.env.HOME}/.omp/agent/discord-bridge.yml`);
  if (!configPath) throw new Error("--config is required");
  startDaemon(configPath).catch((error) => { console.error(error); process.exitCode = 1; });
}
