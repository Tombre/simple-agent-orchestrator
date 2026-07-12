import type { ChannelDefinition } from "../core/channel.js";
import type { ConfigFactory, HttpConfig } from "../core/config.js";
import type {
  DispatchEvent,
  DispatchResult,
  Logger,
  OrchestratorState,
  ProjectContext,
  SessionNote,
  StoredCapacityReservation,
  StoredDelivery,
  StoredEvent,
  StoredExhaustion,
  StoredSession,
} from "../core/types.js";
import { createProjectContext } from "../runtime/project.js";
import { OrchestratorRuntime } from "../runtime/runtime.js";
import { memoryStore } from "../stores/memory.js";
import type { Store } from "../stores/store.js";
import { silentLogger } from "../utils/logger.js";

type TestProjectOptions =
  | { root?: string; project?: never }
  | { root?: never; project: ProjectContext };

export type TestRuntimeOptions = TestProjectOptions & {
  store?: Store;
  logger?: Logger;
  http?: HttpConfig;
};

export interface TestEventRecord {
  event: StoredEvent;
  deliveries: StoredDelivery[];
  exhaustions: StoredExhaustion[];
}

export interface TestRuntime {
  readonly runtime: OrchestratorRuntime;
  readonly project: ProjectContext;
  readonly store: Store;
  dispatch(
    channel: ChannelDefinition | string,
    event: DispatchEvent,
    options?: { drain?: boolean },
  ): Promise<DispatchResult>;
  drain(): Promise<void>;
  stop(): Promise<void>;
  readState(): Promise<OrchestratorState>;
  readonly sessions: {
    list(): Promise<StoredSession[]>;
    get(idOrKey: string): Promise<StoredSession | undefined>;
    notes(idOrKey: string): Promise<SessionNote[]>;
  };
  readonly capacity: {
    list(): Promise<StoredCapacityReservation[]>;
    release(clientId: string, sessionIdOrKey: string, options?: { drain?: boolean }): Promise<boolean>;
  };
  readonly events: {
    list(): Promise<TestEventRecord[]>;
    get(eventId: string): Promise<TestEventRecord | undefined>;
  };
  readonly deliveries: {
    list(): Promise<StoredDelivery[]>;
    get(id: string): Promise<StoredDelivery | undefined>;
    retry(id: string, options?: { drain?: boolean }): Promise<boolean>;
  };
  readonly exhaustions: {
    list(): Promise<StoredExhaustion[]>;
    get(id: string): Promise<StoredExhaustion | undefined>;
    retry(id: string, options?: { drain?: boolean }): Promise<boolean>;
  };
}

export async function createTestRuntime(
  factory: ConfigFactory,
  options: TestRuntimeOptions = {},
): Promise<TestRuntime> {
  if (options.root !== undefined && options.project !== undefined) {
    throw new Error("Test runtime options cannot specify both root and project");
  }

  const project = options.project ?? await createProjectContext(options.root ?? process.cwd());
  const config = typeof factory === "function" ? await factory({ project }) : factory;
  const store = options.store ?? memoryStore();
  const runtime = new OrchestratorRuntime({
    project,
    config: {
      ...config,
      store,
      logger: options.logger ?? silentLogger,
      http: options.http ? { ...config.http, ...options.http } : { enabled: false },
    },
  });
  await runtime.init();

  let stopped = false;
  const assertRunning = () => {
    if (stopped) throw new Error("Cannot mutate a test runtime after it has been stopped");
  };
  const readState = () => store.read();

  return {
    runtime,
    project,
    store,
    async dispatch(channel, event, dispatchOptions = {}) {
      assertRunning();
      const result = typeof channel === "string"
        ? await runtime.dispatch(channel, event)
        : await runtime.dispatch(channel, event);
      if (dispatchOptions.drain ?? true) await runtime.drain();
      return result;
    },
    async drain() {
      assertRunning();
      await runtime.drain();
    },
    async stop() {
      stopped = true;
      await runtime.stop();
    },
    readState,
    sessions: {
      list: () => runtime.listSessions(),
      get: (idOrKey) => runtime.getSession(idOrKey),
      notes: (idOrKey) => runtime.listSessionNotes(idOrKey),
    },
    capacity: {
      list: () => runtime.listCapacityReservations(),
      async release(clientId, sessionIdOrKey, releaseOptions = {}) {
        assertRunning();
        const released = await runtime.releaseCapacity(clientId, sessionIdOrKey);
        if (released && (releaseOptions.drain ?? true)) await runtime.drain();
        return released;
      },
    },
    events: {
      list: () => runtime.listEvents(),
      async get(eventId) {
        return (await runtime.listEvents()).find(({ event }) => event.id === eventId);
      },
    },
    deliveries: {
      async list() {
        return (await readState()).deliveries;
      },
      async get(id) {
        return (await readState()).deliveries.find((delivery) => delivery.id === id);
      },
      async retry(id, retryOptions = {}) {
        assertRunning();
        const retried = await runtime.retryDelivery(id);
        if (retried && (retryOptions.drain ?? true)) await runtime.drain();
        return retried;
      },
    },
    exhaustions: {
      async list() {
        return (await readState()).exhaustions;
      },
      async get(id) {
        return (await readState()).exhaustions.find((work) => work.id === id);
      },
      async retry(id, retryOptions = {}) {
        assertRunning();
        const retried = await runtime.retryDelivery(id);
        if (retried && (retryOptions.drain ?? true)) await runtime.drain();
        return retried;
      },
    },
  };
}

export { memoryStore } from "../stores/memory.js";
