import { describe, expect, it } from "vitest";
import { chunkDiscordMessage, slugifyThreadName, stripBotMention } from "../src/render.js";

describe("render helpers", () => {
  it("strips Discord bot mentions", () => {
    expect(stripBotMention("<@123> please fix staging", "123")).toBe("please fix staging");
    expect(stripBotMention("<@!123>   hello", "123")).toBe("hello");
  });
  it("creates bounded thread names", () => {
    expect(slugifyThreadName("Please investigate why staging deploy is failing!")).toBe("omp-please-investigate-why-staging-deploy-is-failing");
    expect(slugifyThreadName("")).toBe("omp-session");
  });
  it("chunks Discord messages under the configured limit", () => {
    const text = `${"alpha ".repeat(30)}omega`;
    const chunks = chunkDiscordMessage(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(" ")).toContain("omega");
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
  });
});
