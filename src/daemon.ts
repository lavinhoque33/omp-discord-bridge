#!/usr/bin/env node
import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(modulePath) === fs.realpathSync(process.argv[1]);
  } catch {
    return path.resolve(modulePath) === path.resolve(process.argv[1]);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
    resumeSessionId: null,
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
    const handle = await withTimeout(factory.open(record), 15000, "ACP slash-command discovery startup");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const commands = await withTimeout(Promise.resolve(handle.availableCommands?.() ?? []), 2000, "ACP slash-command discovery");
      if (commands.length > 0) return commands;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return await withTimeout(Promise.resolve(handle.availableCommands?.() ?? []), 2000, "ACP slash-command discovery");
  } finally {
    factory.close?.();
  }
}

export async function hydrateAcpSlashCommands(config: BridgeConfig): Promise<void> {
  const mode = config.discord.slashCommands.acpCommandMode;
  if (mode === "explicit") return;
  let discovered: BridgeAvailableCommand[] = [];
  try {
    discovered = await discoverAcpCommands(config);
  } catch (error) {
    console.warn(`ACP slash-command discovery failed; continuing with no dynamic ACP commands: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  const recovered = store.recoverRunning();
  if (recovered > 0) console.warn(`Recovered ${recovered} in-flight OMP turn(s) after daemon restart.`);
  const messenger = new DiscordThreadMessenger(client);
  const omp: OmpSessionFactory = new AcpOmpSessionFactory();
  const runner = new ThreadQueueRunner({ store, omp, messenger, messageLimit: config.runtime.discordMessageLimit, maxConcurrency: config.runtime.maxConcurrency });
  client.on("error", (error) => console.error("discord client error", error));
  client.on("shardError", (error) => console.error("discord shard error", error));
  client.on("messageCreate", (message) => { void handleDiscordMessage({ config, store, runner }, message).catch((error) => console.error("message handling failed", error)); });
  client.on("interactionCreate", (interaction) => { void handleDiscordInteraction({ config, store, runner }, interaction).catch((error) => console.error("interaction handling failed", error)); });
  await client.login(token);
  await syncDiscordSlashCommands(client, config);
  for (const threadId of store.queuedThreadIds()) runner.poke(threadId);
  console.log(`OMP Discord bridge logged in as ${client.user?.tag ?? client.user?.id ?? "unknown bot"}`);
  let stopped = false;
  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await client.destroy();
      omp.close?.();
      store.close();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const configPath = arg("--config", process.env.OMP_DISCORD_BRIDGE_CONFIG ?? `${process.env.HOME}/.omp/agent/discord-bridge.yml`);
  if (!configPath) throw new Error("--config is required");
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let stopping = false;
  const stop = async (reason: string, exitCode: number) => {
    if (stopping) return;
    stopping = true;
    console.log(`OMP Discord bridge shutting down (${reason}).`);
    try {
      await daemon?.stop();
      process.exitCode = exitCode;
    } catch (error) {
      console.error("shutdown failed", error);
      process.exitCode = 1;
    } finally {
      process.exit();
    }
  };
  process.once("SIGINT", () => { void stop("SIGINT", 130); });
  process.once("SIGTERM", () => { void stop("SIGTERM", 143); });
  process.on("uncaughtException", (error) => {
    console.error("uncaught exception", error);
    void stop("uncaught exception", 1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("unhandled rejection", reason);
    void stop("unhandled rejection", 1);
  });
  startDaemon(configPath).then((started) => { daemon = started; }).catch((error) => {
    console.error("daemon startup failed", error);
    process.exitCode = 1;
  });
}
