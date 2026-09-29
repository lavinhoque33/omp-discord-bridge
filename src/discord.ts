import { ActionRowBuilder, ChannelType, Client, GatewayIntentBits, MessageFlags, Partials, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ThreadAutoArchiveDuration, type ChatInputCommandInteraction, type Interaction, type Message } from "discord.js";
import fs from "node:fs";
import path from "node:path";
import type { BridgeConfig, GuildPolicy, OmpSessionSummary } from "./types.js";
import type { BridgeStore } from "./store.js";
import { findGuildPolicy } from "./config.js";
import { chunkDiscordMessage, slugifyThreadName, stripBotMention } from "./render.js";
import { parseManageCommand, parseThreadCommand, type ThreadQueueRunner } from "./queue.js";
import { acpAutocompleteChoices, resolveAcpSlashPrompt } from "./slash-commands.js";

export class DiscordThreadMessenger {
  constructor(private client: Client) {}
  async send(threadId: string, content: string): Promise<string> {
    const channel = await this.client.channels.fetch(threadId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) throw new Error(`thread ${threadId} is not sendable`);
    return (await channel.send({ content })).id;
  }
  async edit(threadId: string, messageId: string, content: string): Promise<void> {
    const channel = await this.client.channels.fetch(threadId);
    if (!channel || !channel.isTextBased()) throw new Error(`thread ${threadId} is not editable`);
    await channel.messages.edit(messageId, { content });
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

const THREAD_ARCHIVE_DURATIONS: Record<number, ThreadAutoArchiveDuration> = {
  60: ThreadAutoArchiveDuration.OneHour,
  1440: ThreadAutoArchiveDuration.OneDay,
  4320: ThreadAutoArchiveDuration.ThreeDays,
  10080: ThreadAutoArchiveDuration.OneWeek,
};

export const SESSION_PICKER_PREFIX = "omp-session-picker:";

/** `01a0e425 · updated 3h ago` — short id plus age, for select-menu descriptions. */
export function describeSession(session: OmpSessionSummary): string {
  const id = session.sessionId.slice(0, 8);
  if (!session.updatedAt) return id;
  const minutes = Math.round((Date.now() - new Date(session.updatedAt).getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return id;
  if (minutes < 60) return `${id} · updated ${Math.max(minutes, 0)}m ago`;
  if (minutes < 60 * 24) return `${id} · updated ${Math.round(minutes / 60)}h ago`;
  return `${id} · updated ${Math.round(minutes / (60 * 24))}d ago`;
}

export function sessionPickerRows(channelId: string, sessions: OmpSessionSummary[]) {
  const options = sessions.slice(0, 25).map((session) => new StringSelectMenuOptionBuilder()
    .setLabel((session.title ?? session.sessionId.slice(0, 8)).slice(0, 100))
    .setValue(session.sessionId)
    .setDescription(describeSession(session)));
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${SESSION_PICKER_PREFIX}${channelId}`)
    .setPlaceholder("Continue an existing omp session")
    .addOptions(options);
  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)];
}

/** Sessions arrive newest-first, so the first match wins. Matches an id prefix, then any id substring, then the title. */
export function resolveSessionRef(sessions: OmpSessionSummary[], ref: string): OmpSessionSummary | undefined {
  const needle = ref.trim().toLowerCase();
  return sessions.find((session) => session.sessionId.toLowerCase().startsWith(needle))
    ?? sessions.find((session) => session.sessionId.toLowerCase().includes(needle))
    ?? sessions.find((session) => (session.title ?? "").toLowerCase().includes(needle));
}

async function openSessionThread(input: {
  config: BridgeConfig;
  store: BridgeStore;
  guildId: string;
  parentChannelId: string;
  cwd: string;
  anchor: Message;
  session: OmpSessionSummary;
  authorId: string;
  autoArchiveMinutes: number;
  runner: ThreadQueueRunner;
}): Promise<string> {
  const thread = await input.anchor.startThread({
    name: slugifyThreadName(input.session.title ?? input.session.sessionId.slice(0, 8)),
    autoArchiveDuration: THREAD_ARCHIVE_DURATIONS[input.autoArchiveMinutes] ?? ThreadAutoArchiveDuration.OneDay,
    reason: `OMP session ${input.session.sessionId}`,
  });
  fs.mkdirSync(input.config.omp.sessionRoot, { recursive: true });
  const sessionDir = path.join(input.config.omp.sessionRoot, thread.id);
  fs.mkdirSync(sessionDir, { recursive: true });
  // One thread per omp session: an older thread would be a second writer (and a second live mirror).
  for (const previous of input.store.activeResumedSessions()) {
    if (previous.resumeSessionId === input.session.sessionId) await input.runner.supersede(previous.threadId, thread.id);
  }
  input.store.createSession({
    threadId: thread.id,
    guildId: input.guildId,
    parentChannelId: input.parentChannelId,
    triggerMessageId: input.anchor.id,
    sessionFile: null,
    resumeSessionId: input.session.sessionId,
    sessionDir,
    cwd: input.cwd,
    model: input.config.omp.model,
    thinkingLevel: input.config.omp.thinkingLevel,
    createdByUserId: input.authorId,
  });
  try {
    const transcript = await input.runner.loadSessionTranscript(thread.id);
    if (transcript.entries.length > 0) {
      const header = `**Replayed history of \`${input.session.sessionId}\`** — showing ${transcript.entries.length} of ${transcript.totalMessages} messages${transcript.toolCalls > 0 ? `, ${transcript.toolCalls} tool calls omitted` : ""}.`;
      const body = transcript.entries.map((entry) => `**${entry.role === "user" ? "you" : "omp"}**\n${entry.text}`).join("\n\n");
      for (const chunk of chunkDiscordMessage(`${header}\n\n${body}`, input.config.runtime.discordMessageLimit)) await thread.send(chunk);
    }
  } catch (error) {
    process.stderr.write(`[session-history] ${thread.id}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  await thread.send([
    `Continuing omp session \`${input.session.sessionId}\`${input.session.title ? ` — **${input.session.title}**` : ""} for \`${input.cwd}\`.`,
    "Send a message here to pick that conversation back up. Controls: `status`, `stop`, `new` (fresh session), `compact`.",
    "While an omp TUI has this session open, this thread shares it live; otherwise messages continue it in a background omp process.",
  ].join("\n"));
  return thread.id;
}

export async function handleDiscordMessage(deps: { config: BridgeConfig; store: BridgeStore; runner: ThreadQueueRunner }, message: Message): Promise<void> {
  if (message.author.bot || !message.guildId) return;
  const botId = message.client.user?.id;
  if (!botId) return;
  const existing = deps.store.getSession(message.channelId);
  if (existing) {
    if (existing.status === "archived") {
      if (message.channel.isTextBased() && "send" in message.channel) await message.channel.send("This thread was replaced by a newer thread for the same omp session.");
      return;
    }
    const command = parseThreadCommand(message.content);
    if (command === "status") return deps.runner.status(message.channelId);
    if (command === "stop") return deps.runner.stop(message.channelId);
    if (command === "new") return deps.runner.newSession(message.channelId);
    if (command === "compact") return deps.runner.compact(message.channelId);
    const manage = parseManageCommand(message.content);
    if (manage) {
      const channel = message.channel;
      if (!channel.isTextBased() || !("send" in channel)) return;
      if (channel.isThread()) {
        await channel.send("Run this in the project channel, not inside a session thread.");
        return;
      }
      const sessions = await deps.runner.listProjectSessions(message.channelId);
      if (sessions.length === 0) {
        await channel.send(`No omp sessions found for \`${existing.cwd}\`.`);
        return;
      }
      if (manage.command === "sessions") {
        await channel.send({ content: `**omp sessions for** \`${existing.cwd}\` — pick one to open a thread that continues it:`, components: sessionPickerRows(message.channelId, sessions) });
        return;
      }
      const target = resolveSessionRef(sessions, manage.ref);
      if (!target) {
        await channel.send(`No session matches \`${manage.ref}\` in \`${existing.cwd}\`. Run \`sessions\` for the list.`);
        return;
      }
      const policy = findGuildPolicy(deps.config, message.guildId);
      await openSessionThread({
        config: deps.config,
        store: deps.store,
        guildId: message.guildId,
        parentChannelId: message.channelId,
        cwd: existing.cwd,
        anchor: message,
        session: target,
        authorId: message.author.id,
        autoArchiveMinutes: policy?.threadAutoArchiveMinutes ?? 1440,
        runner: deps.runner,
      });
      return;
    }
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
  const thread = await message.startThread({ name: slugifyThreadName(prompt), autoArchiveDuration: THREAD_ARCHIVE_DURATIONS[policy.threadAutoArchiveMinutes] ?? ThreadAutoArchiveDuration.OneDay, reason: "OMP Discord bridge session" });
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

async function handleSessionsCommand(deps: { config: BridgeConfig; store: BridgeStore; runner: ThreadQueueRunner }, interaction: ChatInputCommandInteraction): Promise<void> {
  const record = deps.store.getSession(interaction.channelId);
  const policy = interaction.guildId ? findGuildPolicy(deps.config, interaction.guildId) : undefined;
  if (!record) {
    await interaction.reply({ content: "Use this in a project channel that the bridge maps to an OMP directory.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!policy || !isAllowed(policy, { channelId: record.parentChannelId, userId: interaction.user.id })) {
    await interaction.reply({ content: "You are not allowed to use this OMP bridge command here.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.channel?.isThread()) {
    await interaction.reply({ content: "Run this in the project channel, not inside a session thread.", flags: MessageFlags.Ephemeral });
    return;
  }
  // Public reply: the select menu lives on a real channel message, which is what a new thread is anchored to.
  await interaction.deferReply();
  const sessions = await deps.runner.listProjectSessions(interaction.channelId);
  if (sessions.length === 0) {
    await interaction.editReply({ content: `No omp sessions found for \`${record.cwd}\`.` });
    return;
  }
  await interaction.editReply({ content: `**omp sessions for** \`${record.cwd}\` — pick one to open a thread that continues it:`, components: sessionPickerRows(interaction.channelId, sessions) });
}

export async function handleDiscordInteraction(deps: { config: BridgeConfig; store: BridgeStore; runner: ThreadQueueRunner }, interaction: Interaction): Promise<void> {
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith(SESSION_PICKER_PREFIX)) {
    const parentChannelId = interaction.customId.slice(SESSION_PICKER_PREFIX.length);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const parent = deps.store.getSession(parentChannelId);
    const policy = interaction.guildId ? findGuildPolicy(deps.config, interaction.guildId) : undefined;
    if (!parent || !interaction.guildId || !policy || !isAllowed(policy, { channelId: parentChannelId, userId: interaction.user.id })) {
      await interaction.editReply({ content: "You are not allowed to open OMP sessions here." });
      return;
    }
    const sessions = await deps.runner.listProjectSessions(parentChannelId);
    const target = sessions.find((session) => session.sessionId === interaction.values[0]);
    if (!target) {
      await interaction.editReply({ content: "That session is no longer available for this project." });
      return;
    }
    const threadId = await openSessionThread({
      config: deps.config,
      store: deps.store,
      guildId: interaction.guildId,
      parentChannelId,
      cwd: parent.cwd,
      anchor: interaction.message,
      session: target,
      authorId: interaction.user.id,
      autoArchiveMinutes: policy.threadAutoArchiveMinutes,
      runner: deps.runner,
    });
    await interaction.editReply({ content: `Opened <#${threadId}> — session \`${target.sessionId}\` continues there.` });
    return;
  }
  if (!deps.config.discord.slashCommands.enabled) return;
  if (interaction.isChatInputCommand() && interaction.commandName === "sessions") {
    await handleSessionsCommand(deps, interaction);
    return;
  }
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
  if (existing.status === "archived") {
    await interaction.editReply({ content: "This thread was replaced by a newer thread for the same omp session." });
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
