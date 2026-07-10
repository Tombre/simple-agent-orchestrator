import { createProjectContext } from "../src/runtime/project.js";
import { OrchestratorRuntime } from "../src/runtime/runtime.js";
import type { OrchestratorConfig } from "../src/core/config.js";
import { memoryStore } from "../src/stores/memory.js";
import { silentLogger } from "../src/utils/logger.js";

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

export async function createRuntime(config: OrchestratorConfig): Promise<OrchestratorRuntime> {
  const project = await createProjectContext(process.cwd());
  return new OrchestratorRuntime({
    project,
    config: {
      logger: silentLogger,
      store: memoryStore(),
      http: { enabled: false },
      ...config,
    },
  });
}
