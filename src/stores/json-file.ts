import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OrchestratorState } from "../core/types.js";
import { emptyState, type Store } from "./store.js";
import { parseAndMigrateState, validateAndMigrateState } from "./state-validation.js";

export async function initializeJsonStateFile(filePath: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.init.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(emptyState(), null, 2), { encoding: "utf8", flag: "wx" });
    try {
      await link(tmp, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(
          `Could not initialize JSON state at ${filePath} atomically. jsonFileStore requires a local filesystem with atomic hard-link support.`,
          { cause: error },
        );
      }
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

export function jsonFileStore(filePath: string): Store {
  return {
    name: `json-file:${filePath}`,
    runtimeLockPath: `${filePath}.runtime-lock`,

    async init() {
      await mkdir(dirname(filePath), { recursive: true });
      try {
        await readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await initializeJsonStateFile(filePath);
      }
    },

    async read() {
      await this.init();
      const raw = await readFile(filePath, "utf8");
      return parseAndMigrateState(raw, filePath);
    },

    async write(state: OrchestratorState) {
      await mkdir(dirname(filePath), { recursive: true });
      const validated = validateAndMigrateState(state, filePath);
      const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(validated, null, 2), { encoding: "utf8", flag: "wx" });
        await rename(tmp, filePath);
      } finally {
        await rm(tmp, { force: true });
      }
    },
  };
}

export const fileStore = jsonFileStore;
