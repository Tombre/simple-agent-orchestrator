import { defineConfig } from "simple-agent-orchestrator";
import { manualChannel } from "./channels/manual.ts";
import { exampleClient } from "./clients/example.ts";

export default defineConfig({
  channels: [manualChannel],
  clients: [exampleClient],
});
