#!/usr/bin/env node
import process from "node:process";
import { loadConfig } from "./config.js";
import { BridgeStore } from "./store.js";
import { ThreadQueueRunner } from "./queue.js";
import { SdkOmpSessionFactory } from "./omp-session.js";
import { createDiscordClient, DiscordThreadMessenger, handleDiscordMessage } from "./discord.js";

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

export async function startDaemon(configPath: string): Promise<{ stop(): Promise<void> }> {
  const config = loadConfig(configPath);
  const token = process.env[config.discord.tokenEnv];
  if (!token) throw new Error(`Missing Discord token env var ${config.discord.tokenEnv}`);
  const client = createDiscordClient();
  const store = new BridgeStore(config.runtime.databasePath);
  store.recoverRunning();
  const messenger = new DiscordThreadMessenger(client);
  const runner = new ThreadQueueRunner({ store, omp: new SdkOmpSessionFactory(), messenger, messageLimit: config.runtime.discordMessageLimit, maxConcurrency: config.runtime.maxConcurrency });
  client.on("messageCreate", (message) => { void handleDiscordMessage({ config, store, runner }, message).catch((error) => console.error("message handling failed", error)); });
  await client.login(token);
  console.log(`OMP Discord bridge logged in as ${client.user?.tag ?? client.user?.id ?? "unknown bot"}`);
  return { stop: async () => { await client.destroy(); store.close(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const configPath = arg("--config", process.env.OMP_DISCORD_BRIDGE_CONFIG ?? `${process.env.HOME}/.omp/agent/discord-bridge.yml`);
  if (!configPath) throw new Error("--config is required");
  startDaemon(configPath).catch((error) => { console.error(error); process.exitCode = 1; });
}
