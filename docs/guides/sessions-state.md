# Sessions and state

A session is durable state attached to a `sessionKey`.

If two events have the same `sessionKey`, they resolve to the same active session.

## Basic state

```ts
session.set("agent.sessionId", "agent_123");
const id = session.get<string>("agent.sessionId");
```

You can use typed keys for better TypeScript ergonomics:

```ts
import { sessionKey } from "simple-agent-orchestrator";

const agentSessionId = sessionKey<string>("agent.sessionId");

session.set(agentSessionId, "agent_123");
const id = session.get(agentSessionId);
```

## Optional values

```ts
const id = session.getOptional(agentSessionId);
```

## Idempotent resource creation

Use `session.ensure` when a value should be created once and reused:

```ts
const id = await session.ensure(agentSessionId, async () => {
  const created = await createAgentSession();
  return created.id;
});
```

This is the recommended way to store external agent session ids, worktree ids, or other durable resources.

## Notes

A session can record human-readable notes:

```ts
session.note("Sent review to agent", {
  reviewId: event.payload.id,
});
```

Notes are persisted in the store and are useful for later CLI or UI inspection.

## Ending a session

```ts
await session.end({ reason: "github.pr.merged" });
```

An ended session is kept for history. A future event with the same `sessionKey` creates a new active session.
