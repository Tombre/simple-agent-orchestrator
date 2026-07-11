# API reference

This reference covers the supported package subpaths: `simple-agent-orchestrator`, `simple-agent-orchestrator/runtime`, and `simple-agent-orchestrator/testing`. Project-local TypeScript examples use explicit `.ts` extensions.

## Export inventory

The root subpath exports config types/helpers; channel, client, environment, session, event, key, logger, retry, state, and stored-record types; `HandlerTimeoutError`; memory/JSON stores and state validation; `env`; and `parseDuration`.

The runtime subpath exports `OrchestratorRuntime`, `RuntimeOptions`, `StartOptions`, `OfflineOperationContext`, retention plan types, `createRuntime`, project/config discovery and loading helpers, `CreateRuntimeOptions`, and `LoadProjectOptions`.

The testing subpath exports `createTestRuntime`, `TestRuntime`, `TestRuntimeOptions`, `TestEventRecord`, and `memoryStore`. Internal modules are not public package subpaths.

## Definition contract

`createChannel`, `createClient`, and `createEnvironment` invoke their builder callbacks immediately. The builders configure mutable definition data. Returned definitions are readonly-typed and remain inspectable for composition and diagnostics, but neither the definitions nor their arrays are frozen.

`OrchestratorRuntime.init()` snapshots configuration and registrations. Mutations completed before initialization are included. Changes to config arrays, polls, handlers, environments, retry defaults, or HTTP config after initialization do not affect that runtime. Live runtime reconfiguration is unsupported; construct a fresh runtime for a changed configuration.

## `defineConfig(factory)`

Defines a project-local orchestrator config.

```ts
export default defineConfig(({ project }) => ({
  store: jsonFileStore(project.statePath("state.json")),
  channels: [manualChannel],
  clients: [exampleClient],
}));
```

### Config fields

```ts
type OrchestratorConfig = {
  name?: string;
  store?: Store;
  channels?: readonly ChannelDefinition[];
  clients?: readonly ClientDefinition[];
  logger?: Logger;
  retries?: RetryOptions;
  timeout?: number | string;
  http?: HttpConfig;
};

type RetryOptions = {
  attempts?: number;
  delay?: number | string;
};
```

`attempts` counts the first attempt and defaults to `3`. `delay` is a fixed wait between failed automatic attempts; it accepts milliseconds or the same `ms`, `s`, `m`, and `h` strings as poll intervals and defaults to `0`. Positive fractional values round up to one whole millisecond. The maximum is `2_147_483_647` ms (about 24.9 days).

`timeout` is the default cooperative deadline for each delivery attempt. It uses the same duration format, rounding, and maximum; `0` disables it. It does not apply to polls or environment mount/unmount hooks.

`defineConfig` is an identity helper. It accepts an `OrchestratorConfig` object or a synchronous/asynchronous factory receiving `{ project: ProjectContext }` and returns that value for project loaders, `createRuntime`, or `createTestRuntime` to resolve.

### HTTP config

```ts
type HttpConfig = {
  enabled?: boolean;
  hostname?: string;
  port?: number;
  middleware?: (context: HttpRegistrationContext) => void | Promise<void>;
  routes?: (context: HttpRegistrationContext) => void | Promise<void>;
};

type HttpRegistrationContext = {
  app: Hono;
  project: ProjectContext;
  logger: Logger;
  signal: AbortSignal;
  dispatch(channelId: string, event: DispatchEvent): Promise<{
    status: "queued" | "duplicate";
    eventId: string;
  }>;
};
```

Ordinary `start()` binds a Hono listener by default. The default is `127.0.0.1:3000`; the port resolves from `SAO_HTTP_PORT`, then `http.port`, then `3000`. Ports must be base-10 integers from `1` through `65535`. On `EADDRINUSE`, startup tries at most nine subsequent ports without probing and never wraps; all other listen errors fail immediately. The final URL and requested/actual ports are logged.

The awaited `middleware` hook runs before built-ins and the awaited `routes` hook runs afterward. Both are trusted project config. `GET /health` returns `{ "status": "ok" }` after ordinary runtime startup completes. `/health`, `/webhooks/*`, and `/api/v1/*` are reserved. The server does not provide authentication, authorization, signature verification, CORS, rate limiting, TLS, or exposure policy. A non-loopback bind logs a warning, but loopback is not an authentication boundary. Unauthenticated dispatch can trigger project side effects and unbounded durable state growth.

The built-in webhook and operational handlers have the validation and response contracts below. Project middleware and custom handlers are ordinary trusted Hono code and are not constrained from reading, logging, or returning request/event content. JSON state and default/project logs are plaintext and are not automatically redacted.

`POST /webhooks/:channelId` accepts a normalized event with `Content-Type: application/json` and a maximum encoded body size of 1 MiB. The body is an object with required non-whitespace `id`; optional `type`, `dedupeKey`, and `sessionKey` strings; optional JSON-safe `input` and `payload`; optional JSON object `meta`; and optional valid date string `occurredAt`. Unknown fields, primitives, arrays, malformed JSON, non-finite numbers, more than 100 levels of nesting, identifiers over 512 characters, and types over 256 characters are rejected. A new durable dispatch returns `202 { "status": "queued", "eventId": "..." }`; a duplicate returns `200 { "status": "duplicate", "eventId": "..." }` with the original internal ID. This confirms durable ingestion only and does not wait for handlers or promise exactly-once processing.

Webhook errors use `{ "error": { "code": "...", "message": "..." } }`: `400 invalid_request`, `404 unknown_channel`, `413 payload_too_large`, `415 unsupported_media_type`, or `500 internal_error`. Internal failures do not expose runtime messages or stack traces.

`GET /api/v1/status` returns `uptimeMs`, the actual bound `http.hostname` and `http.port`, event and session totals, and delivery totals for `pending`, `processing`, `processed`, and `failed`. `GET /api/v1/events?limit=N` returns `{ events, hasMore }`; each summary contains the internal and source IDs, channel, dedupe key, session key, optional type and occurrence time, receive time, and aggregate delivery counts. It omits input, payload, metadata, errors, and individual deliveries. `GET /api/v1/sessions?limit=N` returns `{ sessions, hasMore }` with IDs, keys, statuses, and lifecycle timestamps, omitting state, notes, and end reasons. Lists sort descending by `receivedAt` or `updatedAt`, then descending ID. The default limit is 25, the maximum is 100, and a missing limit is the only default; repeated, empty, non-integer, non-positive, or oversized values return `400 invalid_limit`.

## `createChannel(id, setup?)`

Creates an event source.

```ts
const channel = createChannel("github.reviews", (channel) => {
  channel.poll({
    id: "reviews",
    every: "60s",
    fetch: async () => [],
    map: async (item) => ({ id: item.id }),
  });
});
```

### `channel.poll(definition)`

```ts
type PollDefinition<TRaw> = {
  id?: string;
  every: number | string;
  immediate?: boolean;
  fetch(ctx: PollContext): Promise<TRaw[]> | TRaw[];
  map?(item: TRaw, ctx: PollContext): Promise<DispatchEvent | null | undefined> | DispatchEvent | null | undefined;
  commit?(ctx: PollCommitContext<TRaw>): Promise<void> | void;
};
```

`every` accepts milliseconds as a number or a string such as `"500ms"`, `"30s"`, `"5m"`, or `"1h"`.

`id` is an optional durable cursor identity. A named poll uses the cursor key `${channelId}:${id}`, so its cursor survives registration reordering. An unnamed poll keeps the positional key `${channelId}:${pollRegistrationIndex}` for compatibility and concise one-poll channels. Resolved poll IDs must be unique within a channel, and final cursor keys must be unique across the configuration. Name every poll in a multi-poll channel before reorganizing it; mixing named and positional polls can become ambiguous and is rejected when their resolved keys collide.

Adding or renaming a descriptive `id` does not infer a cursor migration: it selects the cursor at the new key, which is empty if that key has never existed, while the old record remains in persisted state. Reusing a historical ID restores that ID's existing cursor, so do not recycle IDs for unrelated polls. To adopt IDs without changing existing keys, first assign each poll its current registration index as a string, such as `id: "0"`; those IDs then remain stable when the polls move.

Poll order is `fetch`, sequential `map` and durable dispatch, `commit`, then cursor persistence. A failure rolls back cursor mutations but not events already dispatched. `commit` is an ingestion checkpoint and does not wait for handler success; use stable event dedupe keys for replay and acknowledge sources from a retry-safe, designated `onSuccess` hook. There is no event-wide hook that waits for every fan-out delivery.

## `createManualChannel(id?)`

Creates a channel with no polling behavior. It is useful for CLI dispatch and tests.

```ts
const manualChannel = createManualChannel("manual");
```

## Channel dispatch

Every `ChannelDefinition` includes `dispatch(event): Promise<DispatchResult>`. A runtime binds each registered definition when `init()` succeeds and unbinds it on `stop()`.

```ts
await manualChannel.dispatch({ id: "source-1" });
await runtime.dispatch(manualChannel, { id: "source-2" });
await runtime.dispatch("manual", { id: "source-3" });
```

`channel.dispatch` throws when the channel is not bound to an initialized runtime. It also throws when the same channel object is bound to multiple initialized runtimes, because it cannot select a destination. Use `runtime.dispatch(...)` to select explicitly. Object runtime dispatch requires the exact registered channel object; a lookalike definition with the same ID is unknown. String runtime dispatch resolves the registered global channel ID.

All dispatch forms persist the event and matching deliveries before resolving. `queued` can have zero matching handlers. A duplicate creates no new deliveries and returns the original internal event ID.

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

The normalized webhook transport is stricter than this in-process type: it accepts only JSON values, requires `occurredAt` to be a string, and applies the validation and size limits documented under HTTP config.

## `createClient(id, setup)`

Creates a delivery consumer.

```ts
const client = createClient("coding", (client) => {
  client.retries({ attempts: 3, delay: "5s" });
  client.timeout("10m");
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
  timeout: "2m",
  async handle(ctx) {},
  async onSuccess(ctx) {},
  async onFailure({ error }) {},
});
```

Attempt order is `handle`, `onSuccess`, required sandbox cleanup, then final persistence. An error from any step fails the attempt and can rerun `handle`. `onFailure` receives the original error when a handler context exists. Its own error is logged without replacing the original; setup failures before context creation do not invoke it.

Retry fields resolve independently in handler, client, global-config, then built-in order. The first attempt is immediate. A positive delay is captured on each delivery and stores the next eligibility time after a failed nonterminal attempt. Delayed work remains `pending`; normal workers process it after eligibility, including across restarts. `drain()` and `start({ drain: true })` process only currently eligible work and do not wait. Manual retry and interrupted-attempt recovery are immediately eligible.

Timeout resolves from the handler option, the client default captured when the handler is registered, global config, then `0` (disabled). The deadline covers sandbox creation, `handle`, `onSuccess`, and required sandbox cleanup. It aborts `HandlerContext.signal` and sandbox signals with an exported `HandlerTimeoutError`, waits for the current cooperative operation to settle, records that error, and applies ordinary retry rules. If runtime shutdown aborts first, the later deadline is cancelled and shutdown retains its existing semantics. `onFailure` receives the timeout error and already-aborted signal when a handler context exists; it is not itself deadline-bounded.

Timeout cancellation is cooperative, not forced. Code that ignores `signal` can continue blocking indefinitely, and timed-out external operations may already have produced side effects. Pass `signal` to project-owned APIs and keep their effects retry-safe. A handler that catches cancellation and returns is still recorded as timed out.

### `HandlerTimeoutError`

Exported error with a numeric `timeoutMs` property. Use `error instanceof HandlerTimeoutError` in `onFailure` when timeout-specific reporting is needed. Its name and message are retained in the delivery's `lastError`.

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

`signal` is aborted by either runtime shutdown or the configured attempt timeout. Pass it through to cancellation-aware project operations.

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

A webhook `202` is returned after event and matching-delivery persistence, before delivery processing. A `200 duplicate` identifies the original event; neither response reports processing success.

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

### `createRuntime(config, options?)`

```ts
import { createRuntime } from "simple-agent-orchestrator/runtime";

const runtime = await createRuntime(
  ({ project }) => ({
    name: String(project.packageJson.name ?? "orchestrator"),
    channels: [manualChannel],
    clients: [exampleClient],
  }),
  { root: process.cwd() },
);
```

`config` is an object or synchronous/asynchronous config factory. Options either supply `{ project: ProjectContext }` or project discovery fields `{ cwd?: string, root?: string }`; combining `project` with `cwd` or `root` is rejected. When config omits `store`, `createRuntime` uses `jsonFileStore(project.statePath("state.json"))`. It resolves config and constructs the runtime but does not start it or call `init()`.

### Project loading

```ts
import { loadProjectOrchestrator } from "simple-agent-orchestrator/runtime";

const { runtime } = await loadProjectOrchestrator({ root: process.cwd() });
await runtime.start();
// Or disable only this start's listener:
// await runtime.start({ http: false });
```

`findProjectRoot`, `createProjectContext`, `findConfigFile`, `loadConfigFile`, `loadProjectConfig`, and `loadProjectOrchestrator` are also exported for tooling. `LoadProjectOptions` accepts `cwd`, `root`, and `config`. TypeScript config loading uses `tsx` and executes trusted project code without type-checking it.

### Low-level constructor and initialization

```ts
import { OrchestratorRuntime } from "simple-agent-orchestrator/runtime";

const runtime = new OrchestratorRuntime({ project, config });
await runtime.init();
```

The constructor plus explicit `init()` is the low-level API for callers that already own project/config/store assembly. Unlike `createRuntime`, an omitted store here uses the runtime's in-memory default. `init()` compiles and validates the configuration, initializes and reads the store, snapshots definitions, and binds channels. Public runtime methods initialize lazily when needed. Prefer `createRuntime(config, options)` for programmatic persistent use and project loaders for CLI-style config discovery.

Each runtime instance has one lifecycle. `start()` may be called once; duplicate starts, a start after direct draining, and restart after `stop()` or failed startup are rejected. A direct `drain()` claims the runtime for draining and may be repeated sequentially until `stop()`, but overlapping drains are rejected. `stop()` rejects while startup or a drain is in progress, shares cleanup across concurrent calls, and is otherwise idempotent. Dispatch and administrative mutation methods reject after stop; inspection remains available. Create a fresh runtime rather than attempting to restart a stopped instance.

A drain stops when no delivery is currently eligible. It never sleeps for a future `nextAttemptAt`; delayed work remains durable for a later drain or for workers started by normal `start()`.

Runtime initialization reads state before attaching channels or starting work. Invalid state therefore rejects startup before polls, environment hooks, recovery, HTTP setup, or handlers run. Ordinary startup acquires ownership, validates state, recovers interrupted deliveries, mounts environments, sets up and binds HTTP, then starts pollers and workers. Route setup or listener failure therefore rolls back without starting orchestration side effects. Failed startup closes HTTP, aborts in-flight work, clears intervals, unmounts environments, and releases store ownership before rejecting. Environments are unmounted in reverse mount order, their hooks run in reverse registration order, and cleanup continues after a hook fails. A later `stop()` retries only unresolved cleanup. When startup and shutdown both fail, the runtime throws an `AggregateError` containing both failures.

Shutdown first stops HTTP acceptance and closes idle connections, then waits for accepted webhook, custom request, dispatch, administrative mutation, and worker work before unmounting environments and releasing ownership. HTTP-close, environment, and ownership failures are aggregated, and repeated or concurrent `stop()` calls retain the existing deterministic retry behavior.

Inspection methods can use the loaded runtime while it is active:

```ts
await runtime.listSessions();
await runtime.getSession(idOrKey);
await runtime.listSessionNotes(idOrKey);
await runtime.listEvents();
await runtime.printConfig();
await runtime.previewStatePrune({ before: "2026-01-01T00:00:00Z" });
```

The complete public method surface is:

```ts
await runtime.init();
await runtime.start({ drain: false, prettyStartupLog: true, http: false });
await runtime.stop();
await runtime.drain();
await runtime.runOffline(operation);
await runtime.dispatch(channelDefinitionOrId, event);
await runtime.listSessions();
await runtime.getSession(idOrKey);
await runtime.listSessionNotes(idOrKey);
await runtime.endSession(idOrKey, reason);
await runtime.listEvents(); // Array<{ event, deliveries }>
await runtime.previewStatePrune(options);
await runtime.pruneState(options);
await runtime.retryDelivery(deliveryId);
await runtime.printConfig();
runtime.project;
```

Mutation methods return booleans when absence/inapplicability is a normal library result: `endSession` is false only when no session matches; `retryDelivery` is false unless a failed delivery matches. CLI commands layer stricter missing/inapplicable errors over these methods.

These in-process methods and CLI inspection can expose complete stored records. The operational HTTP API is separately bounded and sanitized.

`previewStatePrune(options)` returns a `StatePrunePlan` without writing. `before` is a `Date` or an ISO 8601 timestamp with a timezone. Only processed deliveries whose `processedAt` is strictly before the cutoff are selected. Ended sessions whose `endedAt` is before the cutoff are selected only when no retained delivery references them and no durable `__sao.sandbox.*.created` marker is true; their notes are selected with them. Pending, processing, and failed deliveries, active/paused/failed sessions, cursors, missing or invalid historical timestamps, and sessions with active sandbox markers are preserved.

Events are the dedupe ledger and are retained by default. Set `dropDedupe: true` to select events whose `receivedAt` is before the cutoff and which have no retained delivery. Removing them allows the same `channelId + dedupeKey` to dispatch again. The plan reports exact `deliveryIds`, `sessionIds`, `noteIds`, and `eventIds`, otherwise-eligible events preserved by default in `dedupeProtectedEventIds`, and ended sessions blocked by a retained delivery or sandbox marker.

Use a fresh runtime for an offline mutation:

```ts
const { runtime: offlineRuntime } = await loadProjectOrchestrator();
await offlineRuntime.runOffline(async ({ dispatch, drain, endSession }) => {
  await dispatch(channelId, event);
  await drain();
  await endSession("completed-work", "operator");
});
```

`pruneState(options)` recomputes and applies the same plan under the runtime mutex. Use it inside `runOffline()` so persistent stores also hold runtime ownership; a prior preview is advisory and may become stale. No write occurs when the plan selects nothing. Back up persistent state before applying retention, especially with `dropDedupe`.

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

HTTP starts only for ordinary `start()`. It does not start for `start({ drain: true })`, direct `drain()`, `runOffline()`, project/config loading, inspection commands, or `createTestRuntime()` initialization.

`runOffline(operation)` requires an unused runtime, acquires the same ownership before invoking the callback, then always stops the one-shot runtime and releases ownership. It accepts synchronous or asynchronous callbacks and returns their value. An active owner or initialization failure prevents callback invocation. Context operations started by the callback are settled before ownership is released, even if the callback does not return their promises. Calls started after the callback settles reject, so do not retain the context.

```ts
type OfflineOperationContext = {
  dispatch(channel: ChannelDefinition | string, event: DispatchEvent): Promise<DispatchResult>;
  drain(): Promise<void>;
  endSession(idOrKey: string, reason?: string): Promise<boolean>;
  retryDelivery(deliveryId: string): Promise<boolean>;
  pruneState(options: StatePruneOptions): Promise<StatePrunePlan>;
};
```

The owned `drain()` processes eligible deliveries and performs interrupted-delivery recovery. `endSession` returns false when absent. `retryDelivery` returns false unless the delivery exists and is failed. `pruneState` recomputes and applies its plan under the mutex. Mutation-only scopes do not recover interrupted deliveries unless they call `drain()`.

This is local process-ownership enforcement, not general multi-process store coordination. Mutation methods called outside `start()`, `drain()`, or `runOffline()` do not independently acquire ownership.

## Testing API

Import from `simple-agent-orchestrator/testing`.

```ts
import { createTestRuntime } from "simple-agent-orchestrator/testing";

const test = await createTestRuntime(
  { channels: [manualChannel], clients: [exampleClient] },
  { root: process.cwd() },
);
await test.dispatch("manual", { id: "1", sessionKey: "demo", input: "hello" });
const session = await test.sessions.get("demo");
const notes = await test.sessions.notes("demo");
await test.stop();
```

`createTestRuntime(config, options?)` accepts the same config object/factory forms as `createRuntime`. Options select either `root` or `project` (not both) and may override `store`, `logger`, and `http`. Defaults are a new isolated memory store, silent logger, and disabled HTTP, overriding values in config. Explicit test options win. The harness resolves config and calls `runtime.init()` but starts no HTTP, polls, or workers.

The returned `TestRuntime` exposes:

```ts
test.runtime; // public OrchestratorRuntime escape hatch
test.project;
test.store;
await test.dispatch(channelOrId, event, { drain: false }); // drain defaults true
await test.drain();
await test.stop();
await test.readState();
await test.sessions.list();
await test.sessions.get(idOrKey);
await test.sessions.notes(idOrKey);
await test.events.list();
await test.events.get(internalEventId);
await test.deliveries.list();
await test.deliveries.get(deliveryId);
await test.deliveries.retry(deliveryId, { drain: false }); // drain defaults true
```

Event helpers expose `TestEventRecord` values shaped as `{ event: StoredEvent, deliveries: StoredDelivery[] }`. The nested event's `id` is internal and `sourceId` is the source ID. Delivery helpers expose the same stored delivery type directly. `readState()` exposes the configured store's complete snapshot; the default memory store clones it. Mutation helpers reject after `stop()`, while store-backed inspection remains possible. The harness processes only currently eligible work and never waits for a future `nextAttemptAt`. Use `test.runtime` only when lifecycle or runtime behavior is not represented by the focused helpers, and always clean it up.

`memoryStore` is re-exported from the testing subpath for explicit test-store setup.
