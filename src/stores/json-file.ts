import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OrchestratorState } from "../core/types.js";
import { emptyState, type Store } from "./store.js";

export function jsonFileStore(filePath: string): Store {
  return {
    name: `json-file:${filePath}`,

    async init() {
      await mkdir(dirname(filePath), { recursive: true });
      try {
        await readFile(filePath, "utf8");
      } catch {
        await writeFile(filePath, JSON.stringify(emptyState(), null, 2), "utf8");
      }
    },

    async read() {
      await this.init();
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as OrchestratorState;
      return { ...emptyState(), ...parsed, version: 1 };
    },

    async write(state: OrchestratorState) {
      await mkdir(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
      await rename(tmp, filePath);
    },
  };
}

export const fileStore = jsonFileStore;
