import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Interaction, Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { SESSION_PICKER_PREFIX, handleDiscordInteraction, handleDiscordMessage, resolveSessionRef } from "../src/discord.js";
import { FakeOmpSessionFactory } from "../src/omp-session.js";
import { ThreadQueueRunner, parseManageCommand } from "../src/queue.js";
import { BridgeStore } from "../src/store.js";
import type { OmpSessionSummary } from "../src/types.js";

type PostedMessage = { content?: string; components?: unknown[] };

function createHarness(sessions: OmpSessionSummary[] = []) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "bridge-session-threads-"));
  const config = normalizeConfig({
    discord: { guilds: [{ id: "guild1", allowedChannels: ["proj1"], allowedUsers: ["user1"] }] },
    omp: { cwd: path.join(tmp, "project"), sessionRoot: path.join(tmp, "sessions") },
    runtime: { databasePath: path.join(tmp, "db.sqlite") },
  });
  const store = new BridgeStore(config.runtime.databasePath);
  const omp = new FakeOmpSessionFactory();
  omp.sessions = sessions;
  const sent: string[] = [];
  const runner = new ThreadQueueRunner({ store, omp, messenger: { send: async (_threadId, content) => { sent.push(content); } }, messageLimit: 1900, maxConcurrency: 1 });
  return { config, store, omp, runner, sent, tmp };
}

function seedChannelSession(store: BridgeStore, channelId: string, cwd: string, resumeSessionId: string | null = null) {
  return store.createSession({
    threadId: channelId,
    guildId: "guild1",
    parentChannelId: channelId,
    triggerMessageId: "seed",
    sessionFile: null,
    resumeSessionId,
    sessionDir: path.join(cwd, ".session"),
    cwd,
    model: null,
    thinkingLevel: null,
    createdByUserId: "user1",
  });
}

function fakeChannelMessage(content: string, options: { inThread?: boolean } = {}) {
  const posted: PostedMessage[] = [];
  const thread = { id: "session-thread", send: vi.fn(async (_content: string) => undefined) };
  const channel = {
    id: "proj1",
    isTextBased: () => true,
    isThread: () => options.inThread ?? false,
    send: vi.fn(async (payload: PostedMessage | string) => {
      posted.push(typeof payload === "string" ? { content: payload } : payload);
      return undefined;
    }),
  };
  const message = {
    id: "msg1",
    content,
    guildId: "guild1",
    channelId: "proj1",
    channel,
    author: { id: "user1", bot: false },
    client: { user: { id: "bot1" } },
    mentions: { users: new Map() },
    attachments: new Map(),
    startThread: vi.fn(async () => thread),
  };
  return { message, channel, thread, posted };
}

function fakeSessionThreadMessage(content: string) {
  const posted: PostedMessage[] = [];
  const channel = {
    id: "session-thread",
    isTextBased: () => true,
    isThread: () => true,
    send: vi.fn(async (payload: PostedMessage | string) => {
      posted.push(typeof payload === "string" ? { content: payload } : payload);
      return undefined;
    }),
  };
  const message = {
    id: "msg2",
    content,
    guildId: "guild1",
    channelId: "session-thread",
    channel,
    author: { id: "user1", bot: false },
    client: { user: { id: "bot1" } },
    mentions: { users: new Map() },
    attachments: new Map(),
    startThread: vi.fn(),
  };
  return { message, channel, posted };
}

const handoverId = "01a0e3e9-b3ca-70de-a8f5-a64cdf53b1ea";

describe("session history commands", () => {
  it("parses sessions/open/resume message commands", () => {
    expect(parseManageCommand("sessions")).toEqual({ command: "sessions" });
    expect(parseManageCommand(" /Sessions ")).toEqual({ command: "sessions" });
    expect(parseManageCommand("open 01a0e3e9")).toEqual({ command: "open", ref: "01a0e3e9" });
    expect(parseManageCommand("resume 01a0e3e9")).toEqual({ command: "open", ref: "01a0e3e9" });
    expect(parseManageCommand("open")).toBeUndefined();
    expect(parseManageCommand("status")).toBeUndefined();
    expect(parseManageCommand("keep going with the parser")).toBeUndefined();
  });

  it("resolves session references by id prefix, id substring and title", () => {
    const sessions: OmpSessionSummary[] = [
      { sessionId: "01a0e425-5fba-7079-b637-afc6e8f8968f", title: "Verify Handoff", cwd: "/proj", updatedAt: "2026-09-27T18:34:09.000Z" },
      { sessionId: handoverId, title: "Initialize HouseSync", cwd: "/proj", updatedAt: "2026-09-27T17:28:59.000Z" },
    ];
    expect(resolveSessionRef(sessions, "01a0e3e9")?.sessionId).toBe(handoverId);
    expect(resolveSessionRef(sessions, "housesy")?.sessionId).toBe(handoverId);
    expect(resolveSessionRef(sessions, "01a0e425")?.title).toBe("Verify Handoff");
    expect(resolveSessionRef(sessions, "nope")).toBeUndefined();
  });

  it("persists resumeSessionId and migrates databases created before the column existed", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bridge-store-migrate-"));
    const dbPath = path.join(tmp, "db.sqlite");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE discord_sessions(
      thread_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      parent_channel_id TEXT NOT NULL,
      trigger_message_id TEXT NOT NULL,
      session_file TEXT,
      session_dir TEXT NOT NULL,
      cwd TEXT NOT NULL,
      model TEXT,
      thinking_level TEXT,
      created_by_user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`);
    legacy.prepare("INSERT INTO discord_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run("legacy-thread", "guild1", "proj1", "msg", null, "/sessions/legacy-thread", "/proj", null, null, "user1", "active", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    legacy.close();

    const store = new BridgeStore(dbPath);
    expect(store.getSession("legacy-thread")?.resumeSessionId).toBeNull();
    store.updateSession("legacy-thread", { resumeSessionId: handoverId });
    expect(store.getSession("legacy-thread")?.resumeSessionId).toBe(handoverId);
    store.updateSession("legacy-thread", { resumeSessionId: null });
    expect(store.getSession("legacy-thread")?.resumeSessionId).toBeNull();
    expect(store.createSession({ threadId: "fresh", guildId: "guild1", parentChannelId: "proj1", triggerMessageId: "msg", sessionFile: null, resumeSessionId: handoverId, sessionDir: "/sessions/fresh", cwd: "/proj", model: null, thinkingLevel: null, createdByUserId: "user1" }).resumeSessionId).toBe(handoverId);
    store.close();
  });

  it("lists only this project's sessions as a select menu", async () => {
    const sessions: OmpSessionSummary[] = [
      { sessionId: "other-1", title: "Elsewhere", cwd: "/elsewhere", updatedAt: "2026-09-27T19:00:00.000Z" },
      { sessionId: handoverId, title: "Initialize HouseSync", cwd: "/proj", updatedAt: "2026-09-27T17:28:59.000Z" },
      { sessionId: "verify-1", title: "Verify Handoff", cwd: "/proj", updatedAt: "2026-09-27T18:34:09.000Z" },
    ];
    const { config, store, runner } = createHarness(sessions);
    seedChannelSession(store, "proj1", "/proj");
    const { message, posted } = fakeChannelMessage("sessions");

    // test double for a discord.js Message
    await handleDiscordMessage({ config, store, runner }, message as unknown as Message);

    expect(posted).toHaveLength(1);
    expect(posted[0]?.content).toContain("**omp sessions for** `/proj`");
    const rows = posted[0]?.components as { toJSON(): { components: { custom_id: string; options: { value: string; label: string }[] }[] } }[];
    const row = rows[0]?.toJSON();
    expect(row?.components[0]?.custom_id).toBe(`${SESSION_PICKER_PREFIX}proj1`);
    expect(row?.components[0]?.options.map((option) => option.value)).toEqual(["verify-1", handoverId]);
    expect(row?.components[0]?.options[0]?.label).toBe("Verify Handoff");
  });

  it("refuses to open a session thread from inside a session thread", async () => {
    const { config, store, runner } = createHarness();
    seedChannelSession(store, "proj1", "/proj");
    const { message, posted } = fakeChannelMessage("sessions", { inThread: true });

    await handleDiscordMessage({ config, store, runner }, message as unknown as Message);

    expect(posted[0]?.content).toContain("Run this in the project channel");
    expect(message.startThread).not.toHaveBeenCalled();
  });

  it("opens a subchannel bound to the selected session and drives it", async () => {
    const sessions: OmpSessionSummary[] = [{ sessionId: handoverId, title: "Initialize HouseSync", cwd: "/proj", updatedAt: "2026-09-27T17:28:59.000Z" }];
    const { config, store, omp, runner, sent } = createHarness(sessions);
    seedChannelSession(store, "proj1", "/proj");
    const threadSend = vi.fn(async (_content: string) => undefined);
    const thread = { id: "session-thread", send: threadSend };
    const interaction = {
      customId: `${SESSION_PICKER_PREFIX}proj1`,
      values: [handoverId],
      guildId: "guild1",
      user: { id: "user1" },
      message: { id: "picker-msg", startThread: vi.fn(async () => thread) },
      isStringSelectMenu: () => true,
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
    };

    // test double for a discord.js StringSelectMenuInteraction
    await handleDiscordInteraction({ config, store, runner }, interaction as unknown as Interaction);

    expect(interaction.message.startThread).toHaveBeenCalledWith(expect.objectContaining({ name: "omp-initialize-housesync" }));
    const record = store.getSession("session-thread");
    expect(record?.resumeSessionId).toBe(handoverId);
    expect(record?.cwd).toBe("/proj");
    expect(threadSend).toHaveBeenCalledWith(expect.stringContaining(`Continuing omp session \`${handoverId}\``));
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("<#session-thread>") }));

    const { message } = fakeSessionThreadMessage("pick the work back up");
    await handleDiscordMessage({ config, store, runner }, message as unknown as Message);
    await vi.waitFor(() => expect(omp.prompts).toEqual(["pick the work back up"]));
    expect(sent).toContain("echo: pick the work back up");

    await runner.status("session-thread");
    expect(sent.some((entry) => entry.includes(`Continues: \`${handoverId}\``))).toBe(true);
  });

  it("opens a session thread directly from `open <id-prefix>`", async () => {
    const sessions: OmpSessionSummary[] = [{ sessionId: handoverId, title: "Initialize HouseSync", cwd: "/proj", updatedAt: "2026-09-27T17:28:59.000Z" }];
    const { config, store, runner } = createHarness(sessions);
    seedChannelSession(store, "proj1", "/proj");
    const { message, thread } = fakeChannelMessage("open 01a0e3e9");

    await handleDiscordMessage({ config, store, runner }, message as unknown as Message);

    expect(message.startThread).toHaveBeenCalledWith(expect.objectContaining({ name: "omp-initialize-housesync" }));
    expect(store.getSession(thread.id)?.resumeSessionId).toBe(handoverId);
  });

  it("reports unknown session references without opening a thread", async () => {
    const { config, store, runner } = createHarness([]);
    seedChannelSession(store, "proj1", "/proj");
    const { message, posted } = fakeChannelMessage("open deadbeef");

    await handleDiscordMessage({ config, store, runner }, message as unknown as Message);

    expect(message.startThread).not.toHaveBeenCalled();
    expect(posted[0]?.content).toContain("No omp sessions found for `/proj`");
  });

  it("clears the resume binding when starting a new session in a bound thread", async () => {
    const { store, runner } = createHarness();
    seedChannelSession(store, "session-thread", "/proj", handoverId);

    await runner.newSession("session-thread");

    expect(store.getSession("session-thread")?.resumeSessionId).toBeNull();
  });
});
