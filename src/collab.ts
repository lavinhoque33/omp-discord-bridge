/**
 * Guest side of omp's collab protocol (v3, see oh-my-pi `packages/wire` and `packages/collab-web`).
 *
 * An omp TUI with `collab.autoStart: control` hosts its session in a relay room and lists itself in
 * `omp collab list`. The bridge joins that room as a writable guest: prompts from Discord run inside
 * the TUI's own session (no second process, no forked history), and everything the TUI does streams
 * back as live events. Frames are AES-256-GCM sealed JSON; the relay only routes them.
 */
import { execFile } from "node:child_process";
import { webcrypto } from "node:crypto";
import { promisify } from "node:util";
import WebSocket from "ws";
import { toolDetail, toolResultText } from "./live.js";
import { SESSION_HISTORY, tailTranscript } from "./omp-session.js";
import type { LiveEvent, LiveSink, OmpPromptResult, OmpSessionHandle, SessionTranscript, SessionTranscriptEntry } from "./types.js";

export const COLLAB_PROTO = 3;
const DEFAULT_RELAY_URL = "wss://my.omp.sh";
const ROOM_KEY_BYTES = 32;
const WRITE_TOKEN_BYTES = 16;
const ENVELOPE_HEADER_LENGTH = 4;
const IV_LENGTH = 12;
const JOIN_TIMEOUT_MS = 30_000;
const CLI_TIMEOUT_MS = 15_000;
/** customType of prompts that collab guests inject into the host session. */
const COLLAB_PROMPT = "collab-prompt";
const RELAY_CLOSE_REASONS: Record<number, string> = {
  4001: "room closed",
  4004: "no such room",
  4009: "a host is already connected for this room",
  4029: "room is full",
};

// ── Wire shapes (the subset the bridge reads) ──────────────────────────────

type TextPart = { type: "text"; text: string };
type WireMessage = {
  role: "user" | "assistant" | "developer" | "toolResult";
  content: string | Array<{ type: string; text?: string }>;
  synthetic?: boolean;
  timestamp: number;
  stopReason?: string;
  errorMessage?: string;
};
export type SessionEntry =
  | { type: "message"; id: string; message: WireMessage }
  | { type: "custom_message"; id: string; customType: string; content: WireMessage["content"]; details?: { from?: string } }
  | { type: "compaction" | "branch_summary" | "model_change" | "thinking_level_change"; id: string };
type AgentEvent =
  | { type: "agent_start" | "agent_end" }
  | { type: "message_update" | "message_end"; message: WireMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; intent?: string }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
  | { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string };
type UiRequest = { reqId: number; kind: "select" | "editor"; title: string; options?: Array<string | { label: string }> };
type HostFrame =
  | { t: "welcome"; proto: number; header: { id: string; cwd: string; title?: string }; entryCount: number; readOnly?: boolean }
  | { t: "snapshot-chunk"; entries: SessionEntry[]; final: boolean }
  | { t: "entry"; entry: SessionEntry }
  | { t: "event"; event: AgentEvent }
  | { t: "ui-request"; request: UiRequest }
  | { t: "bye"; reason: string }
  | { t: "error"; message: string };
type GuestFrame =
  | { t: "hello"; proto: number; name: string; writeToken?: string }
  | { t: "prompt"; text: string }
  | { t: "abort" };

// ── Links ──────────────────────────────────────────────────────────────────

export type ParsedCollabLink = { wsUrl: string; roomId: string; key: Uint8Array; writeToken?: Uint8Array };

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]+))?$/;
const BARE_LINK_RE = /^([A-Za-z0-9_-]{10,64})[#.]([A-Za-z0-9_-]+)$/;
const LOCAL_HOSTNAMES: Record<string, true> = { localhost: true, "127.0.0.1": true, "::1": true, "[::1]": true };

/** Parses every link form `omp collab link` emits: browser deep links, direct relay URLs, bare `<room>.<key>`. */
export function parseCollabLink(link: string): ParsedCollabLink {
  let text = link.trim().replace(/%23/gi, "#");
  const bare = BARE_LINK_RE.exec(text);
  if (bare) text = `${DEFAULT_RELAY_URL}/r/${bare[1]}.${bare[2]}`;
  else if (!text.includes("://")) text = `wss://${text}`;
  const url = new URL(text);
  const fragment = url.hash.slice(1);
  if ((url.protocol === "http:" || url.protocol === "https:") && fragment && !ROOM_PATH_RE.test(url.pathname)) return parseCollabLink(fragment);
  const scheme = url.protocol === "wss:" || url.protocol === "https:" ? "wss:" : url.protocol === "ws:" || url.protocol === "http:" ? "ws:" : null;
  if (!scheme) throw new Error(`unsupported collab relay scheme ${url.protocol}`);
  if (scheme === "ws:" && !LOCAL_HOSTNAMES[url.hostname]) throw new Error("plain ws:// collab relays are only allowed on localhost");
  const match = ROOM_PATH_RE.exec(url.pathname);
  if (!match?.[1]) throw new Error("collab link has no /r/<roomId> path");
  const secret = Buffer.from(match[2] ?? fragment, "base64url");
  if (secret.byteLength !== ROOM_KEY_BYTES && secret.byteLength !== ROOM_KEY_BYTES + WRITE_TOKEN_BYTES) throw new Error("collab link key has the wrong length");
  const origin = `${scheme}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  const writeToken = secret.byteLength > ROOM_KEY_BYTES ? secret.subarray(ROOM_KEY_BYTES) : undefined;
  return { wsUrl: `${origin}/r/${match[1]}`, roomId: match[1], key: secret.subarray(0, ROOM_KEY_BYTES), ...(writeToken ? { writeToken } : {}) };
}

// ── Host registry (omp collab list / link) ──────────────────────────────────

export interface CollabHost {
  instanceId: string;
  generation: number;
  pid: number;
  sessionId: string;
  cwd: string;
  relayConnected: boolean;
  access: "view" | "control";
}

const execFileAsync = promisify(execFile);

export async function listCollabHosts(cliPath: string): Promise<CollabHost[]> {
  const { stdout } = await execFileAsync(cliPath, ["collab", "list", "--json"], { timeout: CLI_TIMEOUT_MS });
  return (JSON.parse(stdout) as { hosts?: CollabHost[] }).hosts ?? [];
}

export async function collabHostLink(cliPath: string, instanceId: string): Promise<string> {
  const { stdout } = await execFileAsync(cliPath, ["collab", "link", instanceId, "--json"], { timeout: CLI_TIMEOUT_MS });
  return (JSON.parse(stdout) as { url: string }).url;
}

// ── Transport ──────────────────────────────────────────────────────────────

/** One guest connection to a relay room. `join` resolves with the host's session snapshot. */
export class CollabGuest {
  onFrame: (frame: HostFrame) => void = () => undefined;
  onClose: (reason: string) => void = () => undefined;
  private ws: WebSocket | null = null;
  private key: Promise<webcrypto.CryptoKey>;
  private sendChain: Promise<void> = Promise.resolve();
  private recvChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private link: ParsedCollabLink, private name: string) {
    this.key = webcrypto.subtle.importKey("raw", link.key, "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  join(): Promise<{ sessionId: string; entries: SessionEntry[] }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ sessionId: string; entries: SessionEntry[] }>();
    const entries: SessionEntry[] = [];
    let sessionId: string | null = null;
    let joined = false;
    const fail = (error: Error) => {
      if (joined) return;
      joined = true;
      clearTimeout(timer);
      this.close();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("timed out joining the terminal session")), JOIN_TIMEOUT_MS);
    this.onFrame = (frame) => {
      if (frame.t === "error") return fail(new Error(frame.message));
      if (frame.t === "welcome") {
        if (frame.proto !== COLLAB_PROTO) return fail(new Error(`omp speaks collab v${frame.proto}, the bridge speaks v${COLLAB_PROTO}`));
        if (frame.readOnly) return fail(new Error("the terminal only offers a view-only link; set collab.autoStart to control"));
        sessionId = frame.header.id;
        return;
      }
      if (frame.t !== "snapshot-chunk" || !sessionId) return;
      entries.push(...frame.entries);
      if (!frame.final) return;
      joined = true;
      clearTimeout(timer);
      resolve({ sessionId, entries });
    };
    this.onClose = (reason) => fail(new Error(reason));
    const ws = new WebSocket(`${this.link.wsUrl}?role=guest`);
    ws.binaryType = "nodebuffer";
    this.ws = ws;
    ws.on("open", () => {
      const writeToken = this.link.writeToken ? Buffer.from(this.link.writeToken).toString("base64url") : undefined;
      this.send({ t: "hello", proto: COLLAB_PROTO, name: this.name, ...(writeToken ? { writeToken } : {}) });
    });
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
      this.recvChain = this.recvChain.then(() => this.receive(bytes)).catch((error) => {
        process.stderr.write(`[collab] ${error instanceof Error ? error.message : String(error)}\n`);
      });
    });
    // Through the receive chain, so frames the relay delivered before closing are applied first.
    ws.on("close", (code, reason) => {
      this.recvChain = this.recvChain.then(() => this.finish(RELAY_CLOSE_REASONS[code] ?? (reason.toString() || `connection lost (code ${code})`)));
    });
    ws.on("error", () => undefined);
    return promise;
  }

  send(frame: GuestFrame): void {
    this.sendChain = this.sendChain.then(async () => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const iv = webcrypto.getRandomValues(new Uint8Array(IV_LENGTH));
      const sealed = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.key, Buffer.from(JSON.stringify(frame))));
      const envelope = Buffer.alloc(ENVELOPE_HEADER_LENGTH + IV_LENGTH + sealed.byteLength);
      envelope.set(iv, ENVELOPE_HEADER_LENGTH);
      envelope.set(sealed, ENVELOPE_HEADER_LENGTH + IV_LENGTH);
      ws.send(envelope);
    }).catch(() => undefined);
  }

  close(reason = "closed"): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000);
    this.finish(reason);
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose(reason);
  }

  private async receive(bytes: Buffer): Promise<void> {
    if (bytes.byteLength <= ENVELOPE_HEADER_LENGTH + IV_LENGTH) return;
    const iv = bytes.subarray(ENVELOPE_HEADER_LENGTH, ENVELOPE_HEADER_LENGTH + IV_LENGTH);
    let plain: ArrayBuffer;
    try {
      plain = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, await this.key, bytes.subarray(ENVELOPE_HEADER_LENGTH + IV_LENGTH));
    } catch {
      this.close("bad room key or corrupted frame");
      return;
    }
    this.onFrame(JSON.parse(Buffer.from(plain).toString("utf8")) as HostFrame);
  }
}

// ── Session ────────────────────────────────────────────────────────────────

function messageText(content: WireMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.filter((part): part is TextPart => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n\n");
}

/** History of a joined session in the same shape as an ACP `session/load` replay. */
export function transcriptFromEntries(entries: SessionEntry[]): SessionTranscript {
  const collected: SessionTranscriptEntry[] = [];
  let toolCalls = 0;
  const add = (role: SessionTranscriptEntry["role"], text: string) => {
    if (!text.trim()) return;
    const previous = collected[collected.length - 1];
    if (previous?.role === role) previous.text += `\n\n${text}`;
    else collected.push({ role, text });
  };
  for (const entry of entries) {
    if (entry.type === "custom_message" && entry.customType === COLLAB_PROMPT) add("user", messageText(entry.content));
    if (entry.type !== "message") continue;
    const { message } = entry;
    if (message.role === "user" && !message.synthetic) add("user", messageText(message.content));
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    toolCalls += message.content.filter((part) => part.type === "toolCall").length;
    add("assistant", messageText(message.content));
  }
  return { entries: tailTranscript(collected, SESSION_HISTORY), toolCalls, totalMessages: collected.length };
}

/**
 * A live omp TUI session joined as a collab guest. Prompts run inside the TUI's session; the TUI's
 * own activity (your typed prompts, streamed replies, tool calls) is forwarded to `threadId`.
 */
export class CollabSession implements OmpSessionHandle {
  readonly id: string;
  entries: SessionEntry[];
  onClosed: (reason: string) => void = () => undefined;
  private pending: { accepted: boolean; resolve: () => void; reject: (error: Error) => void } | null = null;
  private tools = new Map<string, { name: string; title: string; detail?: string }>();

  constructor(readonly host: CollabHost, private guest: CollabGuest, joined: { sessionId: string; entries: SessionEntry[] }, public threadId: string, private sink: LiveSink, private name: string) {
    this.id = joined.sessionId;
    this.entries = joined.entries;
    guest.onFrame = (frame) => this.receive(frame);
    guest.onClose = (reason) => {
      this.pending?.reject(new Error(`terminal session closed: ${reason}`));
      this.pending = null;
      this.onClosed(reason);
    };
  }

  async prompt(message: string, signal?: AbortSignal): Promise<OmpPromptResult> {
    if (this.pending) throw new Error("a Discord prompt is already running in this terminal session");
    if (signal?.aborted) throw new Error("aborted");
    const { promise: done, resolve, reject } = Promise.withResolvers<void>();
    this.pending = { accepted: false, resolve, reject };
    const abort = () => this.guest.send({ t: "abort" });
    signal?.addEventListener("abort", abort, { once: true });
    this.guest.send({ t: "prompt", text: message });
    try {
      await done;
      return {};
    } finally {
      this.pending = null;
      signal?.removeEventListener("abort", abort);
    }
  }

  /** The host steers a prompt into the running turn when it is busy, so follow-ups are plain prompts. */
  steer(message: string): void {
    this.guest.send({ t: "prompt", text: message });
  }

  abort(): void {
    this.guest.send({ t: "abort" });
  }

  close(reason?: string): void {
    this.guest.close(reason);
  }

  private emit(event: LiveEvent): void {
    this.sink(this.threadId, event);
  }

  private receive(frame: HostFrame): void {
    switch (frame.t) {
      case "entry":
        this.entries.push(frame.entry);
        this.receiveEntry(frame.entry);
        return;
      case "event":
        this.receiveEvent(frame.event);
        return;
      case "ui-request": {
        const options = (frame.request.options ?? []).map((option) => `\`${typeof option === "string" ? option : option.label}\``).join(" · ");
        this.emit({ type: "notice", key: `ask:${frame.request.reqId}`, text: `❓ omp is asking in the terminal: **${frame.request.title}**${options ? ` — ${options}` : ""}` });
        return;
      }
      case "error":
        if (this.pending) this.pending.reject(new Error(frame.message));
        else this.emit({ type: "notice", key: `error:${Date.now()}`, text: `⚠️ ${frame.message}` });
        return;
      case "bye":
        this.guest.close(frame.reason);
        return;
      default:
        return;
    }
  }

  private receiveEntry(entry: SessionEntry): void {
    if (entry.type === "custom_message" && entry.customType === COLLAB_PROMPT) {
      if (entry.details?.from === this.name) {
        if (this.pending) this.pending.accepted = true;
        return;
      }
      this.emit({ type: "user", key: entry.id, author: entry.details?.from ?? "guest", text: messageText(entry.content) });
      return;
    }
    if (entry.type === "message" && entry.message.role === "user" && !entry.message.synthetic) {
      this.emit({ type: "user", key: entry.id, author: "🖥️ terminal", text: messageText(entry.message.content) });
    }
  }

  private receiveEvent(event: AgentEvent): void {
    switch (event.type) {
      case "agent_start":
        if (this.pending) this.pending.accepted = true;
        return;
      case "agent_end":
        if (this.pending?.accepted) this.pending.resolve();
        return;
      case "message_update":
      case "message_end": {
        if (event.message.role !== "assistant") return;
        this.emit({ type: "text", key: `msg:${event.message.timestamp}`, text: messageText(event.message.content) });
        if (event.type === "message_end" && event.message.stopReason === "error" && event.message.errorMessage) {
          this.emit({ type: "notice", key: `msg-error:${event.message.timestamp}`, text: `⚠️ ${event.message.errorMessage}` });
        }
        return;
      }
      case "tool_execution_start": {
        const detail = toolDetail(event.args, event.intent);
        const tool = { name: event.toolName, title: event.intent ?? "", ...(detail ? { detail } : {}) };
        this.tools.set(event.toolCallId, tool);
        this.emit({ type: "tool", key: `tool:${event.toolCallId}`, ...tool, state: "running" });
        return;
      }
      case "tool_execution_end": {
        const tool = this.tools.get(event.toolCallId) ?? { name: event.toolName, title: "" };
        this.tools.delete(event.toolCallId);
        const output = toolResultText(event.result);
        this.emit({ type: "tool", key: `tool:${event.toolCallId}`, ...tool, state: event.isError ? "error" : "ok", ...(output ? { output } : {}) });
        return;
      }
      case "notice":
        if (event.level !== "info" && event.source !== "collab") this.emit({ type: "notice", key: `notice:${Date.now()}`, text: `⚠️ ${event.message}` });
        return;
    }
  }
}
