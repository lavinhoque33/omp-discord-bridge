import type { BridgeStore } from "./store.js";
import type { OmpSessionFactory, ThreadMessenger } from "./types.js";
import { chunkDiscordMessage, formatStatus } from "./render.js";

export class ThreadQueueRunner {
  private runningThreads = new Set<string>();
  private active = 0;
  private controllers = new Map<string, AbortController>();
  constructor(private deps: { store: BridgeStore; omp: OmpSessionFactory; messenger: ThreadMessenger; messageLimit: number; maxConcurrency: number }) {}

  poke(threadId: string): void {
    void this.drain(threadId);
  }

  async stop(threadId: string): Promise<void> {
    this.controllers.get(threadId)?.abort();
    const session = this.deps.store.getSession(threadId);
    if (session) this.deps.store.updateSession(threadId, { status: "stopped" });
    await this.deps.messenger.send(threadId, "Stopped current OMP turn and paused this thread session. Use `new` to start a fresh session.");
  }

  async steer(threadId: string, content: string): Promise<boolean> {
    if (!this.runningThreads.has(threadId)) return false;
    const session = this.deps.store.getSession(threadId);
    if (!session || session.status !== "active") return false;
    const handle = await this.deps.omp.open(session);
    if (!handle.steer) return false;
    await handle.steer(content);
    return true;
  }

  async status(threadId: string): Promise<void> {
    const session = this.deps.store.getSession(threadId);
    if (!session) return this.deps.messenger.send(threadId, "No OMP session is mapped to this thread.");
    const counts = this.deps.store.counts(threadId);
    await this.deps.messenger.send(threadId, formatStatus({ threadId, sessionFile: session.sessionFile, cwd: session.cwd, status: session.status, ...counts }));
  }

  async newSession(threadId: string): Promise<void> {
    const session = this.deps.store.getSession(threadId);
    if (!session) return this.deps.messenger.send(threadId, "No OMP session is mapped to this thread.");
    const handle = await this.deps.omp.newSession(session);
    this.deps.store.updateSession(threadId, { status: "active", sessionFile: `${session.sessionDir}/${handle.id}.json` });
    await this.deps.messenger.send(threadId, "Started a fresh OMP session for this Discord thread.");
  }

  async compact(threadId: string): Promise<void> {
    const session = this.deps.store.getSession(threadId);
    if (!session) return this.deps.messenger.send(threadId, "No OMP session is mapped to this thread.");
    const handle = await this.deps.omp.open(session);
    await handle.compact?.();
    await this.deps.messenger.send(threadId, "Requested OMP context compaction for this session.");
  }

  private async drain(threadId: string): Promise<void> {
    if (this.runningThreads.has(threadId)) return;
    if (this.active >= this.deps.maxConcurrency) {
      setTimeout(() => this.poke(threadId), 250);
      return;
    }
    const item = this.deps.store.nextQueued(threadId);
    if (!item) return;
    const session = this.deps.store.getSession(threadId);
    if (!session || session.status !== "active") return;
    this.runningThreads.add(threadId);
    this.active += 1;
    const controller = new AbortController();
    this.controllers.set(threadId, controller);
    this.deps.store.markMessage(item.id, "running");
    try {
      await this.deps.messenger.typing?.(threadId);
      const handle = await this.deps.omp.open(session);
      const result = await handle.prompt(item.content, controller.signal);
      if (result.sessionFile) this.deps.store.updateSession(threadId, { sessionFile: result.sessionFile, status: "active" });
      for (const chunk of chunkDiscordMessage(result.text, this.deps.messageLimit)) await this.deps.messenger.send(threadId, chunk);
      this.deps.store.markMessage(item.id, "done");
    } catch (error: any) {
      const status = controller.signal.aborted ? "aborted" : "failed";
      this.deps.store.markMessage(item.id, status, error?.message ?? String(error));
      await this.deps.messenger.send(threadId, status === "aborted" ? "OMP turn aborted." : `OMP turn failed: ${error?.message ?? error}`);
    } finally {
      this.controllers.delete(threadId);
      this.runningThreads.delete(threadId);
      this.active -= 1;
      this.poke(threadId);
    }
  }
}

export function parseThreadCommand(content: string): "status" | "stop" | "new" | "compact" | undefined {
  const normalized = content.trim().toLowerCase();
  if (["status", "/status"].includes(normalized)) return "status";
  if (["stop", "/stop", "abort", "/abort"].includes(normalized)) return "stop";
  if (["new", "/new"].includes(normalized)) return "new";
  if (["compact", "/compact"].includes(normalized)) return "compact";
  return undefined;
}
