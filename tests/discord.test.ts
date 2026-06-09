import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { BridgeStore } from "../src/store.js";
import { FakeOmpSessionFactory } from "../src/omp-session.js";
import { ThreadQueueRunner } from "../src/queue.js";
import { handleDiscordMessage } from "../src/discord.js";

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

  it("acknowledges follow-up prompts in existing threads immediately", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bridge-discord-"));
    const config = normalizeConfig({ discord: { guilds: [{ id: "guild1", allowedChannels: ["chan1"], allowedUsers: ["user1"] }] }, omp: { cwd: tmp, sessionRoot: path.join(tmp, "sessions") }, runtime: { databasePath: path.join(tmp, "db.sqlite") } });
    const store = new BridgeStore(config.runtime.databasePath);
    store.createSession({ threadId: "thread1", guildId: "guild1", parentChannelId: "chan1", triggerMessageId: "msg0", sessionFile: null, sessionDir: path.join(tmp, "sessions/thread1"), cwd: tmp, model: null, thinkingLevel: null, createdByUserId: "user1" });
    const runner = new ThreadQueueRunner({ store, omp: new FakeOmpSessionFactory(), messenger: { send: async () => undefined }, messageLimit: 1900, maxConcurrency: 1 });
    const channelSend = vi.fn(async (_msg: any) => undefined);
    const { msg } = fakeMessage("do the next thing", { id: "msg2", channelId: "thread1", channel: { isTextBased: () => true, type: 0, send: channelSend }, mentions: { users: new Map() } });

    await handleDiscordMessage({ config, store, runner }, msg);

    expect(channelSend).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("Queued OMP turn") }));
    expect(store.counts("thread1").queued + store.counts("thread1").running).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    store.close();
  });
});
