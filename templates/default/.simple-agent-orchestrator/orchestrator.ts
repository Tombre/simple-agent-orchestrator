import { defineConfig, jsonFileStore } from "simple-agent-orchestrator";
import { manualChannel } from "./channels/manual.ts";
import { echoClient } from "./clients/echo.ts";

export default defineConfig(({ project }) => ({
  name: String(project.packageJson.name ?? "local-project"),

  store: jsonFileStore(project.statePath("state.json")),

  http: {
    hostname: "127.0.0.1",
    port: 3000,
  },

  channels: [manualChannel],

  clients: [echoClient],
}));
