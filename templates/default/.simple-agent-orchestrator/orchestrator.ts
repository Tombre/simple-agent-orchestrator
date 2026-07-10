import { defineConfig, jsonFileStore } from "simple-agent-orchestrator";
import { manualChannel } from "./channels/manual.ts";
import { echoClient } from "./clients/echo.ts";

export default defineConfig(({ project }) => ({
  name: String(project.packageJson.name ?? "local-project"),

  store: jsonFileStore(project.statePath("state.json")),

  channels: [manualChannel],

  clients: [echoClient],
}));
