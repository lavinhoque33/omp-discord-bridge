import path from "node:path";
import type { BridgeStore } from "./store.js";
import type { OmpSessionFactory, OmpSessionSummary, SessionTranscript, ThreadMessenger } from "./types.js";
import { formatStatus } from "./render.js";

export class ThreadQueueRunner {
  private runningThreads = new Set<string>();
  private active = 0;
  private controllers = new Map<string, AbortController>();
  /** `live.settle` waits until a turn's streamed output is fully visible before the next message posts. */
  constructor(private deps: { store: BridgeStore; omp: OmpSessionFactory; messenger: ThreadMessenger; live: { settle(threadId: string): Promise<void> }; maxConcurrency: number }) {}

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
    if (!session) {
      await this.deps.messenger.send(threadId, "No OMP session is mapped to this thread.");
      return;
    }
    const counts = this.deps.store.counts(threadId);
    await this.deps.messenger.send(threadId, formatStatus({ threadId, sessionFile: session.sessionFile, resumeSessionId: session.resumeSessionId, cwd: session.cwd, status: session.status, ...counts }));
  }

  /** omp sessions recorded for this thread's project directory, newest first. */
  async listProjectSessions(threadId: string): Promise<OmpSessionSummary[]> {
    const session = this.deps.store.getSession(threadId);
    if (!session || !this.deps.omp.listSessions) return [];
    const sessions = await this.deps.omp.listSessions(session);
    const cwd = path.resolve(session.cwd);
    return sessions
      .filter((entry) => !entry.cwd || path.resolve(entry.cwd) === cwd)
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  /** Replayed history of the session this thread continues, for display when the thread opens. */
  async loadSessionTranscript(threadId: string): Promise<SessionTranscript> {
    const session = this.deps.store.getSession(threadId);
    if (!session?.resumeSessionId || !this.deps.omp.loadTranscript) return { entries: [], toolCalls: 0, totalMessages: 0 };
    return this.deps.omp.loadTranscript(session);
  }

  /** Retires a thread whose omp session moved to `successorId`, dropping its background process. */
  async supersede(threadId: string, successorId: string): Promise<void> {
    this.deps.store.updateSession(threadId, { status: "archived" });
    this.deps.omp.closeThread?.(threadId);
    await this.deps.messenger.send(threadId, `This session now continues in <#${successorId}>.`).catch(() => undefined);
  }

  async newSession(threadId: string): Promise<void> {
    const session = this.deps.store.getSession(threadId);
    if (!session) {
      await this.deps.messenger.send(threadId, "No OMP session is mapped to this thread.");
      return;
    }
    this.deps.store.updateSession(threadId, { resumeSessionId: null });
    const handle = await this.deps.omp.newSession({ ...session, resumeSessionId: null });
    this.deps.store.updateSession(threadId, { status: "active", sessionFile: `${session.sessionDir}/${handle.id}.json` });
    await this.deps.messenger.send(threadId, "Started a fresh OMP session for this Discord thread.");
  }

  async compact(threadId: string): Promise<void> {
    const session = this.deps.store.getSession(threadId);
    if (!session) {
      await this.deps.messenger.send(threadId, "No OMP session is mapped to this thread.");
      return;
    }
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
      await this.deps.live.settle(threadId);
      this.deps.store.markMessage(item.id, "done");
    } catch (error) {
      const status = controller.signal.aborted ? "aborted" : "failed";
      const message = error instanceof Error ? error.message : String(error);
      this.deps.store.markMessage(item.id, status, message);
      await this.deps.live.settle(threadId);
      await this.deps.messenger.send(threadId, status === "aborted" ? "OMP turn aborted." : `OMP turn failed: ${message}`);
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

export type ManageCommand = { command: "sessions" } | { command: "open"; ref: string };

/** `sessions` lists the project's omp sessions; `open <id-prefix>` binds a thread to one of them. */
export function parseManageCommand(content: string): ManageCommand | undefined {
  const text = content.trim();
  if (["sessions", "/sessions"].includes(text.toLowerCase())) return { command: "sessions" };
  const match = /^\/?(?:open|resume)\s+(\S+)$/i.exec(text);
  if (match?.[1]) return { command: "open", ref: match[1] };
  return undefined;
}
