import fs from "node:fs";
import { CollabGuest, CollabSession, collabHostLink, listCollabHosts, parseCollabLink, transcriptFromEntries, type CollabHost } from "./collab.js";
import type { AcpOmpSessionFactory } from "./omp-session.js";
import type { BridgeStore } from "./store.js";
import type { DiscordSessionRecord, LiveSink, OmpSessionFactory, OmpSessionHandle, OmpSessionSummary, SessionTranscript } from "./types.js";

const WATCH_DEBOUNCE_MS = 250;
const POLL_INTERVAL_MS = 60_000;

type RouterDeps = {
  acp: AcpOmpSessionFactory;
  store: BridgeStore;
  sink: LiveSink;
  cliPath: string;
  displayName: string;
  /** `~/.omp/run/collab-hosts`: omp's host registry, watched to notice TUIs opening and closing sessions. */
  hostsDir: string;
};

/**
 * Picks where a thread's prompts run. When an omp TUI is hosting the thread's session (collab
 * registry), the bridge joins it as a guest so both sides share one live session. Otherwise the
 * session is resumed in a background ACP process. Never both: a background process is dropped as
 * soon as a terminal takes the session over, and a terminal that cannot be joined blocks the turn
 * instead of forking the session file.
 */
export class SessionRouter implements OmpSessionFactory {
  private attached = new Map<string, CollabSession>();
  private unreachable = new Map<string, string>();
  private current: Promise<void> | null = null;
  private queued: Promise<void> | null = null;
  private watcher: fs.FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private poll: NodeJS.Timeout | null = null;

  constructor(private deps: RouterDeps) {}

  start(): void {
    fs.mkdirSync(this.deps.hostsDir, { recursive: true, mode: 0o700 });
    this.watcher = fs.watch(this.deps.hostsDir, () => {
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => void this.refresh(), WATCH_DEBOUNCE_MS);
    });
    this.poll = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
    void this.refresh();
  }

  close(): void {
    this.watcher?.close();
    if (this.debounce) clearTimeout(this.debounce);
    if (this.poll) clearInterval(this.poll);
    for (const session of this.attached.values()) session.close("bridge shutting down");
    this.attached.clear();
    this.deps.acp.close();
  }

  listSessions(record: DiscordSessionRecord): Promise<OmpSessionSummary[]> {
    return this.deps.acp.listSessions(record);
  }

  async loadTranscript(record: DiscordSessionRecord): Promise<SessionTranscript> {
    const live = await this.live(record);
    return live ? transcriptFromEntries(live.entries) : this.deps.acp.loadTranscript(record);
  }

  async open(record: DiscordSessionRecord): Promise<OmpSessionHandle> {
    return (await this.live(record)) ?? this.deps.acp.open(record);
  }

  async newSession(record: DiscordSessionRecord): Promise<OmpSessionHandle> {
    await this.refresh();
    return this.deps.acp.newSession(record);
  }

  closeThread(threadId: string): void {
    this.deps.acp.closeThread(threadId);
  }

  /** Re-reads the host registry; concurrent callers share the next complete pass. */
  refresh(): Promise<void> {
    if (!this.current) {
      this.current = this.reconcile().finally(() => { this.current = null; });
      return this.current;
    }
    this.queued ??= this.current.then(() => {
      this.queued = null;
      return this.refresh();
    });
    return this.queued;
  }

  private async live(record: DiscordSessionRecord): Promise<CollabSession | undefined> {
    const sessionId = record.resumeSessionId;
    if (!sessionId) return undefined;
    await this.refresh();
    const blocked = this.unreachable.get(sessionId);
    if (blocked) throw new Error(`your terminal has this session open, but the bridge could not join it (${blocked}). Try again in a moment.`);
    return this.attached.get(sessionId);
  }

  private async reconcile(): Promise<void> {
    let hosts: CollabHost[];
    try {
      hosts = (await listCollabHosts(this.deps.cliPath)).filter((host) => host.access === "control");
    } catch (error) {
      process.stderr.write(`[collab] omp collab list failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return;
    }
    // Newest active thread per omp session: the thread that mirrors a live terminal.
    const views = new Map<string, DiscordSessionRecord>();
    for (const record of this.deps.store.activeResumedSessions()) if (record.resumeSessionId) views.set(record.resumeSessionId, record);
    this.unreachable.clear();

    for (const [sessionId, session] of this.attached) {
      const view = views.get(sessionId);
      const hosted = hosts.some((host) => host.instanceId === session.host.instanceId && host.generation === session.host.generation && host.sessionId === sessionId);
      if (!view || !hosted) session.close(view ? "terminal closed the session" : "no Discord thread follows this session");
      else session.threadId = view.threadId;
    }

    for (const host of hosts) {
      const view = views.get(host.sessionId);
      if (!view || this.attached.has(host.sessionId)) continue;
      try {
        await this.attach(host, view);
      } catch (error) {
        this.unreachable.set(host.sessionId, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async attach(host: CollabHost, view: DiscordSessionRecord): Promise<void> {
    const guest = new CollabGuest(parseCollabLink(await collabHostLink(this.deps.cliPath, host.instanceId)), this.deps.displayName);
    const joined = await guest.join();
    const session = new CollabSession(host, guest, joined, view.threadId, this.deps.sink, this.deps.displayName);
    this.attached.set(host.sessionId, session);
    // Background processes still hold the pre-terminal state of this session; the next turn without a terminal resumes fresh.
    for (const record of this.deps.store.activeResumedSessions()) if (record.resumeSessionId === host.sessionId) this.deps.acp.closeThread(record.threadId);
    this.deps.sink(view.threadId, { type: "notice", key: `collab:${host.instanceId}:${host.generation}`, text: `🖥️ Joined your terminal session (pid ${host.pid}) — this thread and the TUI now share it live.` });
    session.onClosed = (reason) => {
      if (this.attached.get(host.sessionId) !== session) return;
      this.attached.delete(host.sessionId);
      this.deps.sink(session.threadId, { type: "notice", key: `collab-closed:${host.instanceId}:${host.generation}`, text: `🖥️ Left the terminal session (${reason}). Messages here continue it in a background omp process.` });
    };
  }
}
