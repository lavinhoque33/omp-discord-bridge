import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream, type AvailableCommand, type Client as AcpClient, type SessionNotification } from "@agentclientprotocol/sdk";
import type { DiscordSessionRecord, OmpSessionFactory, OmpSessionHandle, OmpPromptResult } from "./types.js";

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
