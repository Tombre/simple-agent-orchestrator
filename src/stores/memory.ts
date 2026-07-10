import type { OrchestratorState } from "../core/types.js";
import { emptyState, type Store } from "./store.js";

function clone<T>(value: T): T {
  return globalThis.structuredClone ? globalThis.structuredClone(value) : JSON.parse(JSON.stringify(value));
}

export function memoryStore(initial?: Partial<OrchestratorState>): Store {
  let state: OrchestratorState = { ...emptyState(), ...initial } as OrchestratorState;

  return {
    name: "memory",
    async init() {},
    async read() {
      return clone(state);
    },
    async write(next) {
      state = clone(next);
    },
  };
}
