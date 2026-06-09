import { ChannelType, Client, GatewayIntentBits, MessageFlags, Partials, type ChatInputCommandInteraction, type Interaction, type Message } from "discord.js";
import fs from "node:fs";
import path from "node:path";
import type { BridgeConfig, GuildPolicy } from "./types.js";
import type { BridgeStore } from "./store.js";
import { findGuildPolicy } from "./config.js";
import { slugifyThreadName, stripBotMention } from "./render.js";
import { parseThreadCommand, type ThreadQueueRunner } from "./queue.js";
import { acpAutocompleteChoices, resolveAcpSlashPrompt } from "./slash-commands.js";

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

type DiscordPrincipal = { channelId: string; userId: string };

function isAllowed(policy: GuildPolicy, principal: DiscordPrincipal): boolean {
  if (policy.allowedChannels.length > 0 && !policy.allowedChannels.includes(principal.channelId)) return false;
  if (policy.allowedUsers.length > 0 && !policy.allowedUsers.includes(principal.userId)) return false;
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
    const prompt = promptWithAttachments(message.content.trim(), attachments);
    if (deps.config.runtime.followupMode === "steer" && await deps.runner.steer(message.channelId, prompt)) {
      if (message.channel.isTextBased() && "send" in message.channel) {
        await message.channel.send({ content: "Steered current OMP turn with your follow-up message. Use `status` to inspect or `stop` to abort." });
      }
      return;
    }
    deps.store.enqueue({ threadId: message.channelId, discordMessageId: message.id, authorId: message.author.id, content: prompt, attachments });
    const counts = deps.store.counts(message.channelId);
    if (message.channel.isTextBased() && "send" in message.channel) {
      await message.channel.send({ content: `Queued OMP turn. Current backlog: ${counts.running} running, ${counts.queued} queued. Use \`status\` to inspect or \`stop\` to abort the running turn.` });
    }
    deps.runner.poke(message.channelId);
    return;
  }
  const policy = findGuildPolicy(deps.config, message.guildId);
  if (!policy || !isAllowed(policy, { channelId: message.channelId, userId: message.author.id })) return;
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

type BridgeInteractionCommand = "prompt" | "status" | "stop" | "new" | "compact";

function bridgeInteractionCommand(prefix: string, commandName: string): BridgeInteractionCommand | undefined {
  if (commandName === prefix) return "prompt";
  if (commandName === `${prefix}-status`) return "status";
  if (commandName === `${prefix}-stop`) return "stop";
  if (commandName === `${prefix}-new`) return "new";
  if (commandName === `${prefix}-compact`) return "compact";
  return undefined;
}

function promptOption(interaction: ChatInputCommandInteraction): string | null {
  try {
    return interaction.options.getString("prompt", true);
  } catch {
    return interaction.options.getString("prompt");
  }
}

export async function handleDiscordInteraction(deps: { config: BridgeConfig; store: BridgeStore; runner: ThreadQueueRunner }, interaction: Interaction): Promise<void> {
  if (!deps.config.discord.slashCommands.enabled) return;
  if (interaction.isAutocomplete()) {
    const focused = String(interaction.options.getFocused() ?? "");
    const choices = acpAutocompleteChoices(deps.config, interaction.commandName, focused);
    if (choices.length > 0) await interaction.respond(choices);
    return;
  }
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;

  const command = bridgeInteractionCommand(deps.config.discord.slashCommands.commandPrefix, interaction.commandName);
  const acpPrompt = resolveAcpSlashPrompt(deps.config, interaction.commandName, (name) => interaction.options.getString(name));
  if (!command && !acpPrompt) return;

  const existing = deps.store.getSession(interaction.channelId);
  const policy = findGuildPolicy(deps.config, interaction.guildId);
  const principal = { channelId: existing?.parentChannelId ?? interaction.channelId, userId: interaction.user.id };
  if (!policy || !isAllowed(policy, principal)) {
    await interaction.reply({ content: "You are not allowed to use this OMP bridge command here.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!existing) {
    await interaction.editReply({ content: "Slash commands must be used in an OMP-managed thread." });
    return;
  }

  if (command === "prompt" || acpPrompt) {
    const rawInput = acpPrompt ?? promptOption(interaction)?.trim() ?? "";
    const prompt = rawInput;
    if (!prompt) {
      await interaction.editReply({ content: "A prompt is required for this slash command." });
      return;
    }
    if (deps.config.runtime.followupMode === "steer" && await deps.runner.steer(interaction.channelId, prompt)) {
      await interaction.editReply({ content: "Steered current OMP turn with your follow-up message." });
      return;
    }
    deps.store.enqueue({ threadId: interaction.channelId, discordMessageId: interaction.id, authorId: interaction.user.id, content: prompt, attachments: [] });
    const counts = deps.store.counts(interaction.channelId);
    deps.runner.poke(interaction.channelId);
    await interaction.editReply({ content: `Queued OMP turn. Current backlog: ${counts.running} running, ${counts.queued} queued.` });
    return;
  }

  if (command === "status") {
    await deps.runner.status(interaction.channelId);
    await interaction.editReply({ content: "Status requested for this OMP thread." });
    return;
  }
  if (command === "stop") {
    await deps.runner.stop(interaction.channelId);
    await interaction.editReply({ content: "Stop requested for this OMP thread." });
    return;
  }
  if (command === "new") {
    await deps.runner.newSession(interaction.channelId);
    await interaction.editReply({ content: "New session requested for this OMP thread." });
    return;
  }
  await deps.runner.compact(interaction.channelId);
  await interaction.editReply({ content: "Compact requested for this OMP thread." });
}

export function createDiscordClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel, Partials.Message],
  });
}
