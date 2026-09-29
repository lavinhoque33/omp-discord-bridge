import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { DiscordSessionRecord, QueueStatus, QueuedMessageRecord, SessionStatus } from "./types.js";

function now(): string { return new Date().toISOString(); }

function rowToSession(row: any): DiscordSessionRecord {
  return {
    threadId: row.thread_id,
    guildId: row.guild_id,
    parentChannelId: row.parent_channel_id,
    triggerMessageId: row.trigger_message_id,
    sessionFile: row.session_file,
    resumeSessionId: row.resume_session_id ?? null,
    sessionDir: row.session_dir,
    cwd: row.cwd,
    model: row.model,
    thinkingLevel: row.thinking_level,
    createdByUserId: row.created_by_user_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row: any): QueuedMessageRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    discordMessageId: row.discord_message_id,
    authorId: row.author_id,
    content: row.content,
    attachmentsJson: row.attachments_json,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  };
}

export class BridgeStore {
  readonly db: DatabaseSync;
  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }
  close(): void { this.db.close(); }
  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS discord_sessions(
        thread_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        parent_channel_id TEXT NOT NULL,
        trigger_message_id TEXT NOT NULL,
        session_file TEXT,
        resume_session_id TEXT,
        session_dir TEXT NOT NULL,
        cwd TEXT NOT NULL,
        model TEXT,
        thinking_level TEXT,
        created_by_user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS queued_messages(
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES discord_sessions(thread_id) ON DELETE CASCADE,
        discord_message_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        content TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS queued_messages_thread_status_created_idx ON queued_messages(thread_id, status, created_at);
    `);
    const columns = this.db.prepare("SELECT name FROM pragma_table_info('discord_sessions')").all();
    if (!columns.some((column) => column.name === "resume_session_id")) this.db.exec("ALTER TABLE discord_sessions ADD COLUMN resume_session_id TEXT");
  }
  createSession(input: Omit<DiscordSessionRecord, "createdAt" | "updatedAt" | "status" | "resumeSessionId"> & { status?: SessionStatus; resumeSessionId?: string | null }): DiscordSessionRecord {
    const t = now();
    const record: DiscordSessionRecord = { ...input, resumeSessionId: input.resumeSessionId ?? null, status: input.status ?? "active", createdAt: t, updatedAt: t };
    this.db.prepare(`INSERT INTO discord_sessions(thread_id,guild_id,parent_channel_id,trigger_message_id,session_file,resume_session_id,session_dir,cwd,model,thinking_level,created_by_user_id,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.threadId, record.guildId, record.parentChannelId, record.triggerMessageId, record.sessionFile, record.resumeSessionId, record.sessionDir, record.cwd, record.model, record.thinkingLevel, record.createdByUserId, record.status, record.createdAt, record.updatedAt);
    return record;
  }
  getSession(threadId: string): DiscordSessionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM discord_sessions WHERE thread_id = ?").get(threadId);
    return row ? rowToSession(row) : undefined;
  }
  /** Active threads that continue an existing omp session, oldest first. */
  activeResumedSessions(): DiscordSessionRecord[] {
    return this.db.prepare("SELECT * FROM discord_sessions WHERE status='active' AND resume_session_id IS NOT NULL ORDER BY created_at ASC").all().map(rowToSession);
  }
  updateSession(threadId: string, patch: Partial<Pick<DiscordSessionRecord, "sessionFile" | "resumeSessionId" | "status" | "model" | "thinkingLevel">>): void {
    const current = this.getSession(threadId);
    if (!current) throw new Error(`unknown thread ${threadId}`);
    this.db.prepare("UPDATE discord_sessions SET session_file=?, resume_session_id=?, status=?, model=?, thinking_level=?, updated_at=? WHERE thread_id=?")
      .run(patch.sessionFile ?? current.sessionFile, patch.resumeSessionId === undefined ? current.resumeSessionId : patch.resumeSessionId, patch.status ?? current.status, patch.model ?? current.model, patch.thinkingLevel ?? current.thinkingLevel, now(), threadId);
  }
  enqueue(input: { threadId: string; discordMessageId: string; authorId: string; content: string; attachments?: unknown[] }): QueuedMessageRecord {
    const t = now();
    const rec: QueuedMessageRecord = { id: randomUUID(), threadId: input.threadId, discordMessageId: input.discordMessageId, authorId: input.authorId, content: input.content, attachmentsJson: JSON.stringify(input.attachments ?? []), status: "queued", createdAt: t, startedAt: null, finishedAt: null, error: null };
    this.db.prepare("INSERT INTO queued_messages(id,thread_id,discord_message_id,author_id,content,attachments_json,status,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(rec.id, rec.threadId, rec.discordMessageId, rec.authorId, rec.content, rec.attachmentsJson, rec.status, rec.createdAt);
    return rec;
  }
  nextQueued(threadId: string): QueuedMessageRecord | undefined {
    const row = this.db.prepare("SELECT * FROM queued_messages WHERE thread_id=? AND status='queued' ORDER BY created_at ASC LIMIT 1").get(threadId);
    return row ? rowToMessage(row) : undefined;
  }
  markMessage(id: string, status: QueueStatus, error?: string): void {
    const started = status === "running" ? now() : undefined;
    const finished = ["done", "failed", "aborted"].includes(status) ? now() : undefined;
    const row = this.db.prepare("SELECT * FROM queued_messages WHERE id=?").get(id) as any;
    if (!row) throw new Error(`unknown queued message ${id}`);
    this.db.prepare("UPDATE queued_messages SET status=?, started_at=?, finished_at=?, error=? WHERE id=?")
      .run(status, started ?? row.started_at, finished ?? row.finished_at, error ?? row.error, id);
  }
  counts(threadId: string): { queued: number; running: number } {
    const queued = this.db.prepare("SELECT count(*) AS n FROM queued_messages WHERE thread_id=? AND status='queued'").get(threadId) as any;
    const running = this.db.prepare("SELECT count(*) AS n FROM queued_messages WHERE thread_id=? AND status='running'").get(threadId) as any;
    return { queued: Number(queued.n), running: Number(running.n) };
  }
  queuedThreadIds(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT thread_id FROM queued_messages WHERE status='queued' ORDER BY thread_id").all() as any[];
    return rows.map((row) => String(row.thread_id));
  }
  recoverRunning(): number {
    const result = this.db.prepare("UPDATE queued_messages SET status='queued', started_at=NULL, error='recovered after daemon restart' WHERE status='running'").run();
    return Number(result.changes ?? 0);
  }
}
