import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { BridgeStore } from "../src/store.js";
import { FakeOmpSessionFactory } from "../src/omp-session.js";
import { ThreadQueueRunner } from "../src/queue.js";
import { handleDiscordInteraction, handleDiscordMessage } from "../src/discord.js";

function fakeMessage(content: string, overrides: any = {}) {
  const thread = { id: "thread1", send: vi.fn(async (_msg: string) => undefined) };
  const msg: any = {
    id: "msg1",
    content,
    guildId: "guild1",
    channelId: "chan1",
    author: { id: "user1", bot: false },
    client: { user: { id: "bot1" } },
    mentions: { users: new Map([["bot1", { id: "bot1" }]]) },
    attachments: new Map(),
    channel: { isTextBased: () => true, type: 0 },
    startThread: vi.fn(async () => thread),
    ...overrides,
  };
  return { msg, thread };
}

function fakeInteraction(commandName: string, overrides: any = {}) {
  const prompt = overrides.prompt ?? null;
  const interaction: any = {
    id: "interaction1",
    commandName,
    guildId: "guild1",
    channelId: "thread1",
    user: { id: "user1", bot: false },
    options: { getString: vi.fn((name: string) => (name === "prompt" ? prompt : null)) },
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    deferReply: vi.fn(async (_options?: any) => undefined),
    editReply: vi.fn(async (_message: any) => undefined),
    reply: vi.fn(async (_message: any) => undefined),
    ...overrides,
  };
  return interaction;
}

describe("Discord orchestration", () => {
  it("creates a thread/session from an allowed mention and enqueues stripped prompt", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bridge-discord-"));
    const config = normalizeConfig({ discord: { guilds: [{ id: "guild1", allowedChannels: ["chan1"], allowedUsers: ["user1"] }] }, omp: { cwd: tmp, sessionRoot: path.join(tmp, "sessions") }, runtime: { databasePath: path.join(tmp, "db.sqlite") } });
    const store = new BridgeStore(config.runtime.databasePath);
    const sent: string[] = [];
    const runner = new ThreadQueueRunner({ store, omp: new FakeOmpSessionFactory(), messenger: { send: async (_t, c) => { sent.push(c); } }, messageLimit: 1900, maxConcurrency: 1 });
    const { msg, thread } = fakeMessage("<@bot1> hello bridge");
    await handleDiscordMessage({ config, store, runner }, msg);
    expect(msg.startThread).toHaveBeenCalledWith(expect.objectContaining({ name: "omp-hello-bridge" }));
    expect(thread.send).toHaveBeenCalledWith(expect.stringContaining("OMP session started"));
    expect(store.getSession("thread1")?.parentChannelId).toBe("chan1");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent[0]).toBe("echo: hello bridge");
    store.close();
  });
  it("steers follow-up prompts into an active thread turn by default", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bridge-discord-"));
    const config = normalizeConfig({ discord: { guilds: [{ id: "guild1", allowedChannels: ["chan1"], allowedUsers: ["user1"] }] }, omp: { cwd: tmp, sessionRoot: path.join(tmp, "sessions") }, runtime: { databasePath: path.join(tmp, "db.sqlite") } });
    const store = new BridgeStore(config.runtime.databasePath);
    store.createSession({ threadId: "thread1", guildId: "guild1", parentChannelId: "chan1", triggerMessageId: "msg0", sessionFile: null, sessionDir: path.join(tmp, "sessions/thread1"), cwd: tmp, model: null, thinkingLevel: null, createdByUserId: "user1" });
    let finish!: () => void;
    const firstTurnDone = new Promise<void>((resolve) => { finish = resolve; });
    const omp = new FakeOmpSessionFactory(async (message) => {
      if (message === "first") await firstTurnDone;
      return `answer ${message}`;
    });
    const runner = new ThreadQueueRunner({ store, omp, messenger: { send: async () => undefined }, messageLimit: 1900, maxConcurrency: 1 });
    store.enqueue({ threadId: "thread1", discordMessageId: "msg1", authorId: "user1", content: "first" });
    runner.poke("thread1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const channelSend = vi.fn(async (_msg: any) => undefined);
    const { msg } = fakeMessage("do the next thing", { id: "msg2", channelId: "thread1", channel: { isTextBased: () => true, type: 0, send: channelSend }, mentions: { users: new Map() } });

    await handleDiscordMessage({ config, store, runner }, msg);

    expect(channelSend).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("Steered current OMP turn") }));
    expect(omp.steers).toEqual(["do the next thing"]);
    expect(store.counts("thread1")).toEqual({ queued: 0, running: 1 });
    finish();
    await new Promise((resolve) => setTimeout(resolve, 100));
    store.close();
  });

  it("can be configured to queue follow-up prompts instead of steering", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bridge-discord-"));
    const config = normalizeConfig({ discord: { guilds: [{ id: "guild1", allowedChannels: ["chan1"], allowedUsers: ["user1"] }] }, omp: { cwd: tmp, sessionRoot: path.join(tmp, "sessions") }, runtime: { databasePath: path.join(tmp, "db.sqlite"), followupMode: "queue" } });
    const store = new BridgeStore(config.runtime.databasePath);
    store.createSession({ threadId: "thread1", guildId: "guild1", parentChannelId: "chan1", triggerMessageId: "msg0", sessionFile: null, sessionDir: path.join(tmp, "sessions/thread1"), cwd: tmp, model: null, thinkingLevel: null, createdByUserId: "user1" });
    const runner = { poke: vi.fn(), steer: vi.fn(async () => false), status: vi.fn(), stop: vi.fn(), newSession: vi.fn(), compact: vi.fn() } as any;
    const channelSend = vi.fn(async (_msg: any) => undefined);
    const { msg } = fakeMessage("queue this", { id: "msg2", channelId: "thread1", channel: { isTextBased: () => true, type: 0, send: channelSend }, mentions: { users: new Map() } });

    await handleDiscordMessage({ config, store, runner }, msg);

    expect(channelSend).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("Queued OMP turn") }));
    expect(store.nextQueued("thread1")).toMatchObject({ content: "queue this" });
    store.close();
  });


  it("queues /omp prompt interactions in existing managed threads", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bridge-discord-"));
    const config = normalizeConfig({ discord: { guilds: [{ id: "guild1", allowedChannels: ["chan1"], allowedUsers: ["user1"] }] }, omp: { cwd: tmp, sessionRoot: path.join(tmp, "sessions") }, runtime: { databasePath: path.join(tmp, "db.sqlite") } });
    const store = new BridgeStore(config.runtime.databasePath);
    store.createSession({ threadId: "thread1", guildId: "guild1", parentChannelId: "chan1", triggerMessageId: "msg0", sessionFile: null, sessionDir: path.join(tmp, "sessions/thread1"), cwd: tmp, model: null, thinkingLevel: null, createdByUserId: "user1" });
    const runner = { poke: vi.fn(), steer: vi.fn(async () => false), status: vi.fn(), stop: vi.fn(), newSession: vi.fn(), compact: vi.fn() } as any;
    const interaction = fakeInteraction("omp", { id: "interaction1", prompt: "run the tool" });

    await handleDiscordInteraction({ config, store, runner }, interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    const queued = store.nextQueued("thread1");
    expect(queued).toMatchObject({ threadId: "thread1", discordMessageId: "interaction1", authorId: "user1", content: "run the tool" });
    expect(runner.poke).toHaveBeenCalledWith("thread1");
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/queued|backlog/i) }));
    store.close();
  });

  it("routes direct configured ACP slash command interactions as slash prompts", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bridge-discord-"));
    const config = normalizeConfig({ discord: { guilds: [{ id: "guild1", allowedChannels: ["chan1"], allowedUsers: ["user1"] }], slashCommands: { acpCommands: [{ name: "todo", description: "Manage todos", inputHint: "args" }] } }, omp: { cwd: tmp, sessionRoot: path.join(tmp, "sessions") }, runtime: { databasePath: path.join(tmp, "db.sqlite"), followupMode: "queue" } });
    const store = new BridgeStore(config.runtime.databasePath);
    store.createSession({ threadId: "thread1", guildId: "guild1", parentChannelId: "chan1", triggerMessageId: "msg0", sessionFile: null, sessionDir: path.join(tmp, "sessions/thread1"), cwd: tmp, model: null, thinkingLevel: null, createdByUserId: "user1" });
    const runner = { poke: vi.fn(), steer: vi.fn(async () => false), status: vi.fn(), stop: vi.fn(), newSession: vi.fn(), compact: vi.fn() } as any;
    const interaction = fakeInteraction("todo", { id: "interaction-acp", options: { getString: vi.fn((name: string) => (name === "input" ? "list" : null)) } });

    await handleDiscordInteraction({ config, store, runner }, interaction);

    expect(store.nextQueued("thread1")).toMatchObject({ content: "/todo list" });
    expect(runner.poke).toHaveBeenCalledWith("thread1");
    store.close();
  });

  it("routes namespace ACP slash command interactions with autocomplete-selected command names", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bridge-discord-"));
    const config = normalizeConfig({ discord: { guilds: [{ id: "guild1", allowedChannels: ["chan1"], allowedUsers: ["user1"] }], slashCommands: { acpCommands: [{ name: "skill:test-driven-development", description: "TDD", inputHint: "args" }] } }, omp: { cwd: tmp, sessionRoot: path.join(tmp, "sessions") }, runtime: { databasePath: path.join(tmp, "db.sqlite"), followupMode: "queue" } });
    const store = new BridgeStore(config.runtime.databasePath);
    store.createSession({ threadId: "thread1", guildId: "guild1", parentChannelId: "chan1", triggerMessageId: "msg0", sessionFile: null, sessionDir: path.join(tmp, "sessions/thread1"), cwd: tmp, model: null, thinkingLevel: null, createdByUserId: "user1" });
    const runner = { poke: vi.fn(), steer: vi.fn(async () => false), status: vi.fn(), stop: vi.fn(), newSession: vi.fn(), compact: vi.fn() } as any;
    const interaction = fakeInteraction("skill", { id: "interaction-skill", options: { getString: vi.fn((name: string) => name === "command" ? "test-driven-development" : name === "input" ? "use TDD" : null) } });

    await handleDiscordInteraction({ config, store, runner }, interaction);

    expect(store.nextQueued("thread1")).toMatchObject({ content: "/skill:test-driven-development use TDD" });
    expect(runner.poke).toHaveBeenCalledWith("thread1");
    store.close();
  });

  it("autocompletes namespace ACP commands", async () => {
    const config = normalizeConfig({ discord: { guilds: [{ id: "guild1", allowedChannels: ["chan1"], allowedUsers: ["user1"] }], slashCommands: { acpCommands: [
      { name: "skill:test-driven-development", description: "TDD" },
      { name: "skill:writing-plans", description: "Plans" },
    ] } } });
    const store = new BridgeStore(":memory:");
    const interaction: any = {
      commandName: "skill",
      guildId: "guild1",
      options: { getFocused: vi.fn(() => "test") },
      isAutocomplete: () => true,
      isChatInputCommand: () => false,
      respond: vi.fn(async (_choices: any) => undefined),
    };

    await handleDiscordInteraction({ config, store, runner: {} as any }, interaction);

    expect(interaction.respond).toHaveBeenCalledWith([{ name: "test-driven-development", value: "test-driven-development" }]);
    store.close();
  });

  it("reports /omp-status interactions for existing managed threads", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bridge-discord-"));
    const config = normalizeConfig({ discord: { guilds: [{ id: "guild1", allowedChannels: ["chan1"], allowedUsers: ["user1"] }] }, omp: { cwd: tmp, sessionRoot: path.join(tmp, "sessions") }, runtime: { databasePath: path.join(tmp, "db.sqlite") } });
    const store = new BridgeStore(config.runtime.databasePath);
    store.createSession({ threadId: "thread1", guildId: "guild1", parentChannelId: "chan1", triggerMessageId: "msg0", sessionFile: null, sessionDir: path.join(tmp, "sessions/thread1"), cwd: tmp, model: null, thinkingLevel: null, createdByUserId: "user1" });
    const runner = { poke: vi.fn(), steer: vi.fn(async () => false), status: vi.fn(async () => undefined), stop: vi.fn(), newSession: vi.fn(), compact: vi.fn() } as any;
    const interaction = fakeInteraction("omp-status");

    await handleDiscordInteraction({ config, store, runner }, interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(runner.status).toHaveBeenCalledWith("thread1");
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/status/i) }));
    store.close();
  });

  it("rejects slash command interactions from users outside the guild allowlist", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bridge-discord-"));
    const config = normalizeConfig({ discord: { guilds: [{ id: "guild1", allowedChannels: ["chan1"], allowedUsers: ["user1"] }] }, omp: { cwd: tmp, sessionRoot: path.join(tmp, "sessions") }, runtime: { databasePath: path.join(tmp, "db.sqlite") } });
    const store = new BridgeStore(config.runtime.databasePath);
    store.createSession({ threadId: "thread1", guildId: "guild1", parentChannelId: "chan1", triggerMessageId: "msg0", sessionFile: null, sessionDir: path.join(tmp, "sessions/thread1"), cwd: tmp, model: null, thinkingLevel: null, createdByUserId: "user1" });
    const runner = { poke: vi.fn(), steer: vi.fn(async () => false), status: vi.fn(), stop: vi.fn(), newSession: vi.fn(), compact: vi.fn() } as any;
    const interaction = fakeInteraction("omp", { id: "interaction2", prompt: "run the tool", user: { id: "user2", bot: false } });

    await handleDiscordInteraction({ config, store, runner }, interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/not allowed/i), ephemeral: true }));
    expect(store.counts("thread1")).toEqual({ queued: 0, running: 0 });
    expect(runner.poke).not.toHaveBeenCalled();
    store.close();
  });

  it("ignores stale slash interactions when slash commands are disabled", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bridge-discord-"));
    const config = normalizeConfig({ discord: { guilds: [{ id: "guild1", allowedChannels: ["chan1"], allowedUsers: ["user1"] }], slashCommands: { enabled: false } }, omp: { cwd: tmp, sessionRoot: path.join(tmp, "sessions") }, runtime: { databasePath: path.join(tmp, "db.sqlite") } });
    const store = new BridgeStore(config.runtime.databasePath);
    store.createSession({ threadId: "thread1", guildId: "guild1", parentChannelId: "chan1", triggerMessageId: "msg0", sessionFile: null, sessionDir: path.join(tmp, "sessions/thread1"), cwd: tmp, model: null, thinkingLevel: null, createdByUserId: "user1" });
    const runner = { poke: vi.fn(), steer: vi.fn(async () => false), status: vi.fn(), stop: vi.fn(), newSession: vi.fn(), compact: vi.fn() } as any;
    const interaction = fakeInteraction("omp", { id: "interaction3", prompt: "run the tool" });

    await handleDiscordInteraction({ config, store, runner }, interaction);

    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(store.counts("thread1")).toEqual({ queued: 0, running: 0 });
    expect(runner.poke).not.toHaveBeenCalled();
    store.close();
  });
});
