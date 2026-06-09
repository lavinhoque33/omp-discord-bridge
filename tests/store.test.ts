import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeStore } from "../src/store.js";

function store() { return new BridgeStore(path.join(mkdtempSync(path.join(os.tmpdir(), "bridge-store-")), "state.sqlite")); }

describe("BridgeStore", () => {
  it("persists session mapping and queued messages", () => {
    const s = store();
    s.createSession({ threadId: "t", guildId: "g", parentChannelId: "c", triggerMessageId: "m", sessionFile: null, sessionDir: "/tmp/s", cwd: "/tmp", model: null, thinkingLevel: "medium", createdByUserId: "u" });
    const q = s.enqueue({ threadId: "t", discordMessageId: "m2", authorId: "u", content: "hello" });
    expect(s.getSession("t")?.cwd).toBe("/tmp");
    expect(s.nextQueued("t")?.id).toBe(q.id);
    s.markMessage(q.id, "running");
    expect(s.counts("t")).toEqual({ queued: 0, running: 1 });
    expect(s.recoverRunning()).toBe(1);
    expect(s.counts("t")).toEqual({ queued: 1, running: 0 });
    expect(s.queuedThreadIds()).toEqual(["t"]);
    s.close();
  });
});
