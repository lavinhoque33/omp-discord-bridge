export type SessionStatus = "active" | "stopped" | "archived";
export type QueueStatus = "queued" | "running" | "done" | "failed" | "aborted";

export interface GuildPolicy {
  id: string;
  allowedChannels: string[];
  allowedUsers: string[];
  requireMention: boolean;
  threadAutoArchiveMinutes: number;
  cwd?: string;
}

export interface BridgeAvailableCommand {
  name: string;
  description: string;
  inputHint?: string;
}

export interface DiscordSlashCommandConfig {
  enabled: boolean;
  syncOnStart: boolean;
  commandPrefix: string;
  acpCommandMode: "explicit" | "core" | "auto";
  acpCommands: BridgeAvailableCommand[];
}

export interface BridgeConfig {
  discord: {
    tokenEnv: string;
    guilds: GuildPolicy[];
    slashCommands: DiscordSlashCommandConfig;
  };
  omp: {
    cwd: string;
    sessionRoot: string;
    model: string | null;
    thinkingLevel: string | null;
  };
  runtime: {
    databasePath: string;
    maxConcurrency: number;
    maxAttachmentBytes: number;
    responseMode: "final-only" | "edit-preview-then-final";
    followupMode: "steer" | "queue";
    discordMessageLimit: number;
  };
}

export interface DiscordSessionRecord {
  threadId: string;
  guildId: string;
  parentChannelId: string;
  triggerMessageId: string;
  sessionFile: string | null;
  sessionDir: string;
  cwd: string;
  model: string | null;
  thinkingLevel: string | null;
  createdByUserId: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface QueuedMessageRecord {
  id: string;
  threadId: string;
  discordMessageId: string;
  authorId: string;
  content: string;
  attachmentsJson: string;
  status: QueueStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface OmpPromptResult {
  text: string;
  sessionFile?: string;
}

export interface OmpSessionHandle {
  id: string;
  prompt(message: string, signal?: AbortSignal): Promise<OmpPromptResult>;
  steer?(message: string): Promise<void> | void;
  availableCommands?(): Promise<BridgeAvailableCommand[]> | BridgeAvailableCommand[];
  abort?(): Promise<void> | void;
  compact?(): Promise<void> | void;
}

export interface OmpSessionFactory {
  open(record: DiscordSessionRecord): Promise<OmpSessionHandle>;
  newSession(record: DiscordSessionRecord): Promise<OmpSessionHandle>;
  close?(): Promise<void> | void;
}

export interface ThreadMessenger {
  send(threadId: string, content: string): Promise<void>;
  typing?(threadId: string): Promise<void>;
}
