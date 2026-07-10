# API reference

This reference covers the public API exported from `simple-agent-orchestrator`.

## `defineConfig(factory)`

Defines a project-local orchestrator config.

```ts
export default defineConfig(({ project }) => ({
  store: jsonFileStore(project.statePath("state.json")),
  channels: [manualChannel],
  clients: [echoClient],
}));
```

### Config fields

```ts
type OrchestratorConfig = {
  name?: string;
  store?: Store;
  channels?: ChannelDefinition[];
  clients?: ClientDefinition[];
  logger?: Logger;
  retries?: RetryOptions;
};

type RetryOptions = {
  attempts?: number;
  delay?: number | string;
};
```

`attempts` counts the first attempt and defaults to `3`. `delay` is a fixed wait between failed automatic attempts; it accepts milliseconds or the same `ms`, `s`, `m`, and `h` strings as poll intervals and defaults to `0`. Positive fractional values round up to one whole millisecond. The maximum is `2_147_483_647` ms (about 24.9 days).

## `createChannel(id, setup?)`

Creates an event source.

```ts
const channel = createChannel("github.reviews", (channel) => {
  channel.poll({
    every: "60s",
    fetch: async () => [],
    map: async (item) => ({ id: item.id }),
  });
});
```

### `channel.poll(definition)`

```ts
type PollDefinition<TRaw> = {
  every: number | string;
  immediate?: boolean;
  fetch(ctx: PollContext): Promise<TRaw[]> | TRaw[];
  map?(item: TRaw, ctx: PollContext): Promise<DispatchEvent | null | undefined> | DispatchEvent | null | undefined;
  commit?(ctx: PollCommitContext<TRaw>): Promise<void> | void;
};
```

`every` accepts milliseconds as a number or a string such as `"500ms"`, `"30s"`, `"5m"`, or `"1h"`.

Poll order is `fetch`, sequential `map` and durable dispatch, `commit`, then cursor persistence. A failure rolls back cursor mutations but not events already dispatched. `commit` is an ingestion checkpoint and does not wait for handler success; use stable event dedupe keys for replay and acknowledge sources from a retry-safe, designated `onSuccess` hook. There is no event-wide hook that waits for every fan-out delivery.

## `createManualChannel(id?)`

Creates a channel with no polling behavior. It is useful for CLI dispatch and tests.

```ts
const manualChannel = createManualChannel("manual");
```

## `DispatchEvent`

```ts
type DispatchEvent<TPayload = unknown, TInput = unknown, TMeta = Record<string, unknown>> = {
  id: string;
  type?: string;
  dedupeKey?: string;
  sessionKey?: string;
  input?: TInput;
  payload?: TPayload;
  meta?: TMeta;
  occurredAt?: Date | string;
};
```

- `id` is required and should be stable for the source event.
- `dedupeKey` defaults to `id`.
- `sessionKey` defaults to `channelId:id`.
- `input` is intended for agent-facing content.
- `payload` is structured source data.
- `meta` is lightweight metadata used for routing or resource setup.

## `createClient(id, setup)`

Creates a delivery consumer.

```ts
const client = createClient("coding", (client) => {
  client.retries({ attempts: 3, delay: "5s" });
  client.handle(githubReviewsChannel, handleReview);
});
```

### `client.handle(channel, handler)`

```ts
client.handle(channel, async ({ event, session }) => {
  session.set("lastEvent", event.id);
});
```

### `client.handle(channel, options)`

```ts
client.handle(channel, {
  retries: { attempts: 5, delay: "30s" },
  async handle(ctx) {},
  async onSuccess(ctx) {},
  async onFailure({ error }) {},
});
```

Attempt order is `handle`, `onSuccess`, required sandbox cleanup, then final persistence. An error from any step fails the attempt and can rerun `handle`. `onFailure` receives the original error when a handler context exists. Its own error is logged without replacing the original; setup failures before context creation do not invoke it.

Retry fields resolve independently in handler, client, global-config, then built-in order. The first attempt is immediate. A positive delay is captured on each delivery and stores the next eligibility time after a failed nonterminal attempt. Delayed work remains `pending`; normal workers process it after eligibility, including across restarts. `drain()` and `start({ drain: true })` process only currently eligible work and do not wait. Manual retry and interrupted-attempt recovery are immediately eligible.

### `client.useEnvironment(environment)`

Attaches an environment to the client.

```ts
client.useEnvironment(opencodeEnvironment);
```

### `client.concurrency(options)`

```ts
client.concurrency({ workers: 4, perSession: true });
```

## `HandlerContext`

```ts
type HandlerContext = {
  event: OrchestratorEvent;
  session: Session;
  environment: EnvironmentInstance;
  client: ClientDefinition;
  project: ProjectContext;
  logger: Logger;
  attempt: number;
  signal: AbortSignal;
};
```

## `Session`

```ts
session.id;
session.key;
session.status;

session.get(key);
session.getOptional(key);
session.set(key, value);
session.has(key);
session.delete(key);

await session.ensure(key, factory);
session.note(message, data);
session.end({ reason });
```

Ordinary handler/hook state changes, notes, and `session.end()` are committed only after the complete delivery attempt succeeds. Failed-attempt changes are discarded. Values created through `session.ensure` and state mutations made during sandbox creation are persisted eagerly so retries reuse them, but external work is not atomic with those writes and can repeat after an uncertain failure.

## `sessionKey`, `envKey`, `cursorKey`

Typed state keys.

```ts
const agentSessionId = sessionKey<string>("agent.sessionId");
const serverUrl = envKey<string>("opencode.serverUrl");
const cursor = cursorKey<string>("lastUpdatedAt");
```

## `defineKey(namespace, options?)`

Builds stable namespaced keys for session or dedupe ids.

```ts
const githubPr = defineKey<{ owner: string; repo: string; number: number }>(
  "github.pr",
  { parts: ["owner", "repo", "number"] },
);

const sessionKey = githubPr({ owner: "acme", repo: "api", number: 42 });
```

Output:

```text
github.pr:owner=acme:repo=api:number=42
```

## `createEnvironment(id, setup)`

Creates a client environment.

```ts
const environment = createEnvironment("opencode", (environment) => {
  environment.onMount(async ({ environment }) => {
    environment.set("serverUrl", "http://localhost:1234");
  });

  environment.onUnmount(async () => {});
});
```

### `environment.useSandbox(definition)`

```ts
environment.useSandbox({
  async create({ session, event }) {},
  async cleanup({ session }) {},
});
```

Completed sandbox creation, its state mutations, and its marker are persisted eagerly and reused across normal handler retries and restarts. Cleanup runs after `handle` and `onSuccess` when the handler called `session.end()`, and cleanup failure fails the attempt. If cleanup succeeds but final delivery persistence fails, a retry creates a new sandbox. Sandbox locking is process-local, and marker persistence is not atomic with external work, so hooks must reconcile the complete create-cleanup-recreate lifecycle by stable identity.

## Delivery guarantees

Processing is retryable, not exactly once. Event dedupe prevents duplicate dispatch records; it does not prevent handlers, hooks, resource operations, or source acknowledgement from repeating after a failed attempt. Use stable operation-specific external idempotency keys that do not include `attempt`. See [Failure semantics and idempotency](guides/failure-semantics.md).

`StoredDelivery.retryDelayMs` records the resolved fixed delay. A pending delivery with `nextAttemptAt` is delayed until that durable timestamp; `listEvents()` and `events list` expose it for inspection.

## Stores

### `memoryStore(initial?)`

In-memory store for tests and examples.

### `jsonFileStore(path)` / `fileStore(path)`

Persistent JSON-file store.

```ts
jsonFileStore(project.statePath("state.json"));
```

The current state version is `CURRENT_STATE_VERSION` (`3`), and `MINIMUM_STATE_VERSION` is `1`. JSON reads and writes validate the complete snapshot, including entity shapes, statuses, retry counters and eligibility, unique IDs, references, cursor records, and JSON-safe durable values up to 100 nested levels. Valid version 1 and 2 snapshots are deterministically migrated in memory with `retryDelayMs: 0`; read-only inspection leaves the file unchanged, while the next successful write persists version 3. Missing files are initialized with a current empty snapshot. Invalid JSON, invalid state, versions older than 1, and versions newer than 3 throw `StateValidationError` without replacing the file. Its `code` is `invalid-json`, `invalid-state`, or `unsupported-version`.

`validateAndMigrateState(value, source?)` is available for custom stores that decode untrusted persisted data. It returns a validated current `OrchestratorState` or throws `StateValidationError`. Custom `Store.read()` implementations are responsible for returning a valid current snapshot.

The store interface is:

```ts
type Store = {
  readonly name: string;
  readonly runtimeLockPath?: string;
  init(): Promise<void>;
  read(): Promise<OrchestratorState>;
  write(state: OrchestratorState): Promise<void>;
};
```

`runtimeLockPath` opts a store into local single-active-runtime enforcement. `jsonFileStore` sets it automatically beside the state file. Custom stores should set it when they rely on the runtime's process-local coordination. A store may omit it when each runtime has isolated state or when the store independently rejects additional active runtimes; the snapshot `Store` interface does not make coordinated multi-runtime execution safe.

Atomic missing-state initialization and local ownership records use hard links and therefore require a local hard-link-capable filesystem. Unsupported filesystems fail initialization or startup with an explicit error rather than risking replacement or running without ownership enforcement.

## Runtime API

Import from `simple-agent-orchestrator/runtime`.

```ts
import { loadProjectOrchestrator } from "simple-agent-orchestrator/runtime";

const { runtime } = await loadProjectOrchestrator({ root: process.cwd() });
await runtime.start();
```

Each runtime instance has one lifecycle. `start()` may be called once; duplicate starts, a start after direct draining, and restart after `stop()` or failed startup are rejected. A direct `drain()` claims the runtime for draining and may be repeated sequentially until `stop()`, but overlapping drains are rejected. `stop()` rejects while startup or a drain is in progress, shares cleanup across concurrent calls, and is otherwise idempotent. Create a fresh runtime rather than attempting to restart a stopped instance.

A drain stops when no delivery is currently eligible. It never sleeps for a future `nextAttemptAt`; delayed work remains durable for a later drain or for workers started by normal `start()`.

Runtime initialization reads state before attaching channels or starting work. Invalid state therefore rejects startup before polls, environment hooks, recovery, or handlers run. If startup otherwise fails after mounting resources or creating pollers, the runtime aborts in-flight work, clears intervals, unmounts environments, and releases store ownership before rejecting. Environments are unmounted in reverse mount order, their hooks run in reverse registration order, and cleanup continues after a hook fails. A later `stop()` retries only failed unmount hooks. When startup and shutdown both fail, the runtime throws an `AggregateError` containing both failures.

Inspection methods can use the loaded runtime while it is active:

```ts
await runtime.listSessions();
await runtime.getSession(idOrKey);
await runtime.listSessionNotes(idOrKey);
await runtime.listEvents();
await runtime.printConfig();
```

Use a fresh runtime for an offline mutation:

```ts
const { runtime: offlineRuntime } = await loadProjectOrchestrator();
await offlineRuntime.runOffline(async ({ drain }) => {
  await offlineRuntime.dispatch(channelId, event);
  // endSession() and retryDelivery() belong in this scope too.
  await drain();
});
```

For a direct drain lifecycle, use another fresh runtime and pair `drain()` with `stop()`:

```ts
const { runtime: drainRuntime } = await loadProjectOrchestrator();
try {
  await drainRuntime.drain();
} finally {
  await drainRuntime.stop();
}
```

`start()` and `drain()` acquire the configured store's runtime lock and hold it until `stop()`; `start({ drain: true })` releases it automatically even when polling, mounting, or processing fails. After ownership is acquired, every processing lifecycle automatically requeues persisted `processing` deliveries and warns with their IDs and interrupted attempt numbers. Recovery preserves the consumed attempt and grants one replacement attempt only when needed to make an interruption at the retry limit eligible again. The complete handler attempt may repeat, including uncertain external effects.

`runOffline(operation)` requires an unused runtime, acquires the same ownership before invoking the callback, then always stops the one-shot runtime and releases ownership. Its callback receives an owned `drain()` function for processing deliveries without opening another lifecycle scope; that drain also performs interrupted-delivery recovery. Use the scope for direct offline calls to `dispatch`, `endSession`, or `retryDelivery`; an active owner causes it to fail before invoking the callback. A lock whose PID is no longer alive is reclaimed automatically. Mutation-only offline operations do not recover deliveries unless they invoke `drain()`.

This is local process-ownership enforcement, not general multi-process store coordination. Mutation methods called outside `start()`, `drain()`, or `runOffline()` do not independently acquire ownership.

## Testing API

Import from `simple-agent-orchestrator/testing`.

```ts
import { createTestRuntime } from "simple-agent-orchestrator/testing";

const test = await createTestRuntime({ config });
await test.dispatch("manual", { id: "1", sessionKey: "demo", input: "hello" });
const session = await test.sessions.get("demo");
const notes = await test.sessions.notes("demo");
```

The test harness drains currently eligible work after dispatch. With a positive retry delay, inspect the pending delivery and invoke `test.runtime.drain()` again after advancing its eligibility; the harness does not wait for future retry times.
