# API reference

The package requires Node.js 20 or newer and is ESM-only.

| Import path | Use it for |
| --- | --- |
| `simple-agent-orchestrator` | Config, channels, clients, sessions, environments, stores, keys, and utilities |
| `simple-agent-orchestrator/runtime` | Runtime creation and lifecycle, project loading, inspection, and maintenance |
| `simple-agent-orchestrator/testing` | In-memory integration tests |

Internal package paths are not public APIs.

## Contents

- [Root exports](#root-exports)
- [Configuration](#configuration)
- [HTTP server](#http-server)
- [Channels and events](#channels-and-events)
- [Clients and handlers](#clients-and-handlers)
- [Sessions](#sessions)
- [Environments and sandboxes](#environments-and-sandboxes)
- [Keys and utilities](#keys-and-utilities)
- [Stores and state](#stores-and-state)
- [Runtime API](#runtime-api)
- [Project loading](#project-loading)
- [Testing API](#testing-api)

## Quick API links

| Area | APIs |
| --- | --- |
| Config | [`defineConfig`](#defineconfigfactory), [`OrchestratorConfig`](#orchestratorconfig), [`RetryOptions`](#retryoptions), [`HttpConfig`](#httpconfig) |
| Channels | [`createChannel`](#createchannelid-setup), [`createManualChannel`](#createmanualchannelid), [`channel.poll`](#channelpolldefinition), [`Cursor`](#cursor) |
| Events | [`DispatchEvent`](#dispatchevent), [`DispatchResult`](#dispatchresult), [dispatch methods](#dispatch-methods) |
| Clients | [`createClient`](#createclientid-setup), [`ClientBuilder`](#clientbuilder), [`client.handle`](#clienthandlechannel-options), [`HandlerContext`](#handlercontext), [`HandlerTimeoutError`](#handlertimeouterror) |
| Sessions and resources | [`Session`](#session), [`createEnvironment`](#createenvironmentid-setup), [`EnvironmentInstance`](#environmentinstance), [`SandboxDefinition`](#sandboxdefinition) |
| Keys and utilities | [Typed state keys](#sessionkey-envkey-and-cursorkey), [`defineKey`](#definekeynamespace-options), [`parseDuration`](#parsedurationvalue), [`env`](#env) |
| Stores | [`Store`](#store), [`memoryStore`](#memorystoreinitial), [`jsonFileStore`](#jsonfilestorepath-and-filestorepath), [state validation](#state-validation), [saved records](#saved-records) |
| Runtime | [`createRuntime`](#createruntimeconfig-options), [`OrchestratorRuntime`](#new-orchestratorruntimeoptions), [start and stop](#start-and-stop-a-runtime), [`runOffline`](#runofflineoperation), [state retention](#state-retention) |
| Projects and tests | [`ProjectContext`](#projectcontext), [project loading](#discovery-and-loading-functions), [`createTestRuntime`](#createtestruntimeconfig-options), [`TestRuntime`](#testruntime) |

## Root exports

Import these APIs from `simple-agent-orchestrator`.

### Functions and classes

| Export | Purpose |
| --- | --- |
| `defineConfig` | Defines project configuration. |
| `createChannel` | Creates a channel that can register polls. |
| `createManualChannel` | Creates a channel with no polls. |
| `createClient` | Creates a client and its handlers. |
| `createEnvironment` | Defines client process resources and an optional session sandbox. |
| `HandlerTimeoutError` | Identifies a cooperative handler timeout. |
| `StateValidationError` | Reports invalid saved state or an unsupported state version. |
| `CURRENT_STATE_VERSION` | Current saved-state format version. |
| `MINIMUM_STATE_VERSION` | Oldest state version accepted for migration. |
| `defineKey` | Builds stable namespaced string keys. |
| `sessionKey` | Creates a typed session-state key. |
| `envKey` | Creates a typed environment-value key. |
| `cursorKey` | Creates a typed cursor key. |
| `memoryStore` | Creates an isolated in-memory store. |
| `jsonFileStore` | Creates a JSON-file store. |
| `fileStore` | Alias for `jsonFileStore`. |
| `validateAndMigrateState` | Checks decoded state and upgrades supported older versions. |
| `parseDuration` | Converts a duration value to milliseconds. |
| `env` | Reads and validates process environment variables. |

### Exported types

| Domain | Types |
| --- | --- |
| Config | `DefineConfigContext`, `ConfigFactory`, `HttpConfig`, `HttpDispatch`, `HttpRegistrationContext`, `HttpRegistrationHook`, `OrchestratorConfig` |
| Channels | `ChannelBuilder`, `ChannelDefinition`, `ChannelRuntimeApi`, `Cursor`, `PollCommitContext`, `PollContext`, `PollDefinition` |
| Clients | `ClientBuilder`, `ClientDefinition`, `EventHandler`, `HandlerContext`, `HandleOptions` |
| Environments | `EnvironmentBuilder`, `EnvironmentDefinition`, `EnvironmentHookContext`, `EnvironmentInstance`, `SandboxContext`, `SandboxDefinition` |
| Events and state | `ConcurrencyOptions`, `DispatchEvent`, `DispatchResult`, `JsonRecord`, `JsonValue`, `OrchestratorEvent`, `OrchestratorState`, `ProjectContext`, `RetryOptions`, `SessionNote`, `StoredDelivery`, `StoredEvent`, `StoredSession` |
| Keys and logging | `KeyBuilder`, `KeyLike`, `Logger`, `StateKey` |
| Sessions | `Session`, `SessionEndOptions` |
| Stores | `StateValidationErrorCode`, `Store` |

## When definitions are read

Builder callbacks run during `createChannel`, `createClient`, and `createEnvironment`. Returned definitions are readonly-typed and inspectable, but not frozen.

`runtime.init()` snapshots the configured definitions. Later changes do not affect that runtime; create a new runtime to apply them.

## Configuration

### `defineConfig(factory)`

Returns the config object or factory unchanged. Use it as the typed default export of a config file.

```ts
declare function defineConfig(factory: ConfigFactory): ConfigFactory;

type ConfigFactory =
  | OrchestratorConfig
  | ((context: DefineConfigContext) =>
      OrchestratorConfig | Promise<OrchestratorConfig>);

interface DefineConfigContext {
  project: ProjectContext;
}
```

Example:

```ts
export default defineConfig(({ project }) => ({
  store: jsonFileStore(project.statePath("state.json")),
  clients: [exampleClient],
}));
```

### `OrchestratorConfig`

```ts
interface OrchestratorConfig {
  name?: string;
  store?: Store;
  channels?: readonly ChannelDefinition[];
  clients?: readonly ClientDefinition[];
  logger?: Logger;
  retries?: RetryOptions;
  timeout?: number | string;
  http?: HttpConfig;
}
```

| Field | Default | Description |
| --- | --- | --- |
| `name` | `undefined` | Optional configuration name. |
| `store` | Depends on the construction API | Store for events, deliveries, sessions, notes, and cursors. |
| `channels` | `[]` | Additional globally unique channel definitions, including channels without client handlers. |
| `clients` | `[]` | Globally unique client definitions. |
| `logger` | Console logger | Logger used by the runtime. |
| `retries` | Three attempts, zero delay | Global retry defaults. |
| `timeout` | `0` | Global handler timeout. Zero disables it. |
| `http` | Enabled by `start()` | Built-in server and project route configuration. |

During `init()`, the runtime registers explicit `channels` first, then the exact channel definitions referenced by configured client handlers in client and handler registration order. A handler channel already registered explicitly or through another handler is not added again. Duplicate entries in `channels` and distinct channel definitions with the same ID cause initialization to fail. Channels without handlers must be listed explicitly when the runtime needs them for polling or dispatch.

### `RetryOptions`

```ts
interface RetryOptions {
  attempts?: number;
  delay?: number | string;
}
```

`attempts` includes the first attempt and is clamped to at least one. `delay` is fixed; there is no backoff or jitter.

Duration values accept milliseconds as numbers or strings using `ms`, `s`, `m`, or `h`. Positive retry delays and timeouts are rounded up to a whole millisecond and cannot exceed `2_147_483_647` ms.

## HTTP server

### `HttpConfig`

```ts
interface HttpConfig {
  enabled?: boolean;
  hostname?: string;
  port?: number;
  middleware?: HttpRegistrationHook;
  routes?: HttpRegistrationHook;
}

type HttpRegistrationHook =
  (context: HttpRegistrationContext) => void | Promise<void>;

interface HttpRegistrationContext {
  app: Hono;
  project: ProjectContext;
  logger: Logger;
  signal: AbortSignal;
  dispatch: HttpDispatch;
}

type HttpDispatch = (
  channelId: string,
  event: DispatchEvent,
) => Promise<DispatchResult>;
```

`runtime.start()` starts HTTP by default. Disable it with config `http.enabled: false` or start option `{ http: false }`. The hostname defaults to `127.0.0.1`. Port precedence is `SAO_HTTP_PORT`, `http.port`, then `3000`.

If the selected port is in use, startup tries up to the next nine ports without going past `65535`. The runtime logs the bound address.

`middleware` runs before built-in routes; `routes` runs after them. Startup awaits both hooks. Their `signal` aborts during runtime shutdown.

The server provides no authentication, authorization, provider signature verification, CORS, rate limiting, or TLS.

### Built-in routes

| Method and path | Response |
| --- | --- |
| `GET /health` | Runtime health. |
| `POST /webhooks/:channelId` | Normalized event dispatch result. |
| `GET /api/v1/status` | Runtime, event, session, and delivery totals. |
| `GET /api/v1/events?limit=N` | Bounded event summaries. |
| `GET /api/v1/sessions?limit=N` | Bounded session summaries. |

`/health`, `/webhooks/*`, and `/api/v1/*` are reserved.

The webhook requires `Content-Type: application/json` and a body of at most 1 MiB. Only `DispatchEvent` fields are accepted. `id` must be non-empty; values must be JSON-safe; nesting is limited to 100 levels; identifiers to 512 characters; and `type` to 256 characters.

| Result | Status |
| --- | --- |
| New event saved | `202` with `{ status: "queued", eventId }` |
| Duplicate event | `200` with `{ status: "duplicate", eventId }` |
| Invalid request | `400 invalid_request` |
| Unknown channel | `404 unknown_channel` |
| Body too large | `413 payload_too_large` |
| Wrong media type | `415 unsupported_media_type` |
| Internal error | `500 internal_error` |

Operational lists default to 25 records. `limit` accepts 1 through 100. Responses omit event bodies, metadata, session state, notes, delivery errors, and individual deliveries.

## Channels and events

### `createChannel(id, setup?)`

Creates a channel with optional polls.

```ts
declare function createChannel(
  id: string,
  setup?: (channel: ChannelBuilder) => void,
): ChannelDefinition;

interface ChannelBuilder {
  poll<TRaw = unknown>(definition: PollDefinition<TRaw>): void;
}

interface ChannelDefinition {
  readonly id: string;
  readonly polls: readonly PollDefinition[];
  readonly dispatch: (event: DispatchEvent) => Promise<DispatchResult>;
}
```

Channel IDs must be globally unique.

### `createManualChannel(id?)`

Creates a channel with no polls. The default ID is `manual`.

```ts
declare function createManualChannel(id?: string): ChannelDefinition;
```

### `channel.poll(definition)`

Registers a poll on the channel.

```ts
interface PollDefinition<TRaw = unknown> {
  readonly id?: string;
  readonly every: number | string;
  readonly immediate?: boolean;
  readonly fetch: (context: PollContext) => Promise<TRaw[]> | TRaw[];
  readonly map?: (
    item: TRaw,
    context: PollContext,
  ) => Promise<DispatchEvent | null | undefined>
    | DispatchEvent
    | null
    | undefined;
  readonly commit?: (
    context: PollCommitContext<TRaw>,
  ) => Promise<void> | void;
}
```

`immediate` defaults to `true`. `every` accepts the package duration format.

```ts
interface PollContext {
  channel: ChannelRuntimeApi;
  cursor: Cursor;
  project: ProjectContext;
  logger: Logger;
  signal: AbortSignal;
}

interface PollCommitContext<TRaw = unknown> extends PollContext {
  items: TRaw[];
  events: DispatchEvent[];
}
```

A poll runs `fetch`, maps each item sequentially, saves mapped events, runs `commit`, then saves cursor changes. On failure, cursor changes are discarded; events already saved remain in the store.

A named poll uses cursor ID `${channelId}:${pollId}`. An unnamed poll uses `${channelId}:${registrationIndex}`. Renaming a named poll or reordering unnamed polls can select different saved cursor data; cursors are not migrated.

Executions of the same poll do not overlap within one runtime process.

### `Cursor`

Reads and changes one poll's cursor values. All methods are synchronous.

```ts
interface Cursor {
  get<T = unknown>(key: KeyLike<T>): T | undefined;
  set<T = unknown>(key: KeyLike<T>, value: T): void;
  delete(key: KeyLike): void;
  entries(): Record<string, unknown>;
}
```

Cursor changes are saved only after `fetch`, `map`, event dispatch, and `commit` succeed.

### `DispatchEvent`

```ts
interface DispatchEvent<
  TPayload = unknown,
  TInput = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  id: string;
  type?: string;
  dedupeKey?: string;
  sessionKey?: string;
  input?: TInput;
  payload?: TPayload;
  meta?: TMeta;
  occurredAt?: Date | string;
}
```

`dedupeKey` defaults to `id`. `sessionKey` defaults to `${channelId}:${id}`. Dedupe is scoped to channel ID and dedupe key.

### `DispatchResult`

```ts
interface DispatchResult {
  status: "queued" | "duplicate";
  eventId: string;
}
```

`eventId` is the stored event's internal ID. `queued` does not imply that a handler matched. A duplicate creates no deliveries and returns the original event ID.

### Dispatch methods

```ts
await channel.dispatch(event);
await runtime.dispatch(channel, event);
await runtime.dispatch(channelId, event);
```

Dispatch resolves after the event and all matching deliveries are saved to the store.

`channel.dispatch` requires that exact channel definition to be bound to exactly one initialized runtime. `runtime.dispatch(channel, event)` requires the exact registered definition. `runtime.dispatch(channelId, event)` looks up the channel by ID.

These methods do not acquire JSON-store ownership by themselves. Use them on a runtime that already owns the store through `start()` or `drain()`. For one-off persistent changes, use `runOffline()`. Unscoped direct calls are appropriate with isolated state such as `memoryStore()`.

## Clients and handlers

### `createClient(id, setup)`

Creates a consumer and registers channel handlers.

```ts
declare function createClient(
  id: string,
  setup: (client: ClientBuilder) => void,
): ClientDefinition;
```

Client IDs must be globally unique.

### `ClientBuilder`

```ts
interface ClientBuilder {
  useEnvironment(environment: EnvironmentDefinition): void;
  concurrency(options: ConcurrencyOptions): void;
  retries(options: RetryOptions): void;
  timeout(value: number | string): void;
  handle(channel: ChannelDefinition, handler: EventHandler | HandleOptions): void;
}
```

`useEnvironment` sets one environment. A later call replaces it.

A handler captures the client's retry and timeout defaults when `handle` is called. Precedence is handler, client, config, then package default.

### `client.handle(channel, handler)`

```ts
type EventHandler =
  (context: HandlerContext) => Promise<void> | void;
```

### `client.handle(channel, options)`

```ts
interface HandleOptions<
  TPayload = unknown,
  TInput = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly id?: string;
  readonly retries?: RetryOptions;
  readonly timeout?: number | string;
  readonly handle: EventHandler<TPayload, TInput, TMeta>;
  readonly onSuccess?: EventHandler<TPayload, TInput, TMeta>;
  readonly onFailure?: (
    context: HandlerContext<TPayload, TInput, TMeta> & { error: unknown },
  ) => Promise<void> | void;
}
```

Default handler IDs use `${clientId}:${channelId}:${registrationIndex}` with a one-based index. Handler IDs must be unique within a client.

Each attempt creates the sandbox if needed, runs `handle`, runs `onSuccess`, cleans up the sandbox if the session ended, then saves the result. An error after context creation calls `onFailure`. Errors from `onFailure` are logged and do not replace the attempt error.

Processing is retryable, not exactly once. `handle`, `onSuccess`, cleanup, and external effects can repeat. Keep external effects idempotent.

### `HandlerContext`

```ts
interface HandlerContext<
  TPayload = unknown,
  TInput = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  event: OrchestratorEvent<TPayload, TInput, TMeta>;
  session: Session;
  environment: EnvironmentInstance;
  client: ClientDefinition;
  project: ProjectContext;
  logger: Logger;
  attempt: number;
  signal: AbortSignal;
}
```

`environment` and `signal` are always present. Without a configured environment, the client receives an empty environment with ID `default`.

### `OrchestratorEvent`

The event passed to handlers. It adds the channel ID, resolved dedupe and session keys, and receive time to `DispatchEvent`:

```ts
interface OrchestratorEvent extends DispatchEvent {
  channelId: string;
  dedupeKey: string;
  sessionKey: string;
  receivedAt: string;
  occurredAt?: string;
}
```

### `client.concurrency(options)`

```ts
interface ConcurrencyOptions {
  workers?: number;
  perSession?: boolean;
}
```

Defaults: `workers: 1` and `perSession: false`. `workers` is clamped to at least one. `perSession: true` serializes that client's same-session deliveries within one runtime process.

### `HandlerTimeoutError`

```ts
declare class HandlerTimeoutError extends Error {
  readonly timeoutMs: number;
}
```

On timeout, the runtime aborts the attempt's `signal` with this error. Timeout is cooperative: code that ignores the signal is not forcibly stopped. The timeout covers sandbox creation, `handle`, `onSuccess`, and sandbox cleanup.

## Sessions

### `Session`

```ts
interface Session {
  readonly id: string;
  readonly key: string;
  readonly status: StoredSession["status"];

  get<T = unknown>(key: KeyLike<T>): T;
  getOptional<T = unknown>(key: KeyLike<T>): T | undefined;
  set<T = unknown>(key: KeyLike<T>, value: T): void;
  has(key: KeyLike): boolean;
  delete(key: KeyLike): void;

  ensure<T = unknown>(
    key: KeyLike<T>,
    factory: () => Promise<T> | T,
  ): Promise<T>;

  note(message: string, data?: unknown): void;
  end(options?: SessionEndOptions): void;
}

interface SessionEndOptions {
  reason?: string;
}
```

`get` throws when the key is absent. `getOptional` returns `undefined`.

`set`, `delete`, `note`, and `end` changes are saved only when the attempt succeeds. `ensure` saves its result immediately for reuse by retries.

Ended sessions remain in the store. A later delivery with the same key creates a new active session.

Concurrent deliveries merge changes to different state keys. For the same key, the last attempt to complete wins. A concurrent handler cannot undo `end()`.

**Lookup caution:** Runtime and CLI inspection accept a session ID or key. If a key has historical and active records, lookup by key can return an older record. Use the session ID to select a specific record.

## Environments and sandboxes

### `createEnvironment(id, setup)`

Creates process-local values for a client and an optional session sandbox.

```ts
declare function createEnvironment(
  id: string,
  setup: (environment: EnvironmentBuilder) => void,
): EnvironmentDefinition;
```

### `EnvironmentBuilder`

```ts
interface EnvironmentBuilder {
  onMount(hook: (context: EnvironmentHookContext) => Promise<void> | void): void;
  onUnmount(hook: (context: EnvironmentHookContext) => Promise<void> | void): void;
  useSandbox(sandbox: SandboxDefinition): void;
}
```

A later `useSandbox` call replaces the previous sandbox definition.

```ts
interface EnvironmentHookContext {
  environment: EnvironmentInstance;
  project: ProjectContext;
  logger: Logger;
  signal: AbortSignal;
}
```

Mount hooks run in registration order. Environments unmount in reverse mount order, and their hooks run in reverse registration order.

### `EnvironmentInstance`

Holds process-local values for one client. Values are not saved to the store.

```ts
interface EnvironmentInstance {
  readonly id: string;
  get<T = unknown>(key: KeyLike<T>): T;
  getOptional<T = unknown>(key: KeyLike<T>): T | undefined;
  set<T = unknown>(key: KeyLike<T>, value: T): void;
  has(key: KeyLike): boolean;
  delete(key: KeyLike): void;
}
```

`get` throws when absent. Instances are scoped by client ID and environment ID.

### `SandboxDefinition`

```ts
interface SandboxDefinition {
  readonly create: (context: SandboxContext) => Promise<void> | void;
  readonly cleanup?: (context: SandboxContext) => Promise<void> | void;
}

interface SandboxContext extends EnvironmentHookContext {
  session: Session;
  event: DispatchEvent;
}
```

After `create` succeeds, its session changes and sandbox marker are saved immediately. `cleanup` runs after `handle` and `onSuccess` when the handler ends the session. A cleanup error fails the attempt.

Sandbox locking is limited to one runtime process. `endSession` does not run cleanup. Stopping the runtime does not clean every active sandbox.

## Keys and utilities

### `sessionKey`, `envKey`, and `cursorKey`

Create typed state keys.

```ts
interface StateKey<T = unknown> {
  readonly name: string;
  readonly scope: "session" | "environment" | "cursor";
  readonly __type?: T;
}

declare function sessionKey<T = unknown>(name: string): StateKey<T>;
declare function envKey<T = unknown>(name: string): StateKey<T>;
declare function cursorKey<T = unknown>(name: string): StateKey<T>;
```

Accessors also accept plain strings through `KeyLike<T> = StateKey<T> | string`.

### `defineKey(namespace, options?)`

Returns a builder for deterministic, URI-encoded string keys.

```ts
declare function defineKey<
  TParts extends Record<string, string | number | boolean>,
>(
  namespace: string,
  options?: { parts?: readonly (keyof TParts)[] },
): KeyBuilder<TParts>;
```

When `parts` is omitted, part names are sorted. Output uses `namespace:key=value:key=value`.

```ts
const pullRequest = defineKey<{ owner: string; number: number }>(
  "github.pr",
  { parts: ["owner", "number"] },
);

pullRequest({ owner: "acme", number: 42 });
// github.pr:owner=acme:number=42
```

### `parseDuration(value)`

```ts
declare function parseDuration(value: number | string): number;
```

Returns milliseconds. Strings accept decimal values with `ms`, `s`, `m`, or `h`. Negative, non-finite, and unsupported values throw.

### `env`

```ts
declare const env: {
  required(name: string): string;
  optional(name: string, fallback?: string): string | undefined;
  number(name: string, fallback?: number): number;
  duration(name: string, fallback: number | string): number;
  getRequiredNames(): string[];
};
```

`required` treats an empty value as missing. `number` validates numeric input. `duration` uses `parseDuration`. Required names are tracked for `doctor` output.

## Stores and state

### `Store`

A store reads and writes the complete runtime state.

```ts
interface Store {
  readonly name: string;
  readonly runtimeLockPath?: string;
  init(): Promise<void>;
  read(): Promise<OrchestratorState>;
  write(state: OrchestratorState): Promise<void>;
}
```

When `runtimeLockPath` is present, the runtime prevents a second local process from owning that store. The lock does not coordinate processes on different machines.

### `memoryStore(initial?)`

```ts
declare function memoryStore(initial?: Partial<OrchestratorState>): Store;
```

Creates an isolated in-memory store. Reads and writes clone values.

### `jsonFileStore(path)` and `fileStore(path)`

```ts
declare function jsonFileStore(filePath: string): Store;
const fileStore = jsonFileStore;
```

Creates and validates a JSON state file. Each write uses a temporary file and rename. Initial file creation and runtime locking require a local filesystem with atomic hard-link support.

Only one runtime or `runOffline()` scope can change a JSON state file at a time. Unscoped concurrent writers are not supported.

Saved event, session, note, and cursor values must be JSON-safe. The state file is plaintext and is not automatically redacted.

### State validation

```ts
const CURRENT_STATE_VERSION = 3;
const MINIMUM_STATE_VERSION = 1;

declare function validateAndMigrateState(
  value: unknown,
  source?: string,
): OrchestratorState;

declare class StateValidationError extends Error {
  readonly code: StateValidationErrorCode;
}

type StateValidationErrorCode =
  | "invalid-json"
  | "invalid-state"
  | "unsupported-version";
```

Valid version 1 and 2 state is migrated in memory to version 3. Inspection does not rewrite the file. The next successful write saves version 3.

### Saved records

```ts
interface OrchestratorState {
  version: 3;
  sessions: StoredSession[];
  events: StoredEvent[];
  deliveries: StoredDelivery[];
  notes: SessionNote[];
  cursors: Record<string, Record<string, unknown>>;
}
```

`StoredSession` contains ID, key, status, state, and creation, update, and end timestamps. Status is `active`, `ended`, `failed`, or `paused`.

`StoredEvent` contains internal `id`, source `sourceId`, channel ID, dedupe and session keys, body fields, and occurrence and receive timestamps.

`StoredDelivery` contains event, client, and handler IDs; status; attempt counts; retry delay; next time it can run; last error; and session ID. Status is `pending`, `processing`, `processed`, or `failed`.

`SessionNote` contains its ID, session ID, message, optional data, and creation time.

## Runtime API

Import runtime APIs from `simple-agent-orchestrator/runtime`.

### Runtime exports

| Values | Types |
| --- | --- |
| `OrchestratorRuntime`, `createRuntime`, `createProjectContext`, `findConfigFile`, `findProjectRoot`, `loadConfigFile`, `loadProjectConfig`, `loadProjectOrchestrator` | `RuntimeOptions`, `StartOptions`, `OfflineOperationContext`, `StatePruneBlockedSessionReason`, `StatePruneOptions`, `StatePrunePlan`, `CreateRuntimeOptions`, `LoadProjectOptions` |

### `createRuntime(config, options?)`

Creates an uninitialized runtime.

```ts
declare function createRuntime(
  factory: ConfigFactory,
  options?: CreateRuntimeOptions,
): Promise<OrchestratorRuntime>;
```

Options accept either `project` or the project discovery fields `cwd` and `root`. If config omits `store`, `createRuntime` uses `jsonFileStore(project.statePath("state.json"))`.

### `new OrchestratorRuntime(options)`

Constructs a runtime from a project context and resolved config.

```ts
interface RuntimeOptions {
  project: ProjectContext;
  config: OrchestratorConfig;
}

const runtime = new OrchestratorRuntime({ project, config });
await runtime.init();
```

If config omits `store`, the constructor uses `memoryStore()`. `createRuntime` uses the project JSON store instead.

### Start and stop a runtime

```ts
interface StartOptions {
  drain?: boolean;
  prettyStartupLog?: boolean;
  http?: boolean;
}

await runtime.init();
await runtime.start(options);
await runtime.drain();
await runtime.stop();
```

- `init()` validates and snapshots config, initializes the store, and binds channels.
- `start()` mounts environments, starts HTTP, pollers, and workers, and holds the store lock until `stop()`.
- `start({ drain: true })` polls once, processes work that can run now, stops, and releases the store lock.
- `drain()` processes work that can run now without starting HTTP or unmounting environments. Call `stop()` afterward.
- `stop()` stops new HTTP requests and closes idle connections, waits for accepted requests and active work, unmounts environments, and releases the store lock.

A runtime is one-shot. Create a new instance after stop or failed startup. Sequential `drain()` calls are supported; overlapping calls reject. Drains do not wait for future retry times.

Startup and drain return saved `processing` deliveries to `pending`. The interrupted attempt remains counted; if it exhausted the retry limit, recovery grants one replacement attempt.

### Runtime dispatch and inspection

```ts
declare class OrchestratorRuntime {
  readonly project: ProjectContext;
  dispatch(
    channel: ChannelDefinition | string,
    event: DispatchEvent,
  ): Promise<DispatchResult>;
  listSessions(): Promise<StoredSession[]>;
  getSession(idOrKey: string): Promise<StoredSession | undefined>;
  listSessionNotes(idOrKey: string): Promise<SessionNote[]>;
  listEvents(): Promise<Array<{
    event: StoredEvent;
    deliveries: StoredDelivery[];
  }>>;
  printConfig(): Promise<Record<string, unknown>>;
}
```

Store-backed inspection works after stop. Mutation methods reject after stop.

### Administrative mutations

```ts
declare class OrchestratorRuntime {
  endSession(idOrKey: string, reason?: string): Promise<boolean>;
  retryDelivery(deliveryId: string): Promise<boolean>;
}
```

`endSession` returns `false` if no session matches. It does not run sandbox cleanup.

`retryDelivery` returns `false` unless the delivery exists with status `failed`. On success, it grants one additional attempt that can run now.

For a JSON-file store, call administrative mutations inside `runOffline()` while no active runtime owns the file.

### `runOffline(operation)`

Runs mutations while holding the store lock, without background workers or HTTP. The one-shot runtime stops when the operation finishes.

```ts
await runtime.runOffline(async ({ dispatch, drain, endSession }) => {
  await dispatch("manual", { id: "one" });
  await drain();
  await endSession("demo", "operator");
});
```

```ts
interface OfflineOperationContext {
  dispatch(
    channel: ChannelDefinition | string,
    event: DispatchEvent,
  ): Promise<DispatchResult>;
  drain(): Promise<void>;
  endSession(idOrKey: string, reason?: string): Promise<boolean>;
  retryDelivery(deliveryId: string): Promise<boolean>;
  pruneState(options: StatePruneOptions): Promise<StatePrunePlan>;
}
```

The runtime waits for every context operation started before callback settlement, including unreturned promises. Context calls started after callback settlement reject.

### State retention

```ts
interface StatePruneOptions {
  before: Date | string;
  dropDedupe?: boolean;
}

declare class OrchestratorRuntime {
  previewStatePrune(options: StatePruneOptions): Promise<StatePrunePlan>;
  pruneState(options: StatePruneOptions): Promise<StatePrunePlan>;
}
```

Pruning selects processed deliveries strictly older than `before`. It selects old ended sessions and notes only when no retained delivery or active sandbox refers to them.

Events remain as dedupe records unless `dropDedupe` is `true`. Removing an event allows the same channel ID and dedupe key to be accepted again.

`StatePrunePlan` reports selected delivery, session, note, and event IDs; dedupe-protected events; and sessions blocked by `active-sandbox` or `retained-delivery`.

For persistent stores, call `pruneState` inside `runOffline`. Preview and back up the state before applying the plan.

## Project loading

### `ProjectContext`

```ts
interface ProjectContext {
  root: string;
  orchestratorDir: string;
  packageJson: Record<string, unknown>;
  resolve(...parts: string[]): string;
  fromRoot(...parts: string[]): string;
  fromOrchestrator(...parts: string[]): string;
  statePath(...parts: string[]): string;
  cachePath(...parts: string[]): string;
}
```

### Discovery and loading functions

```ts
declare function findProjectRoot(options?: {
  cwd?: string;
  root?: string;
  config?: string;
}): Promise<string>;

declare function createProjectContext(root: string): Promise<ProjectContext>;

declare function findConfigFile(
  project: ProjectContext,
  explicitConfig?: string,
): Promise<string>;

declare function loadConfigFile(
  configFile: string,
  project: ProjectContext,
): Promise<OrchestratorConfig>;

declare function loadProjectConfig(options?: LoadProjectOptions): Promise<{
  project: ProjectContext;
  configFile: string;
  config: OrchestratorConfig;
}>;

declare function loadProjectOrchestrator(options?: LoadProjectOptions): Promise<{
  project: ProjectContext;
  configFile: string;
  runtime: OrchestratorRuntime;
}>;
```

`LoadProjectOptions` accepts `cwd`, `root`, and `config`.

Config search checks `.simple-agent-orchestrator/orchestrator.ts`, `.mts`, `.cts`, `.js`, `.mjs`, and `.cjs`, in that order. If none exists, it checks `simpleAgentOrchestrator.config` in `package.json`. TypeScript config runs through `tsx` without type-checking.

Config loading temporarily sets `process.cwd()` to the project root. Do not concurrently load configs for different roots if their code reads the working directory.

## Testing API

Import test APIs from `simple-agent-orchestrator/testing`.

### Testing exports

```ts
import {
  createTestRuntime,
  memoryStore,
  type TestEventRecord,
  type TestRuntime,
  type TestRuntimeOptions,
} from "simple-agent-orchestrator/testing";
```

### `createTestRuntime(config, options?)`

Creates an initialized runtime with isolated in-memory state. It does not start pollers, workers, or HTTP.

```ts
declare function createTestRuntime(
  factory: ConfigFactory,
  options?: TestRuntimeOptions,
): Promise<TestRuntime>;
```

Options accept either `root` or `project`, plus `store`, `logger`, and `http` overrides. Defaults are a new memory store, silent logger, and disabled HTTP; these override config values.

### `TestRuntime`

```ts
interface TestRuntime {
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

  sessions: {
    list(): Promise<StoredSession[]>;
    get(idOrKey: string): Promise<StoredSession | undefined>;
    notes(idOrKey: string): Promise<SessionNote[]>;
  };

  events: {
    list(): Promise<TestEventRecord[]>;
    get(eventId: string): Promise<TestEventRecord | undefined>;
  };

  deliveries: {
    list(): Promise<StoredDelivery[]>;
    get(id: string): Promise<StoredDelivery | undefined>;
    retry(id: string, options?: { drain?: boolean }): Promise<boolean>;
  };
}
```

`dispatch` and `deliveries.retry` call `drain()` by default. Pass `{ drain: false }` to leave work pending.

`events.get` accepts the internal event ID. `TestEventRecord` is `{ event: StoredEvent, deliveries: StoredDelivery[] }`; the dispatched source ID is `event.sourceId`.

Mutating helpers reject after stop. Store-backed inspection remains available.
