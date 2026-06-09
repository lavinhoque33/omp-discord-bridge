import { describe, expect, it } from "vitest";
import { buildRpcLaunch } from "../src/omp-session.js";

describe("RPC OMP session launch", () => {
  it("uses OMP RPC mode with bun and the package CLI", () => {
    const launch = buildRpcLaunch({
      cwd: "/tmp/project",
      sessionDir: "/tmp/sessions/thread-1",
      model: "openrouter/anthropic/claude-sonnet-4",
      thinkingLevel: "medium",
    });
    expect(launch.command).toBe("bun");
    expect(launch.args).toContain("--mode");
    expect(launch.args).toContain("rpc");
    expect(launch.args).toContain("--session-dir");
    expect(launch.args).toContain("/tmp/sessions/thread-1");
    expect(launch.args).toContain("--model");
    expect(launch.args).toContain("openrouter/anthropic/claude-sonnet-4");
    expect(launch.cwd).toBe("/tmp/project");
    expect(launch.env.PI_NOTIFICATIONS).toBe("off");
  });
});
