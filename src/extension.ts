type ExtensionFactory = (pi: any) => void | Promise<void>;

const extension: ExtensionFactory = (pi) => {
  const configPath = process.env.OMP_DISCORD_BRIDGE_CONFIG ?? "~/.omp/agent/discord-bridge.yml";
  pi.setLabel?.("OMP Discord Bridge");
  pi.registerCommand?.("discord-bridge", {
    description: "Show OMP Discord bridge setup/status commands.",
    handler: async () => {
      const text = [
        "OMP Discord Bridge",
        `Config: ${configPath}`,
        "Daemon: run `omp-discord-bridge --config <path>` in a service manager or shell.",
        "Discord controls inside managed threads: status, stop, new, compact.",
      ].join("\n");
      pi.ui?.notify?.(text, "info");
      return text;
    },
  });
};

export default extension;
