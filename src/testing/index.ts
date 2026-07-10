import { createProjectContext } from "../runtime/project.js";
import { OrchestratorRuntime } from "../runtime/runtime.js";
import { memoryStore } from "../stores/memory.js";
import type { OrchestratorConfig } from "../core/config.js";
import type { DispatchEvent } from "../core/types.js";
import { silentLogger } from "../utils/logger.js";

export interface TestRuntimeOptions {
  root?: string;
  config: OrchestratorConfig;
}

export async function createTestRuntime(options: TestRuntimeOptions) {
  const project = await createProjectContext(options.root ?? process.cwd());
  const runtime = new OrchestratorRuntime({
    project,
    config: {
      logger: silentLogger,
      store: memoryStore(),
      ...options.config,
    },
  });
  await runtime.init();

  return {
    runtime,
    async dispatch(channelId: string, event: DispatchEvent) {
      const result = await runtime.dispatch(channelId, event);
      await runtime.drain();
      return result;
    },
    sessions: {
      list: () => runtime.listSessions(),
      get: (idOrKey: string) => runtime.getSession(idOrKey),
      notes: (idOrKey: string) => runtime.listSessionNotes(idOrKey),
    },
    events: {
      list: () => runtime.listEvents(),
    },
  };
}

export { memoryStore } from "../stores/memory.js";
