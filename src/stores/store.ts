import type { OrchestratorState } from "../core/types.js";
import { CURRENT_STATE_VERSION } from "./state-validation.js";

export interface Store {
  readonly name: string;
  readonly runtimeLockPath?: string;
  init(): Promise<void>;
  read(): Promise<OrchestratorState>;
  write(state: OrchestratorState): Promise<void>;
}

export function emptyState(): OrchestratorState {
  return {
    version: CURRENT_STATE_VERSION,
    sessions: [],
    events: [],
    deliveries: [],
    exhaustions: [],
    capacityReservations: [],
    sandboxes: [],
    notes: [],
    cursors: {},
  };
}

export class StoreMutex {
  private current = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.current;
    let release!: () => void;
    this.current = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
