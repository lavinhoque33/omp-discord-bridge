import { describe, expect, it } from "vitest";
import { buildAcpLaunch } from "../src/omp-session.js";

describe("OMP session launch", () => {
  it("uses OMP ACP mode through the omp executable", () => {
    const launch = buildAcpLaunch({
      cwd: "/tmp/project",
      sessionDir: "/tmp/sessions/thread-1",
      model: "openrouter/anthropic/claude-sonnet-4",
      thinkingLevel: "medium",
      cliPath: "omp",
    });
    expect(launch.command).toBe("omp");
    expect(launch.args).toContain("acp");
    expect(launch.args).toContain("--session-dir");
    expect(launch.args).toContain("/tmp/sessions/thread-1");
    expect(launch.args).toContain("--model");
    expect(launch.args).toContain("openrouter/anthropic/claude-sonnet-4");
    expect(launch.cwd).toBe("/tmp/project");
    expect(launch.env.PI_NOTIFICATIONS).toBe("off");
  });

  it("allows an explicit OMP CLI command override", () => {
    const launch = buildAcpLaunch({ cwd: "/tmp/project", sessionDir: "/tmp/sessions/thread-1", model: null, thinkingLevel: null, cliPath: "/custom/omp" });
    expect(launch.command).toBe("/custom/omp");
  });
});
