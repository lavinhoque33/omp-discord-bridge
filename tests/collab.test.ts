import { randomBytes, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CollabGuest, CollabSession, parseCollabLink, transcriptFromEntries, type CollabHost, type SessionEntry } from "../src/collab.js";
import { startCollabRelay, type CollabRelay } from "../src/relay.js";
import type { LiveEvent } from "../src/types.js";

const ROOM = "AAAAAAAAAAAAAAAAAAAAAA";

describe("parseCollabLink", () => {
  const secret = randomBytes(48);
  const key = secret.subarray(0, 32);
  const token = secret.subarray(32);
  const encoded = secret.toString("base64url");

  it("reads the browser deep link omp prints for a local relay", () => {
    const parsed = parseCollabLink(`http://127.0.0.1:7466/#ws://127.0.0.1:7466/r/${ROOM}.${encoded}`);
    expect(parsed.wsUrl).toBe(`ws://127.0.0.1:7466/r/${ROOM}`);
    expect(Buffer.from(parsed.key)).toEqual(key);
    expect(Buffer.from(parsed.writeToken ?? [])).toEqual(token);
  });

  it("reads bare, scheme-less, and legacy fragment links", () => {
    expect(parseCollabLink(`https://my.omp.sh/#${ROOM}.${encoded}`).wsUrl).toBe(`wss://my.omp.sh/r/${ROOM}`);
    expect(parseCollabLink(`relay.example:8443/r/${ROOM}.${encoded}`).wsUrl).toBe(`wss://relay.example:8443/r/${ROOM}`);
    const legacy = parseCollabLink(`wss://relay.example/r/${ROOM}#${key.toString("base64url")}`);
    expect(legacy.wsUrl).toBe(`wss://relay.example/r/${ROOM}`);
    expect(legacy.writeToken).toBeUndefined();
  });

  it("rejects plain ws to remote hosts and keys of the wrong size", () => {
    expect(() => parseCollabLink(`ws://relay.example/r/${ROOM}.${encoded}`)).toThrow(/localhost/);
    expect(() => parseCollabLink(`wss://relay.example/r/${ROOM}.${randomBytes(20).toString("base64url")}`)).toThrow(/length/);
  });
});

describe("transcriptFromEntries", () => {
  it("keeps terminal and guest prompts plus assistant text, merging consecutive turns", () => {
    const message = (id: string, role: "user" | "assistant", content: unknown, extra: object = {}) =>
      ({ type: "message", id, message: { role, content, timestamp: 0, ...extra } }) as SessionEntry;
    const transcript = transcriptFromEntries([
      message("1", "user", "fix the build"),
      message("2", "assistant", [{ type: "text", text: "Looking." }, { type: "toolCall" }, { type: "toolCall" }]),
      message("3", "assistant", [{ type: "text", text: "Fixed." }]),
      message("4", "user", "internal reminder", { synthetic: true }),
      { type: "custom_message", id: "5", customType: "collab-prompt", content: "ship it", details: { from: "discord" } },
      { type: "custom_message", id: "6", customType: "other", content: "ignored" },
      { type: "compaction", id: "7" },
    ]);
    expect(transcript).toEqual({
      entries: [
        { role: "user", text: "fix the build" },
        { role: "assistant", text: "Looking.\n\nFixed." },
        { role: "user", text: "ship it" },
      ],
      toolCalls: 2,
      totalMessages: 3,
    });
  });
});

/** Minimal omp TUI host: speaks the collab envelope/crypto over the relay and answers prompts like omp does. */
async function fakeHost(relayUrl: string) {
  const key = randomBytes(32);
  const writeToken = randomBytes(16);
  const cryptoKey = await webcrypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
  const ws = new WebSocket(`${relayUrl}/r/${ROOM}?role=host`);
  const opened = Promise.withResolvers<void>();
  ws.on("open", () => opened.resolve());
  await opened.promise;
  const received: Array<{ peer: number; frame: Record<string, unknown> }> = [];
  const send = async (peer: number, frame: object) => {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, Buffer.from(JSON.stringify(frame))));
    const envelope = Buffer.alloc(16 + sealed.byteLength);
    envelope.writeUInt32BE(peer, 0);
    envelope.set(iv, 4);
    envelope.set(sealed, 16);
    ws.send(envelope);
  };
  const guestEntries: SessionEntry[] = [{ type: "message", id: "e1", message: { role: "user", content: "earlier prompt", timestamp: 1 } }];
  ws.on("message", async (data, isBinary) => {
    if (!isBinary) return;
    const bytes = data as Buffer;
    const peer = bytes.readUInt32BE(0);
    const plain = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(4, 16) }, cryptoKey, bytes.subarray(16));
    const frame = JSON.parse(Buffer.from(plain).toString("utf8")) as Record<string, unknown>;
    received.push({ peer, frame });
    if (frame.t === "hello") {
      const readOnly = frame.writeToken !== writeToken.toString("base64url");
      await send(peer, { t: "welcome", proto: 3, header: { id: "sess-1", cwd: "/proj" }, state: {}, agents: [], entryCount: 1, ...(readOnly ? { readOnly } : {}) });
      await send(peer, { t: "snapshot-chunk", entries: guestEntries, final: true });
    }
    if (frame.t === "prompt") {
      await send(0, { t: "entry", entry: { type: "custom_message", id: "e2", customType: "collab-prompt", content: frame.text, details: { from: "discord" } } });
      await send(0, { t: "event", event: { type: "agent_start" } });
      await send(0, { t: "event", event: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Runn" }], timestamp: 7 } } });
      await send(0, { t: "event", event: { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "npm test" }, intent: "Running tests" } });
      await send(0, { t: "event", event: { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] } } });
      await send(0, { t: "event", event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Running tests: ok" }], timestamp: 7 } } });
      await send(0, { t: "event", event: { type: "agent_end" } });
    }
  });
  const link = `http://127.0.0.1/#${relayUrl}/r/${ROOM}.${Buffer.concat([key, writeToken]).toString("base64url")}`;
  return { ws, send, received, link };
}

const HOST: CollabHost = { instanceId: "i1", generation: 1, pid: 42, sessionId: "sess-1", cwd: "/proj", relayConnected: true, access: "control" };

describe("collab relay + guest", () => {
  let relay: CollabRelay | null = null;
  afterEach(async () => {
    await relay?.close();
    relay = null;
  });

  it("joins a terminal session, runs a Discord prompt in it, and streams the terminal's activity", async () => {
    relay = await startCollabRelay(0);
    const host = await fakeHost(relay.url);
    const guest = new CollabGuest(parseCollabLink(host.link), "discord");
    const joined = await guest.join();
    expect(joined).toEqual({ sessionId: "sess-1", entries: [expect.objectContaining({ id: "e1" })] });

    const events: LiveEvent[] = [];
    const session = new CollabSession(HOST, guest, joined, "thread-1", (threadId, event) => { if (threadId === "thread-1") events.push(event); }, "discord");
    await session.prompt("run the tests");

    const hello = host.received.find((entry) => entry.frame.t === "hello");
    const prompt = host.received.find((entry) => entry.frame.t === "prompt");
    expect(hello?.frame).toMatchObject({ proto: 3, name: "discord" });
    expect(prompt).toEqual({ peer: hello?.peer, frame: { t: "prompt", text: "run the tests" } });
    expect(prompt?.peer).toBeGreaterThan(0);
    expect(events).toEqual([
      { type: "text", key: "msg:7", text: "Runn" },
      { type: "tool", key: "tool:t1", name: "bash", title: "Running tests", detail: "npm test", state: "running" },
      { type: "tool", key: "tool:t1", name: "bash", title: "Running tests", detail: "npm test", state: "ok", output: "ok" },
      { type: "text", key: "msg:7", text: "Running tests: ok" },
    ]);
    expect(session.entries.map((entry) => entry.id)).toEqual(["e1", "e2"]);

    const closed = Promise.withResolvers<string>();
    session.onClosed = closed.resolve;
    await host.send(0, { t: "entry", entry: { type: "message", id: "e3", message: { role: "user", content: "typed in the TUI", timestamp: 9 } } });
    host.ws.close();
    expect(await closed.promise).toBe("room closed");
    expect(events.at(-1)).toEqual({ type: "user", key: "e3", author: "🖥️ terminal", text: "typed in the TUI" });
  });

  it("refuses a view-only link and a missing room", async () => {
    relay = await startCollabRelay(0);
    const host = await fakeHost(relay.url);
    const viewOnly = parseCollabLink(host.link);
    const { writeToken: _dropped, ...view } = viewOnly;
    await expect(new CollabGuest(view, "discord").join()).rejects.toThrow(/view-only/);
    const missing = { ...viewOnly, wsUrl: `${relay.url}/r/BBBBBBBBBBBBBBBBBBBBBB` };
    await expect(new CollabGuest(missing, "discord").join()).rejects.toThrow("no such room");
    host.ws.close();
  });
});
