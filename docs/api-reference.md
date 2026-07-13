# API reference

The package requires Node.js 20 or newer and is ESM-only.

| Import path | Use it for |
| --- | --- |
| `simple-agent-orchestrator` | Config, channels, clients, sessions, environments, stores, keys, and utilities |
| `simple-agent-orchestrator/runtime` | Runtime creation and lifecycle, project loading, inspection, and maintenance |
| `simple-agent-orchestrator/node` | Shell-free detached child-process lifecycle helpers for Node.js |
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
- [Node process helper](#node-process-helper)
- [Testing API](#testing-api)

## Quick API links

| Area | APIs |
| --- | --- |
| Config | [`defineConfig`](#defineconfigfactory), [`OrchestratorConfig`](#orchestratorconfig), [`RetryOptions`](#retryoptions), [`HttpConfig`](#httpconfig) |
| Channels | [`createChannel`](#createchannelid-setup), [`createManualChannel`](#createmanualchannelid), [`channel.poll`](#channelpolldefinition), [`Cursor`](#cursor) |
| Events | [`DispatchEvent`](#dispatchevent), [`DispatchResult`](#dispatchresult), [dispatch methods](#dispatch-methods) |
| Clients | [`createClient`](#createclientid-setup), [`ClientBuilder`](#clientbuilder), [`client.handle`](#clienthandlechannel-options), [`client.onExhausted`](#clientonexhaustedoptions), [`HandlerContext`](#handlercontext), [`HandlerTimeoutError`](#handlertimeouterror) |
| Sessions and resources | [`Session`](#session), [`createEnvironment`](#createenvironmentid-setup), [`createSandbox`](#createsandboxdefinition), [`EnvironmentInstance`](#environmentinstance), [`HandlerSandboxAccessor`](#handlersandboxaccessor), [`SandboxDefinition`](#sandboxdefinition), [`listSandboxes`](#runtime-dispatch-and-inspection), [`completeSession`](#administrative-mutations) |
| Keys and utilities | [Typed state keys](#sessionkey-envkey-and-cursorkey), [`defineKey`](#definekeynamespace-options), [`parseDuration`](#parsedurationvalue), [`env`](#env) |
| Stores | [`Store`](#store), [`memoryStore`](#memorystoreinitial), [`jsonFileStore`](#jsonfilestorepath-and-filestorepath), [state validation](#state-validation), [saved records](#saved-records) |
| Runtime | [`createRuntime`](#createruntimeconfig-options), [`OrchestratorRuntime`](#new-orchestratorruntimeoptions), [start and stop](#start-and-stop-a-runtime), [`runOffline`](#runofflineoperation), [state retention](#state-retention) |
| Node process | [`spawnManagedProcess`](#spawnmanagedprocesscommand-args-options), [`adoptManagedProcess`](#adoptmanagedprocesspid-options) |
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
| `createSandbox` | Defines a typed, JSON-safe session sandbox resource. |
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
| Clients | `CapacityOptions`, `ClientBuilder`, `ClientDefinition`, `EventHandler`, `ExhaustionContext`, `ExhaustionOptions`, `HandlerCapacity`, `HandlerContext`, `HandlerSandboxAccessor`, `HandleOptions` |
| Environments | `EnvironmentBuilder`, `EnvironmentDefinition`, `EnvironmentHookContext`, `EnvironmentInstance`, `ResourceSandboxDefinition`, `SandboxCleanup`, `SandboxCleanupStepContext`, `SandboxCleanupStepDisposition`, `SandboxCleanupStepOptions`, `SandboxCompletionContext`, `SandboxContext`, `SandboxDefinition`, `SandboxDeliveryContext`, `SandboxDisposition`, `SandboxResourceCleanupContext`, `SandboxResourceCreateContext`, `SandboxResourceReconcileContext` |
| Events and state | `ConcurrencyOptions`, `DeliveryIgnoredReason`, `DeliveryPhase`, `DeliveryStatus`, `FailureStage`, `DispatchEvent`, `DispatchResult`, `JsonRecord`, `JsonValue`, `OrchestratorEvent`, `OrchestratorState`, `ProjectContext`, `RetryOptions`, `SandboxCleanupStepStatus`, `SandboxStatus`, `SessionNote`, `StoredCapacityReservation`, `StoredDelivery`, `StoredDeliveryEffects`, `StoredEvent`, `StoredExhaustion`, `StoredFailureDescriptor`, `StoredSandbox`, `StoredSandboxCleanupStep`, `StoredSession`, `WorkStatus` |
| Keys and logging | `KeyBuilder`, `KeyLike`, `Logger`, `StateKey` |
| Sessions | `ReadonlySession`, `Session`, `SessionEndOptions` |
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
| `store` | Depends on the construction API | Store for events, deliveries, sessions, capacity reservations, notes, and cursors. |
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
  ) => Promise<DispatchEvent | readonly DispatchEvent[] | null | undefined>
    | DispatchEvent
    | readonly DispatchEvent[]
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
  pollStartedAt: string;
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

A poll captures `pollStartedAt` immediately before `fetch` as an ISO timestamp and passes that same value to `fetch`, every `map` call, and `commit`. It maps each item sequentially; `map` may return one event, a readonly array of events, or `null`/`undefined` to skip the item. Arrays are flattened and dispatched sequentially in return order. `commit.events` contains that flattened event order.

After dispatch, the poll runs `commit` and then saves cursor changes. On failure, cursor changes are discarded; events already saved remain in the store, including earlier events from a fan-out array.

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
  capacity(options: CapacityOptions): void;
  concurrency(options: ConcurrencyOptions): void;
  retries(options: RetryOptions): void;
  timeout(value: number | string): void;
  onExhausted(options: ExhaustionOptions): void;
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
  readonly session?: "existing-only";
  readonly retries?: RetryOptions;
  readonly timeout?: number | string;
  readonly handle: EventHandler<TPayload, TInput, TMeta>;
  readonly onSuccess?: EventHandler<TPayload, TInput, TMeta>;
  readonly onFailure?: (
    context: HandlerContext<TPayload, TInput, TMeta> & { error: unknown; stage: FailureStage },
  ) => Promise<void> | void;
}
```

Default handler IDs use `${clientId}:${channelId}:${registrationIndex}` with a one-based index. Handler IDs must be unique within a client.

`session: "existing-only"` binds the delivery to the exact active session ID during dispatch. With no active session, dispatch persists terminal status `ignored` and reason `session-missing`. If the bound session is not active at a later claim, the delivery becomes `ignored` with reason `session-ended`; it does not bind a newer session with the same key or run another phase. Work ignored before its first claim has zero attempts. An automatic retry ignored after the session ends keeps its prior attempt count, failure details, and staged but uncommitted effects. Manual retry clears the prior failure fields before the next claim. Ignoring the delivery does not create a session, capacity reservation, or sandbox, or invoke another handler hook. There is no `onIgnored` hook.

The saved delivery `phase` names the next operation: `sandbox`, `handling`, `acknowledging`, `cleaning`, or `persisting`. A claim consumes one delivery attempt and resumes that phase. Successful phases are not repeated after a later phase fails. The runtime stages ordinary session changes, notes, session-end intent, and capacity-release intent on the delivery after `handle` and `onSuccess`; staged values are reconstructed for later phases but are not visible as committed session state. `completed` is the terminal phase.

An error after context creation calls `onFailure` with the failed `stage`. Errors from `onFailure` are logged and do not replace the attempt error.

Processing is retryable, not exactly once. The currently running phase can repeat after an interruption because an outside effect and its local checkpoint are not one transaction. Keep external effects idempotent.

### `client.onExhausted(options)`

```ts
interface ExhaustionOptions {
  readonly retries?: RetryOptions;
  readonly timeout?: number | string;
  readonly handle: (context: ExhaustionContext) => Promise<void> | void;
}
```

Registers at most one client-level handler. When a primary delivery uses its final attempt in any phase, the runtime atomically creates one independent durable exhaustion record. Its context contains `event`, `sourceDelivery`, optional `session`, `stage`, sanitized `failure`, `attempt`, `signal`, `project`, `logger`, `environment`, and `client`. The runtime mounts the client environment but does not create or ensure a sandbox. Exhaustion failures use their own fixed retry budget and never create another exhaustion record. Exhaustion options do not inherit handler, client, or config retry and timeout settings; they default to three attempts, zero delay, and no timeout.

`ExhaustionContext.session` is a `ReadonlySession`: it exposes identity plus `get`, `getOptional`, and `has`, but no mutation methods. Exhaustion work does not commit session mutations.

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
  capacity: HandlerCapacity;
  sandbox: HandlerSandboxAccessor;
}

interface HandlerCapacity {
  readonly reserved: boolean;
  release(): void;
}
```

`environment`, `signal`, `capacity`, and `sandbox` are always present. Without a configured environment, the client receives an empty environment with ID `default`. `capacity.reserved` is `true` when this client already has a retained reservation for the session. Calling `release()` without a configured capacity limit throws.

### `HandlerSandboxAccessor`

```ts
interface HandlerSandboxAccessor {
  get<TResource extends JsonValue>(
    definition: ResourceSandboxDefinition<TResource>,
  ): Readonly<TResource>;
  getOptional<TResource extends JsonValue>(
    definition: ResourceSandboxDefinition<TResource>,
  ): Readonly<TResource> | undefined;
}
```

Both methods require the exact `createSandbox(...)` definition object configured by this client's environment. Passing an equivalent but different definition, or a definition configured for another client, throws. `get` also throws unless that sandbox has an active saved resource. `getOptional` returns `undefined` when there is no active resource, including a migrated active record that predates typed resources. During a resumed `cleaning` phase, the failure hook can still read the retained resource for diagnostics.

Normal handlers receive the resource after the runtime has created or reconciled the sandbox. A handler with `session: "existing-only"` gets an existing-state-only view before handling: the accessor may read an already-active resource, but dispatch does not create a record or run `create` or `reconcile`. If that handler explicitly ends the session, the later cleanup phase may reconcile uncertain saved state before cleanup.

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

### `client.capacity(options)`

```ts
interface CapacityOptions {
  maxActiveSessions: number;
}
```

Capacity is disabled by default. `maxActiveSessions` must be a positive integer.

For a configured client, the first claim for an active session saves one capacity reservation before the handler runs. Later deliveries for that client and session reuse it. When the limit is full, new-session deliveries remain `pending` with no attempt consumed; drains return without waiting for a release.

Reservations survive handler completion, failure, timeout, shutdown, and restart. `context.capacity.release()` removes the current client's reservation only after the attempt succeeds. `session.end()` removes all reservations for that session after the attempt succeeds. Capacity is client-scoped and does not coordinate separate runtime processes.

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
interface ReadonlySession {
  readonly id: string;
  readonly key: string;
  readonly status: StoredSession["status"];

  get<T = unknown>(key: KeyLike<T>): T;
  getOptional<T = unknown>(key: KeyLike<T>): T | undefined;
  has(key: KeyLike): boolean;
}

interface Session extends ReadonlySession {
  set<T = unknown>(key: KeyLike<T>, value: T): void;
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
  useSandbox<TResource extends JsonValue>(
    sandbox: ResourceSandboxDefinition<TResource>,
  ): void;
}
```

A later `useSandbox` call replaces the previous sandbox definition. Keep the configured `ResourceSandboxDefinition` object and pass that same object to `HandlerContext.sandbox`; definition identity is part of the lookup contract.

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

### `createSandbox(definition)`

Defines a sandbox with a typed, JSON-safe resource and returns the same definition object.

```ts
declare function createSandbox<TResource extends JsonValue>(
  definition: ResourceSandboxDefinition<TResource>,
): ResourceSandboxDefinition<TResource>;

interface ResourceSandboxDefinition<TResource extends JsonValue> {
  readonly create: (
    context: SandboxResourceCreateContext<TResource>,
  ) => Promise<TResource | void> | TResource | void;
  readonly prepare?: (
    context: SandboxResourcePrepareContext<TResource>,
  ) => Promise<TResource | void> | TResource | void;
  readonly reconcile?: (
    context: SandboxResourceReconcileContext<TResource>,
  ) => Promise<SandboxDisposition> | SandboxDisposition;
  readonly cleanup?: (
    context: SandboxResourceCleanupContext<TResource>,
  ) => Promise<void> | void;
}
```

`create` can return the resource, which lets TypeScript infer `TResource`. For an outside create operation with a risky response/checkpoint gap, provide the generic explicitly and call `await context.publishResource(resource)` as soon as the identity is known. That eager publish survives a later error or interruption in `create`. A returned resource is published after `create` resolves. `undefined` means no returned resource; before the sandbox can become `active`, one of these paths must have published a resource. `null` is a valid present resource.

The runtime rejects values that are not JSON-safe. Published and returned values are cloned before storage and access.

```ts
type SandboxResourceCreateContext<TResource extends JsonValue> =
  SandboxDeliveryContext & {
    publishResource(resource: TResource): Promise<void>;
  };

type SandboxResourceReconcileContext<TResource extends JsonValue> =
  SandboxContext & {
    readonly resource?: Readonly<TResource>;
    publishResource(resource: TResource): Promise<void>;
  };

type SandboxResourcePrepareContext<TResource extends JsonValue> =
  SandboxDeliveryContext & {
    readonly resource?: Readonly<TResource>;
    publishResource(resource: TResource): Promise<void>;
  };
```

Resource-aware `reconcile` receives the saved resource when one exists and may publish a recovered resource. Returning `active` without a published resource throws and leaves the prior lifecycle status in place. This rule lets a typed definition safely adopt a version 6 or 7 sandbox record, or an older session's legacy sandbox flag, that predates stored resources.

Optional `prepare` runs under the sandbox lock immediately before `handle` while the delivery is in its sandbox or handling phase. It receives the active resource, may return or eagerly publish a refreshed resource, and must leave a published resource before handling begins. Because handling retries can run it again, every outside effect in `prepare` must be retry-safe or reconcile by durable identity. Existing-only handlers do not create or reconcile sandboxes, but `prepare` runs when their exact session already has an active sandbox record; it is skipped when no record exists.

### `SandboxDefinition`

```ts
interface SandboxDefinition {
  readonly create: (context: SandboxDeliveryContext) => Promise<void> | void;
  readonly reconcile?: (context: SandboxContext) => Promise<SandboxDisposition> | SandboxDisposition;
  readonly cleanup?: (context: SandboxContext) => Promise<void> | void;
}

interface SandboxContextBase extends EnvironmentHookContext {
  session: Session;
  readonly currentStatus: SandboxStatus;
  readonly currentCheckpoint: Readonly<JsonRecord>;
  checkpoint(update: JsonRecord): Promise<void>;
}

interface SandboxDeliveryContext extends SandboxContextBase {
  cause: { type: "delivery" };
  event: DispatchEvent;
}

interface SandboxCompletionContext extends SandboxContextBase {
  cause: { type: "completion"; reason?: string };
  event?: undefined;
}

type SandboxContext = SandboxDeliveryContext | SandboxCompletionContext;
type SandboxDisposition = "active" | "cleaned" | "unknown";
```

Sandbox records are keyed by session ID, client ID, and environment ID. Their status is `creating`, `active`, `cleaning`, `cleaned`, or `unknown`. `checkpoint(update)` merges JSON-safe fields into the record immediately, including when the surrounding hook later fails. `currentCheckpoint` reflects the merged checkpoint for that hook invocation.

`currentStatus` is the saved status at hook entry. For example, first creation receives `creating`, first cleanup receives `cleaning`, and reconciliation sees the uncertain status that caused it to run.

The runtime saves `creating` before `create` and `cleaning` before `cleanup`. For a legacy `SandboxDefinition`, interrupted cleanup requires `reconcile` to inspect the checkpoint and return `active`, `cleaned`, or `unknown`. `active` repeats cleanup, `cleaned` skips it, and `unknown` stops processing. A `cleaning` or `unknown` legacy record without `reconcile` blocks instead of being treated as usable. Hook execution stays outside the store mutex, while status, resource, checkpoint, and cleanup-step writes use it.

After `create` succeeds, its ordinary session changes are also saved immediately. `cleanup` runs after `handle` and `onSuccess` when the handler ends the session. A legacy cleanup error leaves a `cleaning` record that requires sandbox reconciliation before cleanup can continue. Typed resource cleanup instead re-enters `cleanup` directly from `cleaning` when the saved resource is present, so its outside effects must use the durable step API below.

For delivery hooks, `cause.type` is `delivery` and `event` is present. Administrative completion uses `cause.type === "completion"`, includes the optional reason, and omits `event`; narrow on `cause.type` before reading event data in `reconcile` or `cleanup`.

Sandbox locking is limited to one runtime process. `endSession` remains metadata-only. `completeSession` mounts recorded environments and cleans their sandboxes. Stopping the runtime does not clean every active sandbox.

### Typed sandbox cleanup steps

```ts
type SandboxCleanupStepDisposition = "completed" | "incomplete" | "unknown";

type SandboxCleanupStepOptions<TResource extends JsonValue> =
  | { readonly retry: "idempotent"; readonly reconcile?: never }
  | {
      readonly retry?: never;
      readonly reconcile: (
        context: SandboxCleanupStepContext<TResource>,
      ) => Promise<SandboxCleanupStepDisposition> | SandboxCleanupStepDisposition;
    };

interface SandboxCleanup<TResource extends JsonValue> {
  step(
    id: string,
    options: SandboxCleanupStepOptions<TResource>,
    operation: (
      context: SandboxCleanupStepContext<TResource>,
    ) => Promise<void> | void,
  ): Promise<void>;
}

type SandboxResourceCleanupContext<TResource extends JsonValue> =
  SandboxContext & {
    readonly resource: Readonly<TResource>;
    readonly cleanup: SandboxCleanup<TResource>;
  };

type SandboxCleanupStepContext<TResource extends JsonValue> =
  | (Omit<SandboxDeliveryContext, "session"> & {
      readonly session: ReadonlySession;
      readonly resource: Readonly<TResource>;
    })
  | (Omit<SandboxCompletionContext, "session"> & {
      readonly session: ReadonlySession;
      readonly resource: Readonly<TResource>;
    });
```

Each step ID must be a stable, non-empty string and must choose exactly one policy:

- `{ retry: "idempotent" }` reruns a failed or interrupted operation.
- `{ reconcile }` checks a previously started step. `completed` skips the operation, `incomplete` runs it, and `unknown` records uncertainty and throws.

The operation and reconciler receive the sandbox environment, project, logger, signal, cause, optional delivery event, `currentStatus`, `currentCheckpoint`, checkpoint writer, readonly session, and readonly resource. The readonly session has `id`, `key`, `status`, `get`, `getOptional`, and `has`; cleanup steps cannot mutate session state.

Saved step status is `running`, `completed`, `failed`, or `unknown`. The record also stores attempts and timestamps, plus `lastError` for failed or unknown work. A completed ID is skipped when the cleanup hook runs again.

Await steps in order when one depends on another. Independent operations can start together with `Promise.allSettled`, but the cleanup hook must inspect the results and throw if any rejected. Steps with the same ID are serialized inside one runtime process.

**Put every outside cleanup effect inside `cleanup.step(...)`.** Typed cleanup is deliberately re-entered from a saved `cleaning` record without first running sandbox-level reconciliation. Any API call, process signal, file deletion, or other outside effect before, after, or between steps can repeat without its own durable checkpoint.

The signal is checked before reconciliation, before starting an operation, and after reconciliation. Once an operation starts, cancellation remains cooperative. When awaited sequentially, an abort prevents the next step from starting after the current operation settles. Cleanup steps reduce uncertainty around cleanup only; they are not exactly-once operations or a general workflow engine.

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
const CURRENT_STATE_VERSION = 8;
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

Valid versions 1 through 7 migrate deterministically to version 8. Version 8 adds the optional stored sandbox resource and a cleanup-step map; older sandbox records migrate with an empty `cleanupSteps` object and no resource. A typed definition must reconcile an active older record and publish its resource before the runtime exposes it to a handler or starts typed cleanup.

Earlier migrations still apply. Version 7 added delivery phases, staged effects, and the exhaustion collection. Unfinished older deliveries resume conservatively at `sandbox`; processed and ignored deliveries migrate to `completed`. Legacy `__sao.sandbox.*.created` flags remain unchanged because the snapshot does not identify their client owner. Migration happens in memory, inspection does not rewrite the file, and the next successful write saves version 8.

### Saved records

```ts
interface OrchestratorState {
  version: 8;
  sessions: StoredSession[];
  events: StoredEvent[];
  deliveries: StoredDelivery[];
  exhaustions: StoredExhaustion[];
  capacityReservations: StoredCapacityReservation[];
  sandboxes: StoredSandbox[];
  notes: SessionNote[];
  cursors: Record<string, Record<string, unknown>>;
}
```

`StoredSession` contains ID, key, status, state, and creation, update, and end timestamps. Status is `active`, `ended`, `failed`, or `paused`.

`StoredEvent` contains internal `id`, source `sourceId`, channel ID, dedupe and session keys, body fields, and occurrence and receive timestamps.

`StoredDelivery` contains event, client, and handler IDs; status; attempt counts; retry delay; next time it can run; phase; last failure stage; optional staged effects; last error; session ID; and an optional ignored reason. Status is `pending`, `processing`, `processed`, `failed`, or `ignored`. Ignored reason is `session-missing` or `session-ended`.

`StoredExhaustion` references its source delivery, event, client, optional session, failed stage, and a sanitized failure descriptor. It is independent historical work with its own `pending`, `processing`, `processed`, or `failed` status, attempts, fixed delay, and timestamps. Manually retrying the source delivery does not remove the exhaustion record or require the source to remain failed. The descriptor stores a bounded error name and generic message, never the raw error or stack.

`StoredCapacityReservation` contains its ID, client ID, session ID, and acquisition time. Only active reservations are stored.

`StoredSandbox` is keyed by session ID, client ID, and environment ID:

```ts
interface StoredSandbox {
  sessionId: string;
  clientId: string;
  environmentId: string;
  status: "creating" | "active" | "cleaning" | "cleaned" | "unknown";
  checkpoint: JsonRecord;
  resource?: JsonValue;
  cleanupSteps: Record<string, StoredSandboxCleanupStep>;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

interface StoredSandboxCleanupStep {
  status: "running" | "completed" | "failed" | "unknown";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  lastError?: string;
}
```

`resource`, checkpoint values, and cleanup-step IDs and records are saved state. Treat them as plaintext. A current `active` typed sandbox has a `resource`; the field remains optional in the public stored type because legacy sandboxes and other lifecycle states may not have one.

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

Startup and drain return saved `processing` deliveries and exhaustion work to `pending`. The interrupted attempt remains counted; if it exhausted the retry limit, recovery grants one replacement attempt. Delivery processing resumes from its saved next phase.

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
  listCapacityReservations(): Promise<StoredCapacityReservation[]>;
  listSandboxes(sessionId?: string): Promise<StoredSandbox[]>;
  listEvents(): Promise<Array<{
    event: StoredEvent;
    deliveries: StoredDelivery[];
    exhaustions: StoredExhaustion[];
  }>>;
  printConfig(): Promise<Record<string, unknown>>;
}
```

Store-backed inspection works after stop. Mutation methods reject after stop.

### Administrative mutations

```ts
declare class OrchestratorRuntime {
  endSession(idOrKey: string, reason?: string): Promise<boolean>;
  completeSession(sessionId: string, reason?: string): Promise<boolean>;
  releaseCapacity(clientId: string, sessionIdOrKey: string): Promise<boolean>;
  retryDelivery(deliveryOrExhaustionId: string): Promise<boolean>;
}
```

`endSession` returns `false` if no session matches. It releases every capacity reservation for the session but does not run sandbox cleanup or stop external work.

`completeSession` requires an exact active session ID and rejects while pending or processing delivery work targets that session or its session key. It mounts each environment named by that session's sandbox records, requires reconciliation for uncertain records, runs cleanup, and only then ends the session and releases all capacity. Failed cleanup leaves the session active and its capacity reserved; call completion again after the integration can reconcile it. Missing cleanup hooks, missing configured owners, unresolved reconciliation, and ambiguous legacy sandbox ownership reject without ending the session.

Successful completion returns `true`. Missing, ended, keyed, or otherwise non-active targets reject because this operation deliberately does not resolve session keys.

`releaseCapacity` removes one client's reservation while keeping the session active. It returns `false` if no matching active reservation exists. It does not stop external work.

`retryDelivery` returns `false` unless a delivery or exhaustion record exists with status `failed`. On success, it grants that record one additional attempt that can run now.

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
  completeSession(sessionId: string, reason?: string): Promise<boolean>;
  releaseCapacity(clientId: string, sessionIdOrKey: string): Promise<boolean>;
  retryDelivery(deliveryOrExhaustionId: string): Promise<boolean>;
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

Pruning selects processed and ignored deliveries strictly older than `before`. A retained exhaustion record protects its source delivery, event, and optional session. Pruning selects old ended sessions and notes only when no retained work or active sandbox refers to them.

Events remain as dedupe records unless `dropDedupe` is `true`. Removing an event allows the same channel ID and dedupe key to be accepted again.

`StatePrunePlan` reports selected delivery, terminal exhaustion, session, note, and event IDs; dedupe-protected events; and sessions blocked by `active-sandbox` or `retained-delivery`.

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

## Node process helper

Import this Node-specific API from `simple-agent-orchestrator/node`. It is independent of runtime deliveries and saved state.

### `spawnManagedProcess(command, args?, options?)`

Starts one detached process without a shell and returns its PID and lifecycle handle.

```ts
import { spawnManagedProcess } from "simple-agent-orchestrator/node";

const agent = spawnManagedProcess(process.execPath, ["agent-server.mjs"], {
  cwd: project.root,
  termGraceMs: 5_000,
  ownsProcess: async (pid) => processRecordStillMatches(pid),
});

await agent.waitUntilReady(() => agentClient.isReady(), {
  signal,
  timeoutMs: 30_000,
});

await agent.stop();
```

`processRecordStillMatches` and `agentClient` are application-provided functions. The helper does not provide ports, HTTP checks, persistence, restart policy, or provider policy.

```ts
declare function spawnManagedProcess(
  command: string,
  args?: readonly string[],
  options?: SpawnManagedProcessOptions,
): ManagedProcess;

interface SpawnManagedProcessOptions {
  cwd?: string | URL;
  env?: Record<string, string | undefined>;
  stdio?: ManagedProcessStdio;
  termGraceMs?: number;
  ownsProcess?: (pid: number) => boolean | Promise<boolean>;
}

interface StopManagedProcessOptions {
  termGraceMs?: number;
}

interface WaitUntilReadyOptions {
  signal?: AbortSignal;
  intervalMs?: number;
  timeoutMs?: number;
}

interface ManagedProcess {
  readonly pid: number;
  readonly exit: Promise<ManagedProcessExit>;
  isAlive(): boolean;
  stop(options?: StopManagedProcessOptions): Promise<ManagedProcessExit>;
  waitUntilReady(
    check: () => boolean | Promise<boolean>,
    options?: WaitUntilReadyOptions,
  ): Promise<void>;
}

interface ManagedProcessExit {
  readonly pid: number;
  readonly code: number | null;
  readonly signal: string | null;
  readonly error?: Error;
}
```

The child uses `shell: false`, detached mode, `unref()`, and `windowsHide: true`. Arguments go directly to the executable. `stdio` defaults to `"ignore"`. You may use `"inherit"` or an array with at least three entries containing `"ignore"`, `"inherit"`, and existing numeric file descriptors. The first three entries configure stdin, stdout, and stderr explicitly. The API does not accept generated pipes, overlapped pipes, IPC channels, or caller-owned stream objects because the detached handle does not expose or manage those channels.

On POSIX, `stop()` signals the detached process group with `SIGTERM`, waits for the configured grace period, and sends `SIGKILL` if the group is still alive. If group signaling reports that no group exists, it defensively falls back to the direct child. On Windows it signals the direct child; it does not claim process-tree cleanup there. Descendants that create another process group are also outside the helper's control.

The TERM grace defaults to 5 seconds. The first `stop()` call fixes the stop options; concurrent and later calls return the same promise. If both the process and its detached group have exited, `stop()` returns its exit result without signaling. `ownsProcess`, when present, runs once before signaling. A successful decision authorizes graceful shutdown and any required escalation, even if the process-group leader exits during the grace period. A false result rejects stop without sending a signal. Use it when your application has stronger ownership data than a PID, because operating systems can reuse PIDs.

`isAlive()` checks the direct PID and treats a permissions error as alive. `waitUntilReady()` checks every 50 ms by default, supports synchronous or asynchronous application checks, rejects with the abort reason, rejects on timeout, and rejects if the child exits first. It has no default timeout.

### `adoptManagedProcess(pid, options)`

Creates a lifecycle handle for a detached process identity recovered from your own saved resource. It does not spawn a child and cannot provide an exit result.

```ts
import { adoptManagedProcess } from "simple-agent-orchestrator/node";

const processHandle = adoptManagedProcess(resource.pid, {
  ownsProcess: async (pid) => processRecordStillMatches(pid, resource.token),
  termGraceMs: 5_000,
});

await processHandle.stop();
```

`processRecordStillMatches` is application-provided. It must verify stronger identity than a numeric PID, such as a token or command identity saved with the sandbox resource.

```ts
declare function adoptManagedProcess(
  pid: number,
  options: AdoptManagedProcessOptions,
): AdoptedManagedProcess;

interface AdoptManagedProcessOptions {
  termGraceMs?: number;
  ownsProcess: (pid: number) => boolean | Promise<boolean>;
}

interface AdoptedManagedProcess {
  readonly pid: number;
  isAlive(): boolean;
  stop(options?: StopManagedProcessOptions): Promise<void>;
  waitUntilReady(
    check: () => boolean | Promise<boolean>,
    options?: WaitUntilReadyOptions,
  ): Promise<void>;
}
```

`pid` must be a safe integer greater than 1 and no greater than `2_147_483_647`. `ownsProcess` is mandatory because the saved PID may have been reused before cleanup resumes.

On POSIX, adoption refers only to process group `-pid`. `isAlive()` and `stop()` never fall back to the positive PID if that group is absent; this avoids signaling an unrelated process that reused the group leader's PID. On Windows, adoption observes and signals the direct PID and does not promise descendant cleanup.

`stop()` checks liveness, verifies ownership, sends `SIGTERM`, and waits for the configured grace period. If the target remains alive, it verifies ownership again immediately before `SIGKILL`. After KILL it waits up to five seconds for the target to disappear and rejects if it remains alive. If the target disappears while ownership is being checked, stop resolves without signaling it.

The first `stop()` call fixes both the promise and its options. Concurrent and later calls return that same promise, including a rejection. The promise resolves with `void`, not `ManagedProcessExit`, because an adopted process has no child-process exit event. `waitUntilReady()` has the same interval, timeout, and abort behavior as the spawned handle, but reports disappearance rather than an exit code.

### Node lifecycle utilities

`simple-agent-orchestrator/node` also exports narrow utilities used around managed processes:

- `createPosixProcessGroupLocator(requiredCommandValues)` locates one POSIX process group whose command contains every exact argument value and provides a rescanning `owns(processGroupId)` check. It throws if multiple groups match and is unavailable on Windows.
- `publishReadyRecord(filePath, record)` writes a private JSON readiness record through an exclusive temporary file and atomic rename. `readReadyRecord(filePath, validate)` returns only records accepted by the caller's type guard.
- `getAvailableLoopbackPort()` asks the operating system for an unused `127.0.0.1` port and releases it before returning. The caller still owns the bind race.
- `isLoopbackHttpUrl(value)` accepts only plain HTTP URLs rooted at `127.0.0.1` with an explicit port and no credentials, path, query, or fragment.

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
    end(idOrKey: string, reason?: string): Promise<boolean>;
    complete(sessionId: string, reason?: string): Promise<boolean>;
  };

  sandboxes: {
    list(sessionId?: string): Promise<StoredSandbox[]>;
  };

  capacity: {
    list(): Promise<StoredCapacityReservation[]>;
    release(
      clientId: string,
      sessionIdOrKey: string,
      options?: { drain?: boolean },
    ): Promise<boolean>;
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

  exhaustions: {
    list(): Promise<StoredExhaustion[]>;
    get(id: string): Promise<StoredExhaustion | undefined>;
    retry(id: string, options?: { drain?: boolean }): Promise<boolean>;
  };
}
```

`dispatch`, `capacity.release`, `deliveries.retry`, and `exhaustions.retry` call `drain()` by default. Pass `{ drain: false }` to leave work pending. `sessions.end` is the metadata-only runtime operation and accepts an ID or key. `sessions.complete` requires an exact active session ID and runs configured sandbox cleanup before ending. `sandboxes.list()` returns all sandbox records; pass a session ID to filter them.

`events.get` accepts the internal event ID. `TestEventRecord` is `{ event: StoredEvent, deliveries: StoredDelivery[], exhaustions: StoredExhaustion[] }`; the dispatched source ID is `event.sourceId`. Use `test.exhaustions.list/get/retry` to inspect or manually retry exhaustion work.

Mutating helpers reject after stop. Store-backed inspection remains available.
