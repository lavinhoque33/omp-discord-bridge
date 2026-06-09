import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream, type AvailableCommand, type Client as AcpClient, type SessionNotification } from "@agentclientprotocol/sdk";
import type { DiscordSessionRecord, OmpSessionFactory, OmpSessionHandle, OmpPromptResult } from "./types.js";

type PendingRpc = { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout };

type RpcLaunchInput = {
  cwd: string;
  sessionDir: string;
  model: string | null;
  thinkingLevel: string | null;
  cliPath?: string;
  env?: Record<string, string>;
};

export type RpcLaunch = { command: string; args: string[]; cwd: string; env: Record<string, string> };

const require = createRequire(import.meta.url);

export function resolveOmpCliPath(): string {
  const lookupPaths = require.resolve.paths("@oh-my-pi/pi-coding-agent") ?? [];
  const candidates = [process.cwd(), path.dirname(new URL(import.meta.url).pathname), ...lookupPaths]
    .flatMap((base) => [
      path.join(base, "node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts"),
      path.join(base, "../node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts"),
      path.join(base, "../../node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts"),
    ]);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error("Unable to locate @oh-my-pi/pi-coding-agent/src/cli.ts for RPC mode");
}

function buildOmpLaunch(input: RpcLaunchInput, mode: "rpc" | "acp"): RpcLaunch {
  const args = [input.cliPath ?? resolveOmpCliPath(), "--mode", mode, "--session-dir", input.sessionDir];
  if (input.model) args.push("--model", input.model);
  return {
    command: "bun",
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

export function buildRpcLaunch(input: RpcLaunchInput): RpcLaunch { return buildOmpLaunch(input, "rpc"); }
export function buildAcpLaunch(input: RpcLaunchInput): RpcLaunch { return buildOmpLaunch(input, "acp"); }

function extractTextDelta(event: any): string {
  if (event?.type !== "message_update") return "";
  const assistant = event.assistantMessageEvent ?? event.messageEvent ?? event.delta;
  if (assistant?.type === "text_delta" && typeof assistant.delta === "string") return assistant.delta;
  if (assistant?.type === "text" && typeof assistant.text === "string") return assistant.text;
  if (typeof event.delta === "string") return event.delta;
  return "";
}

class RpcProcessSessionHandle implements OmpSessionHandle {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRpc>();
  private nextId = 0;
  private ready: Promise<void> | null = null;
  private textBuffer = "";
  private waitingForAgentEnd: { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout } | null = null;

  constructor(private record: DiscordSessionRecord, private options: { cliPath?: string; env?: Record<string, string> } = {}) {}

  get id(): string { return this.record.threadId; }

  async prompt(message: string, signal?: AbortSignal): Promise<OmpPromptResult> {
    await this.start();
    this.textBuffer = "";
    if (signal?.aborted) throw new Error("aborted");
    const abort = () => { void this.abort(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const done = this.waitForAgentEnd();
      await this.send({ type: "prompt", message }, 30_000);
      await done;
      const state = await this.send({ type: "get_state" }, 30_000).catch(() => undefined);
      const sessionFile = state?.data?.sessionFile ?? path.join(this.record.sessionDir, `${this.record.threadId}.json`);
      return { text: this.textBuffer || "(OMP completed without text output)", sessionFile };
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async abort(): Promise<void> {
    if (!this.child) return;
    await this.send({ type: "abort" }, 5_000).catch(() => undefined);
  }

  async steer(message: string): Promise<void> {
    await this.start();
    await this.send({ type: "steer", message }, 30_000);
  }

  async compact(): Promise<void> {
    await this.start();
    await this.send({ type: "compact" }, 120_000);
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("RPC session closed"));
    }
    this.pending.clear();
    if (this.waitingForAgentEnd) {
      clearTimeout(this.waitingForAgentEnd.timer);
      this.waitingForAgentEnd.reject(new Error("RPC session closed"));
      this.waitingForAgentEnd = null;
    }
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }

  private async start(): Promise<void> {
    if (this.ready) return this.ready;
    const launch = buildRpcLaunch({
      cwd: this.record.cwd,
      sessionDir: this.record.sessionDir,
      model: this.record.model,
      thinkingLevel: this.record.thinkingLevel,
      ...(this.options.cliPath ? { cliPath: this.options.cliPath } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
    });
    this.child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.once("exit", (code, signal) => this.handleExit(code, signal));
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk) => process.stderr.write(`[omp-rpc:${this.record.threadId}] ${chunk}`));
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for OMP RPC ready")), 30_000);
      this.pending.set("__ready__", { resolve: () => { clearTimeout(timer); resolve(); }, reject, timer });
    });
    await this.ready;
    if (this.record.thinkingLevel) await this.send({ type: "set_thinking_level", level: this.record.thinkingLevel }, 30_000);
  }

  private handleLine(line: string): void {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg?.type === "ready") {
      const pending = this.pending.get("__ready__");
      if (pending) { this.pending.delete("__ready__"); pending.resolve(undefined); }
      return;
    }
    if (msg?.type === "response" && typeof msg.id === "string") {
      const pending = this.pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        msg.success ? pending.resolve(msg) : pending.reject(new Error(msg.error ?? `RPC ${msg.command} failed`));
      }
      return;
    }
    if (msg?.type === "extension_ui_request" && typeof msg.id === "string") {
      this.write({ type: "extension_ui_response", id: msg.id, cancelled: true });
      return;
    }
    const delta = extractTextDelta(msg);
    if (delta) this.textBuffer += delta;
    if (msg?.type === "agent_end" && this.waitingForAgentEnd) {
      clearTimeout(this.waitingForAgentEnd.timer);
      this.waitingForAgentEnd.resolve();
      this.waitingForAgentEnd = null;
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const error = new Error(`OMP RPC process exited (${signal ?? code ?? "unknown"})`);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (this.waitingForAgentEnd) {
      clearTimeout(this.waitingForAgentEnd.timer);
      this.waitingForAgentEnd.reject(error);
      this.waitingForAgentEnd = null;
    }
    this.child = null;
    this.ready = null;
  }

  private send(command: Record<string, unknown>, timeoutMs: number): Promise<any> {
    const id = `req_${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for OMP RPC response to ${command.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ ...command, id });
    });
  }

  private write(frame: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) throw new Error("OMP RPC process is not writable");
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private waitForAgentEnd(timeoutMs = 10 * 60_000): Promise<void> {
    if (this.waitingForAgentEnd) return Promise.reject(new Error("OMP RPC prompt already running"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waitingForAgentEnd = null;
        reject(new Error("Timed out waiting for OMP RPC agent_end"));
      }, timeoutMs);
      this.waitingForAgentEnd = { resolve, reject, timer };
    });
  }
}

export class RpcOmpSessionFactory implements OmpSessionFactory {
  private handles = new Map<string, RpcProcessSessionHandle>();
  constructor(private options: { cliPath?: string; env?: Record<string, string> } = {}) {}
  async open(record: DiscordSessionRecord): Promise<OmpSessionHandle> {
    const cached = this.handles.get(record.threadId);
    if (cached) return cached;
    const handle = new RpcProcessSessionHandle(record, this.options);
    this.handles.set(record.threadId, handle);
    return handle;
  }
  async newSession(record: DiscordSessionRecord): Promise<OmpSessionHandle> {
    this.handles.get(record.threadId)?.close();
    this.handles.delete(record.threadId);
    return this.open(record);
  }
  close(): void {
    for (const handle of this.handles.values()) handle.close();
    this.handles.clear();
  }
}
export class AcpOmpSessionFactory implements OmpSessionFactory {
  private handles = new Map<string, AcpProcessSessionHandle>();
  constructor(private options: { cliPath?: string; env?: Record<string, string> } = {}) {}
  async open(record: DiscordSessionRecord): Promise<OmpSessionHandle> {
    const cached = this.handles.get(record.threadId);
    if (cached) return cached;
    const handle = new AcpProcessSessionHandle(record, this.options);
    this.handles.set(record.threadId, handle);
    return handle;
  }
  async newSession(record: DiscordSessionRecord): Promise<OmpSessionHandle> {
    this.handles.get(record.threadId)?.close();
    this.handles.delete(record.threadId);
    return this.open(record);
  }
  close(): void {
    for (const handle of this.handles.values()) handle.close();
    this.handles.clear();
  }
}

class AcpProcessSessionHandle implements OmpSessionHandle {
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private ready: Promise<void> | null = null;
  private textBuffer = "";
  private commands: AvailableCommand[] = [];

  constructor(private record: DiscordSessionRecord, private options: { cliPath?: string; env?: Record<string, string> } = {}) {}

  get id(): string { return this.record.threadId; }

  async prompt(message: string, signal?: AbortSignal): Promise<OmpPromptResult> {
    await this.start();
    if (!this.connection || !this.sessionId) throw new Error("ACP session not ready");
    this.textBuffer = "";
    if (signal?.aborted) throw new Error("aborted");
    const abort = () => { void this.abort(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.connection.prompt({ sessionId: this.sessionId, prompt: [{ type: "text", text: message }] });
      return { text: this.textBuffer || "(OMP completed without text output)", sessionFile: path.join(this.record.sessionDir, `${this.record.threadId}.json`) };
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
    const created = await this.connection.newSession({ cwd: this.record.cwd, mcpServers: [] });
    this.sessionId = created.sessionId;
  }

  private handleSessionUpdate(params: SessionNotification): void {
    if (this.sessionId && params.sessionId !== this.sessionId) return;
    const update: any = params.update;
    if (update?.sessionUpdate === "available_commands_update" && Array.isArray(update.availableCommands)) this.commands = update.availableCommands;
    if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string") this.textBuffer += update.content.text;
  }
}


export class SdkOmpSessionFactory implements OmpSessionFactory {
  async open(record: DiscordSessionRecord): Promise<OmpSessionHandle> { return this.create(record); }
  async newSession(record: DiscordSessionRecord): Promise<OmpSessionHandle> { return this.create(record); }
  private async create(record: DiscordSessionRecord): Promise<OmpSessionHandle> {
    const mod = await import("@oh-my-pi/pi-coding-agent/sdk");
    const { SessionManager } = await import("@oh-my-pi/pi-coding-agent/session/session-manager");
    const sessionManager = SessionManager.create(record.sessionDir);
    const { session } = await mod.createAgentSession({
      cwd: record.cwd,
      sessionManager,
      ...(record.thinkingLevel ? { thinkingLevel: record.thinkingLevel as any } : {}),
      hasUI: false,
    });
    let buffer = "";
    session.subscribe?.((event: any) => { buffer += extractTextDelta(event); });
    return {
      id: record.threadId,
      async prompt(message: string, signal?: AbortSignal): Promise<OmpPromptResult> {
        buffer = "";
        if (signal?.aborted) throw new Error("aborted");
        const abort = () => { void session.abort?.(); };
        signal?.addEventListener("abort", abort, { once: true });
        try {
          const response = await session.prompt(message);
          const text = typeof response === "string" ? response : buffer || response?.text || "";
          return { text: text || "(OMP completed without text output)", sessionFile: session.sessionFile ?? path.join(record.sessionDir, `${record.threadId}.json`) };
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      },
      steer: (message) => session.steer?.(message),
      abort: () => session.abort?.(),
      compact: () => session.compact?.(),
    };
  }
}

export class FakeOmpSessionFactory implements OmpSessionFactory {
  prompts: string[] = [];
  steers: string[] = [];
  sessionsCreated = 0;
  constructor(private responder: (message: string) => string | Promise<string> = (message) => `echo: ${message}`) {}
  async open(record: DiscordSessionRecord): Promise<OmpSessionHandle> { return this.handle(record); }
  async newSession(record: DiscordSessionRecord): Promise<OmpSessionHandle> { this.sessionsCreated += 1; return this.handle(record); }
  private async handle(record: DiscordSessionRecord): Promise<OmpSessionHandle> {
    return {
      id: record.threadId,
      prompt: async (message, signal) => {
        if (signal?.aborted) throw new Error("aborted");
        this.prompts.push(message);
        return { text: await this.responder(message), sessionFile: path.join(record.sessionDir, `${record.threadId}.json`) };
      },
      steer: async (message) => { this.steers.push(message); },
      abort: async () => undefined,
      compact: async () => undefined,
    };
  }
}
