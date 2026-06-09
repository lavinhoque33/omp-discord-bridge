import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";

describe("config", () => {
  it("normalizes defaults and expands guild policies", () => {
    const cfg = normalizeConfig({ discord: { guilds: [{ id: "g", allowedChannels: ["c"] }] }, omp: { cwd: "~/Developer" }, runtime: {} });
    expect(cfg.discord.tokenEnv).toBe("DISCORD_BOT_TOKEN");
    expect(cfg.discord.guilds[0]?.requireMention).toBe(true);
    expect(cfg.omp.cwd).toContain("Developer");
    expect(cfg.runtime.followupMode).toBe("steer");
    expect(cfg.runtime.maxConcurrency).toBe(2);
    expect(cfg.discord).toMatchObject({ slashCommands: { enabled: true, syncOnStart: true, commandPrefix: "omp" } });
  });
  it("allows explicitly queueing follow-up messages instead of steering", () => {
    const cfg = normalizeConfig({ discord: { guilds: [{ id: "g" }] }, runtime: { followupMode: "queue" } });
    expect(cfg.runtime.followupMode).toBe("queue");
  });
  it("rejects unknown follow-up modes", () => {
    expect(() => normalizeConfig({ discord: { guilds: [{ id: "g" }] }, runtime: { followupMode: "bogus" } })).toThrow(/followupMode/);
  });
  it("accepts slash command overrides", () => {
    const cfg = normalizeConfig({ discord: { guilds: [{ id: "g" }], slashCommands: { enabled: false, syncOnStart: false, commandPrefix: "pi" } } });
    expect(cfg.discord).toMatchObject({ slashCommands: { enabled: false, syncOnStart: false, commandPrefix: "pi" } });
  });
  it("accepts the deprecated ACP session mode value as a no-op", () => {
    const cfg = normalizeConfig({ discord: { guilds: [{ id: "g" }] }, omp: { mode: "acp" } });
    expect(cfg.omp.cwd).toBe(process.cwd());
  });
  it("rejects removed OMP session modes", () => {
    expect(() => normalizeConfig({ discord: { guilds: [{ id: "g" }] }, omp: { mode: "sdk" } })).toThrow(/only supports ACP/);
    expect(() => normalizeConfig({ discord: { guilds: [{ id: "g" }] }, omp: { mode: "bogus" } })).toThrow(/omp.mode/);
  });
  it("supports auto ACP slash command discovery mode", () => {
    const cfg = normalizeConfig({ discord: { guilds: [{ id: "g" }], slashCommands: { acpCommands: "auto" } } });
    expect(cfg.discord.slashCommands.acpCommandMode).toBe("auto");
    expect(cfg.discord.slashCommands.acpCommands).toEqual([]);
  });

  it("normalizes configured ACP slash commands", () => {
    const cfg = normalizeConfig({ discord: { guilds: [{ id: "g" }], slashCommands: { acpCommands: [{ name: "todo", description: "Manage todos", inputHint: "args" }] } } });
    expect(cfg.discord.slashCommands.acpCommands).toEqual([{ name: "todo", description: "Manage todos", inputHint: "args" }]);
  });
  it("rejects missing guild policies", () => {
    expect(() => normalizeConfig({ discord: { guilds: [] } })).toThrow(/guilds/);
  });
});
