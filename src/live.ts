import { chunkDiscordMessage } from "./render.js";
import type { LiveEvent, ThreadMessenger } from "./types.js";

const TOOL_OUTPUT_LINES = 12;
const TOOL_OUTPUT_CHARS = 700;
const TOOL_DETAIL_CHARS = 180;
/** Settled blocks kept per thread so late updates (a tool finishing) still edit their message. */
const MAX_BLOCKS = 200;

type Block = { key: string; content: string; sent: string[]; messageIds: string[]; dirty: boolean };

/**
 * Renders omp activity into one Discord thread. Every event maps to a keyed block; a block is
 * posted once and then edited as its content changes (streamed text, tool completion). Edits are
 * coalesced: at most one reconcile pass per `intervalMs`, applied in block order.
 */
class LiveThread {
  private blocks: Block[] = [];
  private byKey = new Map<string, Block>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastPass = 0;

  constructor(private threadId: string, private messenger: ThreadMessenger, private options: { intervalMs: number; messageLimit: number }) {}

  push(event: LiveEvent): void {
    const content = renderLiveEvent(event).trim();
    if (!content) return;
    let block = this.byKey.get(event.key);
    if (!block) {
      block = { key: event.key, content: "", sent: [], messageIds: [], dirty: false };
      this.blocks.push(block);
      this.byKey.set(event.key, block);
    }
    if (block.content === content) return;
    block.content = content;
    block.dirty = true;
    this.schedule();
  }

  /** Resolves once everything pushed so far is visible in Discord. */
  async settle(): Promise<void> {
    for (;;) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (this.running) {
        await this.running;
        continue;
      }
      if (!this.blocks.some((block) => block.dirty)) return;
      await this.pass();
    }
  }

  private schedule(): void {
    if (this.timer || this.running) return;
    const wait = Math.max(0, this.lastPass + this.options.intervalMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.running) void this.pass();
    }, wait);
  }

  private pass(): Promise<void> {
    this.running = this.reconcile().finally(() => {
      this.running = null;
      this.lastPass = Date.now();
      this.prune();
      if (this.blocks.some((block) => block.dirty)) this.schedule();
    });
    return this.running;
  }

  private async reconcile(): Promise<void> {
    for (const block of this.blocks) {
      if (!block.dirty) continue;
      block.dirty = false;
      const chunks = chunkDiscordMessage(block.content, this.options.messageLimit);
      for (const [index, chunk] of chunks.entries()) {
        if (block.sent[index] === chunk) continue;
        try {
          const messageId = block.messageIds[index];
          if (messageId) await this.messenger.edit(this.threadId, messageId, chunk);
          else block.messageIds[index] = await this.messenger.send(this.threadId, chunk);
          block.sent[index] = chunk;
        } catch (error) {
          process.stderr.write(`[live:${this.threadId}] ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    }
  }

  private prune(): void {
    while (this.blocks.length > MAX_BLOCKS && !this.blocks[0]?.dirty) {
      const dropped = this.blocks.shift();
      if (dropped) this.byKey.delete(dropped.key);
    }
  }
}

/** Routes live events to per-thread renderers. */
export class LiveThreads {
  private threads = new Map<string, LiveThread>();

  constructor(private messenger: ThreadMessenger, private options: { intervalMs: number; messageLimit: number }) {}

  readonly push = (threadId: string, event: LiveEvent): void => {
    this.thread(threadId).push(event);
  };

  async settle(threadId: string): Promise<void> {
    await this.threads.get(threadId)?.settle();
  }

  private thread(threadId: string): LiveThread {
    let thread = this.threads.get(threadId);
    if (!thread) {
      thread = new LiveThread(threadId, this.messenger, this.options);
      this.threads.set(threadId, thread);
    }
    return thread;
  }
}

export function renderLiveEvent(event: LiveEvent): string {
  switch (event.type) {
    case "text":
      return event.text;
    case "user":
      return `**${event.author}**\n>>> ${event.text}`;
    case "notice":
      return `-# ${event.text}`;
    case "tool": {
      const icon = event.state === "running" ? "🔧" : event.state === "ok" ? "✅" : "❌";
      const head = event.name ? `**${event.name}**${event.title && event.title !== event.name ? ` · ${event.title}` : ""}` : event.title;
      const lines = [`${icon} ${head}`];
      if (event.detail) lines.push(`\`${event.detail}\``);
      const output = event.state === "running" ? "" : tail(event.output ?? "");
      if (output) lines.push("```", output.replaceAll("```", "`\u200b``"), "```");
      return lines.join("\n");
    }
  }
}

/** The argument worth showing next to a tool's title (command, path, pattern…), unless the title already has it. */
export function toolDetail(input: unknown, title = ""): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const args = input as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "pattern", "query", "url", "uri"]) {
    const value = args[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const detail = value.replace(/\s+/g, " ").replaceAll("`", "'").trim();
    if (title.includes(detail)) return undefined;
    return detail.length > TOOL_DETAIL_CHARS ? `${detail.slice(0, TOOL_DETAIL_CHARS - 1)}…` : detail;
  }
  return undefined;
}

/** Text of an omp tool result (`{ content: [{ type: "text", text }] }`), shared by ACP `rawOutput` and collab `result`. */
export function toolResultText(result: unknown): string | undefined {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  return text || undefined;
}

function tail(text: string): string {
  const trimmed = text.trim();
  let out = trimmed.split("\n").slice(-TOOL_OUTPUT_LINES).join("\n");
  if (out.length > TOOL_OUTPUT_CHARS) out = out.slice(-TOOL_OUTPUT_CHARS);
  return out.length < trimmed.length ? `…\n${out}` : out;
}
