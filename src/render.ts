export function stripBotMention(content: string, botId: string): string {
  return content
    .replace(new RegExp(`<@!?${botId}>`, "g"), "")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugifyThreadName(prompt: string, prefix = "omp"): string {
  const body = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
  return `${prefix}-${body || "session"}`.slice(0, 90);
}

export function chunkDiscordMessage(text: string, limit = 1900): string[] {
  if (limit < 100) throw new Error("limit too small");
  if (text.length === 0) return [""];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < Math.floor(limit * 0.5)) cut = rest.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.5)) cut = rest.lastIndexOf(" ", limit);
    if (cut < Math.floor(limit * 0.5)) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  chunks.push(rest);
  return chunks;
}

export function formatStatus(input: { threadId: string; sessionFile: string | null; resumeSessionId?: string | null; cwd: string; status: string; queued: number; running: number }): string {
  return [
    "**OMP Discord Bridge status**",
    `Thread: \`${input.threadId}\``,
    `Session: \`${input.sessionFile ?? "not-created-yet"}\``,
    ...(input.resumeSessionId ? [`Continues: \`${input.resumeSessionId}\` (existing omp session)`] : []),
    `CWD: \`${input.cwd}\``,
    `State: \`${input.status}\``,
    `Queue: ${input.running} running, ${input.queued} queued`,
  ].join("\n");
}
