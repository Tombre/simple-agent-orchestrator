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

The test runtime uses the memory store and drains currently eligible deliveries after dispatch. It does not wait for a configured future retry time; inspect `nextAttemptAt`, advance the stored/test clock as appropriate, and call `test.runtime.drain()` again when testing delayed retries.

For handler timeouts, use fake timers and a barrier that confirms the handler or sandbox hook started before advancing the deadline. Have the test operation settle when its `signal` aborts; the runtime deliberately continues awaiting code that ignores cooperative cancellation.

Test failure paths as well as successful persistence. In particular, verify that ordinary state and notes from a failed attempt disappear, ensured values remain, and repeated external calls receive the same idempotency key. A dedupe test alone does not prove external processing is exactly once.

Prefer behavior-focused TDD: write a failing test through public channels, clients, and runtime methods, then make the smallest implementation change that passes it. Use direct `OrchestratorRuntime` instances with deterministic barriers for worker concurrency and lifecycle tests; do not depend on arbitrary sleeps.

The repository verification commands are:

```bash
npm test
npm run typecheck
npm run build
```
