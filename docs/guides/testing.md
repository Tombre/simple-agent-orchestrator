# Testing

The package includes a small test harness.

```ts
import { createChannel, createClient, sessionKey } from "simple-agent-orchestrator";
import { createTestRuntime } from "simple-agent-orchestrator/testing";

const channel = createChannel("test");
const countKey = sessionKey<number>("count");

const client = createClient("client", (client) => {
  client.handle(channel, async ({ session }) => {
    session.set(countKey, (session.getOptional(countKey) ?? 0) + 1);
  });
});

const test = await createTestRuntime({
  config: {
    channels: [channel],
    clients: [client],
  },
});

await test.dispatch("test", {
  id: "event-1",
  sessionKey: "session-1",
  input: "hello",
});

const session = await test.sessions.get("session-1");
expect(session?.state.count).toBe(1);
```

The test runtime uses the memory store and drains deliveries immediately after dispatch.
