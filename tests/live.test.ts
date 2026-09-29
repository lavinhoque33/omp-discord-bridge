import { describe, expect, it } from "vitest";
import { LiveThreads } from "../src/live.js";
import { AcpLiveTranslator } from "../src/omp-session.js";
import type { LiveEvent, ThreadMessenger } from "../src/types.js";

function discordLog() {
  const calls: string[] = [];
  const messages: string[] = [];
  const messenger: ThreadMessenger = {
    send: async (_threadId, content) => {
      calls.push(`send ${content}`);
      return String(messages.push(content) - 1);
    },
    edit: async (_threadId, messageId, content) => {
      calls.push(`edit ${messageId} ${content}`);
      messages[Number(messageId)] = content;
    },
  };
  return { calls, messages, messenger };
}

describe("LiveThreads", () => {
  it("posts a block once, then edits it; bursts coalesce into one pass", async () => {
    const { calls, messages, messenger } = discordLog();
    const live = new LiveThreads(messenger, { intervalMs: 10_000, messageLimit: 1900 });
    live.push("t", { type: "text", key: "a", text: "Hel" });
    live.push("t", { type: "text", key: "a", text: "Hello" });
    live.push("t", { type: "tool", key: "tool:1", name: "bash", title: "Run tests", detail: "npm test", state: "running" });
    await live.settle("t");
    live.push("t", { type: "text", key: "a", text: "Hello world" });
    live.push("t", { type: "tool", key: "tool:1", name: "bash", title: "Run tests", detail: "npm test", state: "error", output: "1 failed" });
    await live.settle("t");
    expect(calls).toEqual([
      "send Hello",
      "send 🔧 **bash** · Run tests\n`npm test`",
      "edit 0 Hello world",
      "edit 1 ❌ **bash** · Run tests\n`npm test`\n```\n1 failed\n```",
    ]);
    expect(messages).toHaveLength(2);
  });

  it("splits a block over the message limit and only edits the chunk that changed", async () => {
    const { calls, messages, messenger } = discordLog();
    const live = new LiveThreads(messenger, { intervalMs: 0, messageLimit: 100 });
    const first = "a".repeat(90);
    live.push("t", { type: "text", key: "a", text: `${first}\n${"b".repeat(50)}` });
    await live.settle("t");
    live.push("t", { type: "text", key: "a", text: `${first}\n${"b".repeat(60)}` });
    await live.settle("t");
    expect(messages).toEqual([first, "b".repeat(60)]);
    expect(calls.filter((call) => call.startsWith("edit"))).toEqual([`edit 1 ${"b".repeat(60)}`]);
  });
  it("settle waits for an in-flight pass, then flushes what arrived during it", async () => {
    const { calls, messenger } = discordLog();
    const gate = Promise.withResolvers<void>();
    const inFlight = Promise.withResolvers<void>();
    const gated: ThreadMessenger = {
      send: async (threadId, content) => {
        inFlight.resolve();
        await gate.promise;
        return messenger.send(threadId, content);
      },
      edit: messenger.edit,
    };
    const live = new LiveThreads(gated, { intervalMs: 0, messageLimit: 1900 });
    live.push("x", { type: "notice", key: "n", text: "joined" });
    await inFlight.promise;
    live.push("x", { type: "text", key: "b", text: "reply" });
    const settled = live.settle("x");
    gate.resolve();
    await settled;
    expect(calls).toEqual(["send -# joined", "send reply"]);
  });
});

describe("AcpLiveTranslator", () => {
  it("maps omp ACP updates to text blocks split by tool calls", () => {
    const events: LiveEvent[] = [];
    const translator = new AcpLiveTranslator((event) => events.push(event));
    translator.startTurn();
    translator.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Checking" } });
    translator.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " files." } });
    translator.update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "$ ls -la", kind: "execute", rawInput: { command: "ls -la" }, status: "pending", content: [] });
    translator.update({ sessionUpdate: "tool_call", toolCallId: "c2", title: "Reading probe file lines", kind: "read", rawInput: { path: "/tmp/probe.txt" }, status: "pending", content: [] });
    translator.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" });
    translator.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed", rawOutput: { content: [{ type: "text", text: "ls: denied" }], isError: true } });
    translator.update({ sessionUpdate: "tool_call_update", toolCallId: "c2", status: "completed", rawOutput: { content: [{ type: "text", text: "line 1" }] } });
    translator.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
    translator.startTurn();
    translator.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Next turn" } });

    expect(events).toEqual([
      { type: "text", key: "acp:1:0", text: "Checking" },
      { type: "text", key: "acp:1:0", text: "Checking files." },
      { type: "tool", key: "tool:c1", title: "$ ls -la", state: "running" },
      { type: "tool", key: "tool:c2", title: "Reading probe file lines", detail: "/tmp/probe.txt", state: "running" },
      { type: "tool", key: "tool:c1", title: "$ ls -la", state: "error", output: "ls: denied" },
      { type: "tool", key: "tool:c2", title: "Reading probe file lines", detail: "/tmp/probe.txt", state: "ok", output: "line 1" },
      { type: "text", key: "acp:1:1", text: "Done." },
      { type: "text", key: "acp:2:2", text: "Next turn" },
    ]);
  });
});
