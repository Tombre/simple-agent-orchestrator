# Testing

Import the public harness from `simple-agent-orchestrator/testing`:

```ts
import { createChannel, createClient } from "simple-agent-orchestrator";
import { createTestRuntime } from "simple-agent-orchestrator/testing";

const channel = createChannel("test");
const client = createClient("client", (client) => {
  client.handle(channel, ({ session }) => {
    session.set("count", (session.getOptional<number>("count") ?? 0) + 1);
  });
});

const test = await createTestRuntime({
  channels: [channel],
  clients: [client],
});

await test.dispatch(channel, { id: "event-1", sessionKey: "work" });
expect((await test.sessions.get("work"))?.state.count).toBe(1);
await test.stop();
```

## Creation and defaults

```ts
createTestRuntime(config, options?);
```

`config` accepts an `OrchestratorConfig`, synchronous config factory, or asynchronous config factory. The factory receives `{ project }`. Options accept either `root` or a prebuilt `project`, never both, plus optional `store`, `logger`, and `http` overrides.

The harness overrides any config store with a new isolated `memoryStore()`, uses a silent logger, and disables HTTP by default. Explicit test options can replace those defaults. Initialization never starts workers, polls, or HTTP.

## Helpers

- `test.dispatch(channelOrId, event, { drain?: boolean })` persists and drains by default. Set `drain: false` to inspect pending work.
- `test.drain()` processes currently eligible deliveries. It does not wait for future retry times.
- `test.sessions.list()`, `.get(idOrKey)`, and `.notes(idOrKey)` inspect sessions.
- `test.events.list()` and `.get(internalEventId)` return event records shaped as `{ event, deliveries }`.
- `test.deliveries.list()`, `.get(id)`, and `.retry(id, { drain?: boolean })` inspect and retry deliveries. Retry drains by default.
- `test.readState()` returns the configured store's complete snapshot. The default memory store clones it.
- `test.project` and `test.store` expose the selected test resources.
- `test.stop()` cleans up the runtime. Call it in test cleanup; mutations are rejected after stop, while store-backed inspection helpers remain usable.

`test.runtime` is a public escape hatch to the underlying `OrchestratorRuntime` for behavior the focused helpers do not expose. Prefer the helpers for ordinary tests. If delayed eligibility, lifecycle, or concurrency requires direct runtime methods, keep cleanup explicit and deterministic.

Each `TestEventRecord` groups a `StoredEvent` with its matching `StoredDelivery[]`. The nested event's `id` is the internal ID and `sourceId` is the dispatched source ID. Delivery helpers also expose the stored deliveries directly. Use `readState()` when asserting relationships across complete state.

For timeout and concurrency tests, coordinate with fake timers and barriers rather than sleeps. Test failure persistence as well as success: ordinary state and notes roll back, while completed `session.ensure` values and sandbox creation bookkeeping remain eager.
