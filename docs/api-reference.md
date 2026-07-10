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
```

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
  retries: { attempts: 5 },
  async handle(ctx) {},
  async onSuccess(ctx) {},
  async onFailure({ error }) {},
});
```

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

Ordinary state changes and notes are committed when the delivery succeeds. Values created through `session.ensure` are persisted eagerly so retries reuse them.

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

The sandbox is created once per active session and reused across retries. Cleanup runs after a successful handler-driven `session.end()`. This guarantee is process-local; external create and cleanup functions should be idempotent.

## Stores

### `memoryStore(initial?)`

In-memory store for tests and examples.

### `jsonFileStore(path)` / `fileStore(path)`

Persistent JSON-file store.

```ts
jsonFileStore(project.statePath("state.json"));
```

The store interface is:

```ts
type Store = {
  name: string;
  init(): Promise<void>;
  read(): Promise<OrchestratorState>;
  write(state: OrchestratorState): Promise<void>;
};
```

## Runtime API

Import from `simple-agent-orchestrator/runtime`.

```ts
import { loadProjectOrchestrator } from "simple-agent-orchestrator/runtime";

const { runtime } = await loadProjectOrchestrator({ root: process.cwd() });
await runtime.start();
```

Useful methods:

```ts
await runtime.dispatch(channelId, event);
await runtime.drain();
await runtime.stop();
await runtime.listSessions();
await runtime.getSession(idOrKey);
await runtime.listSessionNotes(idOrKey);
await runtime.endSession(idOrKey, reason);
await runtime.listEvents();
await runtime.retryDelivery(deliveryId);
await runtime.printConfig();
```

## Testing API

Import from `simple-agent-orchestrator/testing`.

```ts
import { createTestRuntime } from "simple-agent-orchestrator/testing";

const test = await createTestRuntime({ config });
await test.dispatch("manual", { id: "1", sessionKey: "demo", input: "hello" });
const session = await test.sessions.get("demo");
const notes = await test.sessions.notes("demo");
```
