import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream, type AvailableCommand, type Client as AcpClient, type SessionInfo, type SessionNotification } from "@agentclientprotocol/sdk";
import { toolDetail, toolResultText } from "./live.js";
import type { DiscordSessionRecord, LiveEvent, LiveSink, OmpSessionFactory, OmpSessionHandle, OmpPromptResult, OmpSessionSummary, SessionTranscript, SessionTranscriptEntry } from "./types.js";

type AcpLaunchInput = {
  cwd: string;
  sessionDir: string;
  model: string | null;
  thinkingLevel: string | null;
  cliPath?: string;
  env?: Record<string, string>;
};

export type AcpLaunch = { command: string; args: string[]; cwd: string; env: Record<string, string> };

export function resolveOmpCliCommand(): string {
  if (process.env.OMP_CLI_PATH) return process.env.OMP_CLI_PATH;
  for (const candidate of [
    path.join(os.homedir(), ".cache/.bun/bin/omp"),
    path.join(os.homedir(), ".bun/bin/omp"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "omp";
}

export function buildAcpLaunch(input: AcpLaunchInput): AcpLaunch {
  const command = input.cliPath ?? resolveOmpCliCommand();
  const args = ["acp", "--session-dir", input.sessionDir];
  if (input.model) args.push("--model", input.model);
  return {
    command,
    args,
    cwd: input.cwd,
    env: {
      ...process.env,
      PI_NOTIFICATIONS: "off",
      PI_NO_TITLE: "1",
      ...(input.env ?? {}),
    } as Record<string, string>,
  };
}

const SESSION_LIST_TIMEOUT_MS = 20_000;

/**
 * Short-lived ACP connection used only to enumerate omp sessions on this machine (`session/list`).
 * The process is killed as soon as the list is read, or after a hard timeout.
 */
export async function listAcpSessions(input: { cwd: string; sessionDir: string; cliPath?: string; env?: Record<string, string> }): Promise<OmpSessionSummary[]> {
  const launch = buildAcpLaunch({
    cwd: input.cwd,
    sessionDir: input.sessionDir,
    model: null,
    thinkingLevel: null,
    ...(input.cliPath ? { cliPath: input.cliPath } : {}),
    ...(input.env ? { env: input.env } : {}),
  });
  const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => process.stderr.write(`[omp-acp-list] ${chunk}`));
  const client: AcpClient = {
    requestPermission: async (params) => ({
      outcome: { outcome: "selected", optionId: params.options.find((option) => option.kind === "allow_once" || option.kind === "allow_always")?.optionId ?? params.options[0]?.optionId ?? "allow" },
    }),
    sessionUpdate: async () => undefined,
  };
  const connection = new ClientSideConnection(() => client, ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  const timer = setTimeout(() => child.kill(), SESSION_LIST_TIMEOUT_MS);
  try {
    await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    let listed: { sessions: SessionInfo[] };
    try {
      listed = await connection.listSessions({});
    } catch {
      // Older runtimes only answer session/list once the connection owns a session.
      await connection.newSession({ cwd: input.cwd, mcpServers: [] });
      listed = await connection.listSessions({});
    }
    return (listed.sessions ?? []).map((session) => ({
      sessionId: session.sessionId,
      title: session.title ?? null,
      cwd: session.cwd ?? null,
      updatedAt: session.updatedAt ?? null,
    }));
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

/** How much of an existing session a newly opened thread replays. */
export const SESSION_HISTORY = { messages: 20, chars: 8_000 };

/** Keeps the newest entries that fit the budget, oldest first, each capped to the char budget. */
export function tailTranscript(entries: SessionTranscriptEntry[], options: { messages: number; chars: number }): SessionTranscriptEntry[] {
  const kept = entries
    .filter((entry) => entry.text.trim().length > 0)
    .slice(-options.messages)
    .map((entry): SessionTranscriptEntry => ({ role: entry.role, text: entry.text.trim().slice(0, options.chars) }));
  let total = kept.reduce((sum, entry) => sum + entry.text.length, 0);
  while (kept.length > 1 && total > options.chars) {
    const dropped = kept.shift();
    if (dropped) total -= dropped.text.length;
  }
  return kept;
}

/**
 * Replays an existing session's conversation over ACP (`session/load`) so a freshly opened Discord
 * thread can show what was already said. Read-only: nothing is prompted and the process is killed
 * as soon as the replay completes (or after a hard timeout).
 */
export async function loadAcpTranscript(input: { cwd: string; sessionDir: string; sessionId: string; cliPath?: string; env?: Record<string, string> }): Promise<SessionTranscript> {
  const launch = buildAcpLaunch({
    cwd: input.cwd,
    sessionDir: input.sessionDir,
    model: null,
    thinkingLevel: null,
    ...(input.cliPath ? { cliPath: input.cliPath } : {}),
    ...(input.env ? { env: input.env } : {}),
  });
  const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => process.stderr.write(`[omp-acp-history] ${chunk}`));
  const collected: SessionTranscriptEntry[] = [];
  let toolCalls = 0;
  const client: AcpClient = {
    requestPermission: async (params) => ({
      outcome: { outcome: "selected", optionId: params.options.find((option) => option.kind === "allow_once" || option.kind === "allow_always")?.optionId ?? params.options[0]?.optionId ?? "allow" },
    }),
    sessionUpdate: async (params) => {
      const update = params.update;
      if (update.sessionUpdate === "tool_call") toolCalls += 1;
      if (update.sessionUpdate !== "user_message_chunk" && update.sessionUpdate !== "agent_message_chunk") return;
      if (update.content.type !== "text") return;
      const role: SessionTranscriptEntry["role"] = update.sessionUpdate === "user_message_chunk" ? "user" : "assistant";
      const previous = collected[collected.length - 1];
      if (previous?.role === role) previous.text += update.content.text;
      else collected.push({ role, text: update.content.text });
    },
  };
  const connection = new ClientSideConnection(() => client, ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  const timer = setTimeout(() => child.kill(), SESSION_LIST_TIMEOUT_MS);
  try {
    await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await connection.loadSession({ sessionId: input.sessionId, cwd: input.cwd, mcpServers: [] });
    return { entries: tailTranscript(collected, SESSION_HISTORY), toolCalls, totalMessages: collected.length };
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

type AcpFactoryOptions = { cliPath?: string; env?: Record<string, string>; sink?: LiveSink };

export class AcpOmpSessionFactory implements OmpSessionFactory {
  private handles = new Map<string, AcpProcessSessionHandle>();
  constructor(private options: AcpFactoryOptions = {}) {}
  async listSessions(record: DiscordSessionRecord): Promise<OmpSessionSummary[]> {
    return listAcpSessions({
      cwd: record.cwd,
      sessionDir: record.sessionDir,
      ...(this.options.cliPath ? { cliPath: this.options.cliPath } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
    });
  }
  async loadTranscript(record: DiscordSessionRecord): Promise<SessionTranscript> {
    if (!record.resumeSessionId) return { entries: [], toolCalls: 0, totalMessages: 0 };
    return loadAcpTranscript({
      cwd: record.cwd,
      sessionDir: record.sessionDir,
      sessionId: record.resumeSessionId,
      ...(this.options.cliPath ? { cliPath: this.options.cliPath } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
    });
  }
  async open(record: DiscordSessionRecord): Promise<OmpSessionHandle> {
    const cached = this.handles.get(record.threadId);
    if (cached) return cached;
    const handle = new AcpProcessSessionHandle(record, this.options);
    this.handles.set(record.threadId, handle);
    return handle;
  }
  async newSession(record: DiscordSessionRecord): Promise<OmpSessionHandle> {
    this.closeThread(record.threadId);
    return this.open(record);
  }
  /** Drops the thread's omp process; the next `open` starts (or resumes) from the session file again. */
  closeThread(threadId: string): void {
    this.handles.get(threadId)?.close();
    this.handles.delete(threadId);
  }
  close(): void {
    for (const handle of this.handles.values()) handle.close();
    this.handles.clear();
  }
}

/** Turns ACP session updates into keyed live events: streamed text blocks and tool calls. */
export class AcpLiveTranslator {
  private turn = 0;
  private blocks = 0;
  private textKey: string | null = null;
  private text = "";
  private tools = new Map<string, { title: string; detail?: string }>();

  constructor(private emit: (event: LiveEvent) => void) {}

  startTurn(): void {
    this.turn += 1;
    this.textKey = null;
    this.tools.clear();
  }

  update(update: SessionNotification["update"]): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type !== "text") return;
        if (!this.textKey) {
          this.textKey = `acp:${this.turn}:${this.blocks++}`;
          this.text = "";
        }
        this.text += update.content.text;
        this.emit({ type: "text", key: this.textKey, text: this.text });
        return;
      }
      case "tool_call": {
        this.textKey = null;
        const detail = toolDetail(update.rawInput, update.title);
        const tool = { title: update.title, ...(detail ? { detail } : {}) };
        this.tools.set(update.toolCallId, tool);
        this.emit({ type: "tool", key: `tool:${update.toolCallId}`, ...tool, state: "running" });
        return;
      }
      case "tool_call_update": {
        if (update.status !== "completed" && update.status !== "failed") return;
        const tool = this.tools.get(update.toolCallId) ?? { title: update.title ?? "tool" };
        this.tools.delete(update.toolCallId);
        const output = toolResultText(update.rawOutput);
        this.emit({ type: "tool", key: `tool:${update.toolCallId}`, ...tool, state: update.status === "failed" ? "error" : "ok", ...(output ? { output } : {}) });
        return;
      }
      default:
        return;
    }
  }
}

class AcpProcessSessionHandle implements OmpSessionHandle {
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private ready: Promise<void> | null = null;
  private commands: AvailableCommand[] = [];
  private live: AcpLiveTranslator;

  constructor(private record: DiscordSessionRecord, private options: AcpFactoryOptions = {}) {
    this.live = new AcpLiveTranslator((event) => this.options.sink?.(this.record.threadId, event));
  }

  get id(): string { return this.record.threadId; }

  async prompt(message: string, signal?: AbortSignal): Promise<OmpPromptResult> {
    await this.start();
    if (!this.connection || !this.sessionId) throw new Error("ACP session not ready");
    if (signal?.aborted) throw new Error("aborted");
    this.live.startTurn();
    const abort = () => { void this.abort(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.connection.prompt({ sessionId: this.sessionId, prompt: [{ type: "text", text: message }] });
      return { sessionFile: path.join(this.record.sessionDir, `${this.record.threadId}.json`) };
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async abort(): Promise<void> {
    if (this.connection && this.sessionId) await this.connection.cancel({ sessionId: this.sessionId }).catch(() => undefined);
  }

  async availableCommands() {
    await this.start();
    return this.commands.map((command) => ({ name: command.name, description: command.description, ...(command.input?.hint ? { inputHint: command.input.hint } : {}) }));
  }

  close(): void {
    this.child?.kill();
    this.child = null;
    this.connection = null;
    this.sessionId = null;
    this.ready = null;
  }

  private async start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.openAcp();
    return this.ready;
  }

  private async openAcp(): Promise<void> {
    const launch = buildAcpLaunch({ cwd: this.record.cwd, sessionDir: this.record.sessionDir, model: this.record.model, thinkingLevel: this.record.thinkingLevel, ...(this.options.cliPath ? { cliPath: this.options.cliPath } : {}), ...(this.options.env ? { env: this.options.env } : {}) });
    this.child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (chunk) => process.stderr.write(`[omp-acp:${this.record.threadId}] ${chunk}`));
    const client: AcpClient = {
      requestPermission: async (params) => ({ outcome: { outcome: "selected", optionId: params.options.find((option) => option.kind === "allow_once" || option.kind === "allow_always")?.optionId ?? params.options[0]?.optionId ?? "allow" } }),
      sessionUpdate: async (params: SessionNotification) => { this.handleSessionUpdate(params); },
    };
    const stream = ndJsonStream(Writable.toWeb(this.child.stdin), Readable.toWeb(this.child.stdout));
    this.connection = new ClientSideConnection(() => client, stream);
    await this.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const resumeId = this.record.resumeSessionId;
    if (resumeId) {
      await this.connection.resumeSession({ sessionId: resumeId, cwd: this.record.cwd, mcpServers: [] });
      this.sessionId = resumeId;
    } else {
      const created = await this.connection.newSession({ cwd: this.record.cwd, mcpServers: [] });
      this.sessionId = created.sessionId;
    }
  }

  private handleSessionUpdate(params: SessionNotification): void {
    if (this.sessionId && params.sessionId !== this.sessionId) return;
    if (params.update.sessionUpdate === "available_commands_update") this.commands = params.update.availableCommands;
    else this.live.update(params.update);
  }
}

export class FakeOmpSessionFactory implements OmpSessionFactory {
  prompts: string[] = [];
  steers: string[] = [];
  sessionsCreated = 0;
  sessions: OmpSessionSummary[] = [];
  transcript: SessionTranscript = { entries: [], toolCalls: 0, totalMessages: 0 };
  private turns = 0;
  /** Each prompt's reply is streamed to `sink` as one assistant text block. */
  constructor(private responder: (message: string) => string | Promise<string> = (message) => `echo: ${message}`, private sink: LiveSink = () => undefined) {}
  async listSessions(): Promise<OmpSessionSummary[]> { return this.sessions; }
  async loadTranscript(): Promise<SessionTranscript> { return this.transcript; }
  async open(record: DiscordSessionRecord): Promise<OmpSessionHandle> { return this.handle(record); }
  async newSession(record: DiscordSessionRecord): Promise<OmpSessionHandle> { this.sessionsCreated += 1; return this.handle(record); }
  private async handle(record: DiscordSessionRecord): Promise<OmpSessionHandle> {
    return {
      id: record.resumeSessionId ?? record.threadId,
      prompt: async (message, signal) => {
        if (signal?.aborted) throw new Error("aborted");
        this.prompts.push(message);
        const text = await this.responder(message);
        this.sink(record.threadId, { type: "text", key: `fake:${++this.turns}`, text });
        return { sessionFile: path.join(record.sessionDir, `${record.threadId}.json`) };
      },
      steer: async (message) => { this.steers.push(message); },
      abort: async () => undefined,
      compact: async () => undefined,
    };
  }
}
