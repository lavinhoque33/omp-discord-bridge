import { ChannelType, Client, GatewayIntentBits, Partials, type Message } from "discord.js";
import fs from "node:fs";
import path from "node:path";
import type { BridgeConfig, GuildPolicy } from "./types.js";
import type { BridgeStore } from "./store.js";
import { findGuildPolicy } from "./config.js";
import { slugifyThreadName, stripBotMention } from "./render.js";
import { parseThreadCommand, type ThreadQueueRunner } from "./queue.js";

export class DiscordThreadMessenger {
  constructor(private client: Client) {}
  async send(threadId: string, content: string): Promise<void> {
    const channel = await this.client.channels.fetch(threadId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) throw new Error(`thread ${threadId} is not sendable`);
    await channel.send({ content });
  }
  async typing(threadId: string): Promise<void> {
    const channel = await this.client.channels.fetch(threadId);
    if (channel?.isTextBased() && "sendTyping" in channel) await channel.sendTyping();
  }
}

function isAllowed(policy: GuildPolicy, message: Message): boolean {
  if (policy.allowedChannels.length > 0 && !policy.allowedChannels.includes(message.channelId)) return false;
  if (policy.allowedUsers.length > 0 && !policy.allowedUsers.includes(message.author.id)) return false;
  return true;
}

function attachmentSummaries(message: Message, maxBytes: number): { name: string; url: string; size: number; contentType?: string }[] {
  return [...message.attachments.values()].filter((att) => att.size <= maxBytes).map((att) => ({
    name: att.name ?? att.id,
    url: att.url,
    size: att.size,
    ...(att.contentType ? { contentType: att.contentType } : {}),
  }));
}

function promptWithAttachments(content: string, attachments: { name: string; url: string; size: number; contentType?: string }[]): string {
  if (attachments.length === 0) return content;
  const lines = attachments.map((a) => `- ${a.name} (${a.contentType ?? "unknown"}, ${a.size} bytes): ${a.url}`);
  return `${content}\n\nAttachments:\n${lines.join("\n")}`;
}

export async function handleDiscordMessage(deps: { config: BridgeConfig; store: BridgeStore; runner: ThreadQueueRunner }, message: Message): Promise<void> {
  if (message.author.bot || !message.guildId) return;
  const botId = message.client.user?.id;
  if (!botId) return;
  const existing = deps.store.getSession(message.channelId);
  if (existing) {
    const command = parseThreadCommand(message.content);
    if (command === "status") return deps.runner.status(message.channelId);
    if (command === "stop") return deps.runner.stop(message.channelId);
    if (command === "new") return deps.runner.newSession(message.channelId);
    if (command === "compact") return deps.runner.compact(message.channelId);
    const attachments = attachmentSummaries(message, deps.config.runtime.maxAttachmentBytes);
    deps.store.enqueue({ threadId: message.channelId, discordMessageId: message.id, authorId: message.author.id, content: promptWithAttachments(message.content.trim(), attachments), attachments });
    const counts = deps.store.counts(message.channelId);
    if (message.channel.isTextBased() && "send" in message.channel) {
      await message.channel.send({ content: `Queued OMP turn. Current backlog: ${counts.running} running, ${counts.queued} queued. Use \`status\` to inspect or \`stop\` to abort the running turn.` });
    }
    deps.runner.poke(message.channelId);
    return;
  }
  const policy = findGuildPolicy(deps.config, message.guildId);
  if (!policy || !isAllowed(policy, message)) return;
  if (policy.requireMention && !message.mentions.users.has(botId)) return;
  if (!message.channel.isTextBased() || message.channel.type === ChannelType.DM) return;
  const prompt = stripBotMention(message.content, botId);
  if (!prompt) return;
  const thread = await message.startThread({ name: slugifyThreadName(prompt), autoArchiveDuration: policy.threadAutoArchiveMinutes as any, reason: "OMP Discord bridge session" });
  fs.mkdirSync(deps.config.omp.sessionRoot, { recursive: true });
  const sessionDir = path.join(deps.config.omp.sessionRoot, thread.id);
  fs.mkdirSync(sessionDir, { recursive: true });
  const record = deps.store.createSession({
    threadId: thread.id,
    guildId: message.guildId,
    parentChannelId: message.channelId,
    triggerMessageId: message.id,
    sessionFile: null,
    sessionDir,
    cwd: policy.cwd ?? deps.config.omp.cwd,
    model: deps.config.omp.model,
    thinkingLevel: deps.config.omp.thinkingLevel,
    createdByUserId: message.author.id,
  });
  await thread.send(`OMP session started for <@${message.author.id}>. Thread maps to session directory \`${record.sessionDir}\`. Controls: \`status\`, \`stop\`, \`new\`, \`compact\`.`);
  const attachments = attachmentSummaries(message, deps.config.runtime.maxAttachmentBytes);
  deps.store.enqueue({ threadId: thread.id, discordMessageId: message.id, authorId: message.author.id, content: promptWithAttachments(prompt, attachments), attachments });
  deps.runner.poke(thread.id);
}

export function createDiscordClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel, Partials.Message],
  });
}
