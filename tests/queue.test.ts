import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeStore } from "../src/store.js";
import { FakeOmpSessionFactory } from "../src/omp-session.js";
import { ThreadQueueRunner, parseThreadCommand } from "../src/queue.js";
import { recordingMessenger } from "./live-messenger.js";

function fixture() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "bridge-queue-"));
  const store = new BridgeStore(path.join(tmp, "state.sqlite"));
  store.createSession({ threadId: "t", guildId: "g", parentChannelId: "c", triggerMessageId: "m", sessionFile: null, sessionDir: tmp, cwd: tmp, model: null, thinkingLevel: null, createdByUserId: "u" });
  const { sent, messenger, live } = recordingMessenger();
  const omp = new FakeOmpSessionFactory((message) => `answer ${message}`, live.push);
  const runner = new ThreadQueueRunner({ store, omp, messenger, live, maxConcurrency: 1 });
  return { store, sent, omp, runner };
}

describe("ThreadQueueRunner", () => {
  it("parses controls", () => {
    expect(parseThreadCommand("/status")).toBe("status");
    expect(parseThreadCommand("stop")).toBe("stop");
    expect(parseThreadCommand("hello")).toBeUndefined();
  });
  it("runs queued prompts serially and posts final answer", async () => {
    const { store, sent, omp, runner } = fixture();
    store.enqueue({ threadId: "t", discordMessageId: "m1", authorId: "u", content: "one" });
    store.enqueue({ threadId: "t", discordMessageId: "m2", authorId: "u", content: "two" });
    runner.poke("t");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(omp.prompts).toEqual(["one", "two"]);
    expect(sent).toEqual(["answer one", "answer two"]);
    expect(store.counts("t")).toEqual({ queued: 0, running: 0 });
  });
  it("reports status", async () => {
    const { sent, runner } = fixture();
    await runner.status("t");
    expect(sent[0]).toContain("OMP Discord Bridge status");
  });
});
