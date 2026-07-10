import type { OrchestratorState } from "../core/types.js";

export interface Store {
  readonly name: string;
  readonly runtimeLockPath?: string;
  init(): Promise<void>;
  read(): Promise<OrchestratorState>;
  write(state: OrchestratorState): Promise<void>;
}

export function emptyState(): OrchestratorState {
  return {
    version: 1,
    sessions: [],
    events: [],
    deliveries: [],
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
