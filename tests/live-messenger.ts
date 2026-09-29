import { LiveThreads } from "../src/live.js";
import type { ThreadMessenger } from "../src/types.js";

/** In-memory Discord thread: `sent` holds each message's current content (edits replace in place). */
export function recordingMessenger() {
  const sent: string[] = [];
  const messenger: ThreadMessenger = {
    send: async (_threadId, content) => String(sent.push(content) - 1),
    edit: async (_threadId, messageId, content) => { sent[Number(messageId)] = content; },
  };
  return { sent, messenger, live: new LiveThreads(messenger, { intervalMs: 0, messageLimit: 1900 }) };
}
