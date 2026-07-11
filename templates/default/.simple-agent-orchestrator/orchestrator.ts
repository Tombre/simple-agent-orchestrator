import { defineConfig } from "simple-agent-orchestrator";
import { exampleClient } from "./clients/example.ts";

export default defineConfig({
  clients: [exampleClient],
});
