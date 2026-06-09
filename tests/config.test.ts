import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";

describe("config", () => {
  it("normalizes defaults and expands guild policies", () => {
    const cfg = normalizeConfig({ discord: { guilds: [{ id: "g", allowedChannels: ["c"] }] }, omp: { cwd: "~/Developer" }, runtime: {} });
    expect(cfg.discord.tokenEnv).toBe("DISCORD_BOT_TOKEN");
    expect(cfg.discord.guilds[0]?.requireMention).toBe(true);
    expect(cfg.omp.cwd).toContain("Developer");
    expect(cfg.omp.mode).toBe("rpc");
    expect(cfg.runtime.maxConcurrency).toBe(2);
  });
  it("allows explicitly selecting the legacy sdk session mode", () => {
    const cfg = normalizeConfig({ discord: { guilds: [{ id: "g", allowedChannels: ["c"] }] }, omp: { mode: "sdk" }, runtime: {} });
    expect(cfg.omp.mode).toBe("sdk");
  });
  it("rejects unknown OMP session modes", () => {
    expect(() => normalizeConfig({ discord: { guilds: [{ id: "g" }] }, omp: { mode: "bogus" } })).toThrow(/omp.mode/);
  });
  it("rejects missing guild policies", () => {
    expect(() => normalizeConfig({ discord: { guilds: [] } })).toThrow(/guilds/);
  });
});
