# Test your integration

You can test your real channels and handlers without starting a server or writing a state file. The test harness creates an initialized runtime with isolated in-memory state, then gives you small helpers for sending an event, running its handlers, and checking the result.

This guide builds a test for a client that counts messages in one session.

## Write a successful delivery test

Start with the same channel and client definitions your application uses. `test.dispatch(...)` sends the event and, by default, immediately processes all work that can run now.

```ts
import { afterEach, describe, expect, it } from "vitest";
import { createClient, createManualChannel } from "simple-agent-orchestrator";
import {
  createTestRuntime,
  type TestRuntime,
} from "simple-agent-orchestrator/testing";

describe("message client", () => {
  let test: TestRuntime | undefined;

  afterEach(async () => {
    await test?.stop();
  });

  it("counts messages in one session", async () => {
    const channel = createManualChannel("messages");
    const client = createClient("counter", (client) => {
      client.handle(channel, ({ session }) => {
        const count = session.getOptional<number>("count") ?? 0;
        session.set("count", count + 1);
      });
    });

    test = await createTestRuntime({
      clients: [client],
    });

    await test.dispatch(channel, { id: "one", sessionKey: "demo" });
    await test.dispatch(channel, { id: "two", sessionKey: "demo" });

    const session = await test.sessions.get("demo");
    expect(session?.state.count).toBe(2);
  });
});
```

The expected outcome is one session with `count: 2`. Both events use `sessionKey: "demo"`, so the second handler sees the value saved by the first.

Always stop the harness after a test. That runs environment cleanup and leaves the runtime in a known state. An `afterEach` hook is a convenient safety net when an assertion fails.

## Pause before processing

Sometimes you want to inspect what dispatch created before the handler runs. Pass `{ drain: false }`:

```ts
const result = await test.dispatch(
  channel,
  { id: "queued-1" },
  { drain: false },
);

const record = await test.events.get(result.eventId);
expect(record?.deliveries[0]?.status).toBe("pending");

await test.drain();

const processed = await test.events.get(result.eventId);
expect(processed?.deliveries[0]?.status).toBe("processed");
```

`result.eventId` is the orchestrator's internal event ID. The ID you supplied is available as `record.event.sourceId`.

`test.drain()` processes work whose retry time has arrived. It doesn't wait for a future retry delay, which keeps tests quick and predictable.

## Prove failed changes are rolled back

A useful failure test checks both kinds of session values: normal changes are discarded when an attempt fails, while a completed `session.ensure(...)` value is kept so another attempt can reuse an external resource.

```ts
const client = createClient("failing", (client) => {
  client.handle(channel, {
    retries: { attempts: 1 },
    async handle({ session }) {
      session.set("ordinary", "discarded");
      await session.ensure("resourceId", () => "resource-123");
      throw new Error("provider unavailable");
    },
  });
});

test = await createTestRuntime({ clients: [client] });
await test.dispatch(channel, { id: "failure", sessionKey: "demo" });

const session = await test.sessions.get("demo");
expect(session?.state.ordinary).toBeUndefined();
expect(session?.state.resourceId).toBe("resource-123");

const [delivery] = await test.deliveries.list();
expect(delivery?.status).toBe("failed");
expect(delivery?.attempts).toBe(1);
```

This is worth testing whenever a handler creates something outside the orchestrator. The `ensure` factory itself can still finish just before the process stops and before its result is recorded, so the factory should use a stable external ID and be safe to call again.

## Retry a failed delivery

Use the delivery ID, not the event ID:

```ts
const [delivery] = await test.deliveries.list();
if (!delivery) throw new Error("Expected a delivery");

const retried = await test.deliveries.retry(delivery.id);
expect(retried).toBe(true);
```

Retry gives a failed delivery one additional attempt and runs ready work by default. Pass `{ drain: false }` if you want to assert that it returned to `pending` first. The helper returns `false` when the delivery doesn't exist or isn't failed.

## Pick the smallest helper

| What you want to do | Helper |
| --- | --- |
| Send an event and usually process it | `test.dispatch(...)` |
| Process work that can run now | `test.drain()` |
| List or inspect sessions | `test.sessions.list/get` |
| Read a session's notes | `test.sessions.notes(...)` |
| Inspect events together with their deliveries | `test.events.list/get` |
| Inspect or retry individual deliveries | `test.deliveries.list/get/retry` |
| Read the complete in-memory state | `test.readState()` |
| Use the selected project or store | `test.project` and `test.store` |
| Call lower-level runtime methods | `test.runtime` |
| Clean up environments and stop the runtime | `test.stop()` |

Prefer these helpers over reaching into `test.runtime`. For concurrency, cancellation, or timeout tests, coordinate code with deferred promises, barriers, or fake timers rather than sleeps. That lets the test control exactly when work continues.

## Know the test defaults

`createTestRuntime(config, options?)` accepts a config object or a synchronous or asynchronous config factory. It is initialized before being returned, with these defaults:

- A fresh `memoryStore()` that isn't shared with any other test.
- A silent logger.
- HTTP disabled.
- No background workers or polls. Work runs only when your test calls `dispatch`, `drain`, or a lower-level runtime method.

Options can supply either `root` or a prebuilt `project`, plus a custom `store`, `logger`, or `http` configuration. Supplying both `root` and `project` is an error. A custom HTTP configuration doesn't start a listener by itself; the harness still only initializes the runtime.

In-memory state is cloned on reads and writes, so changing an object returned by `readState()` won't silently alter the stored copy.

After `test.stop()`, helpers that send, drain, or retry work reject. Helpers that read through the store remain available when you need a final assertion.

## Next steps

- [Look up every test helper](../api-reference.md#testing-api).
- [See what happens when an attempt fails](failure-semantics.md).
