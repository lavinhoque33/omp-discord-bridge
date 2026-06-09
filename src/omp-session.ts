import path from "node:path";
import type { DiscordSessionRecord, OmpSessionFactory, OmpSessionHandle, OmpPromptResult } from "./types.js";

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
    session.subscribe?.((event: any) => {
      if (event?.type === "message_update") {
        const assistant = event.assistantMessageEvent;
        if (assistant?.type === "text_delta" && typeof assistant.delta === "string") buffer += assistant.delta;
      }
    });
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
      abort: () => session.abort?.(),
      compact: () => session.compact?.(),
    };
  }
}

export class FakeOmpSessionFactory implements OmpSessionFactory {
  prompts: string[] = [];
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
      abort: async () => undefined,
      compact: async () => undefined,
    };
  }
}
