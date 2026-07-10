import { createProjectContext } from "../../src/runtime/project.js";
import { OrchestratorRuntime } from "../../src/runtime/runtime.js";
import { jsonFileStore } from "../../src/stores/json-file.js";

const statePath = process.argv[2];
const root = process.argv[3];
if (!statePath || !root) throw new Error("Expected state path and project root");

function send(message: unknown): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send) {
      resolve();
      return;
    }
    process.send(message, () => resolve());
  });
}

try {
  const project = await createProjectContext(root);
  const runtime = new OrchestratorRuntime({
    project,
    config: { store: jsonFileStore(statePath), http: { enabled: false } },
  });
  await runtime.start({ prettyStartupLog: false });
  await send({ type: "ready", pid: process.pid });
  await new Promise<void>((resolve) => {
    process.once("message", (message) => {
      if (message === "stop") resolve();
    });
  });
  await runtime.stop();
  process.disconnect?.();
} catch (error) {
  await send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.disconnect?.();
  process.exitCode = 1;
}
