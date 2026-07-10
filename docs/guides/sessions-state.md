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

## Eager resource identifiers

Use `session.ensure` when retries and concurrent deliveries should reuse a persisted value:

```ts
const id = await session.ensure(agentSessionId, async () => {
  const created = await createAgentSession({
    idempotencyKey: `agent-session:${session.id}`,
  });
  return created.id;
});
```

The returned value is persisted eagerly and survives a later failed attempt. The external creation and local write are not one transaction, so the factory can run again after an uncertain process or store failure. Make the factory retry-safe with provider idempotency or lookup-and-reconcile behavior.

Ordinary `set`, `delete`, `note`, and `end` changes made by handlers or hooks persist only after the entire attempt succeeds. They are discarded when `handle`, `onSuccess`, cleanup, or final persistence fails. State mutations made during sandbox creation are a separate eager-persistence path.

Values persisted in session state, notes, events, and cursors must be JSON-safe and no more than 100 levels deep when using `jsonFileStore`. Unsupported values such as `undefined`, `NaN`, infinities, class instances, and circular objects fail validation instead of being silently changed by JSON serialization.

## Notes

A session can record human-readable notes:

```ts
session.note("Sent review to agent", {
  reviewId: event.payload.id,
});
```

Notes from successful attempts are persisted in the store and are useful for later CLI or UI inspection. Notes from failed attempts are discarded.

```bash
npx simple-agent-orchestrator sessions show <id-or-key>
```

Programmatic callers can use `runtime.listSessionNotes(idOrKey)`.

## Ending a session

```ts
session.end({ reason: "github.pr.merged" });
```

An ended session is kept for history. A future event with the same `sessionKey` creates a new active session.

Explicit state pruning can remove an old ended session and its notes only when no retained delivery references it and no active sandbox marker remains. Active, paused, and failed sessions are preserved. Preview `state prune --before <timestamp>` before applying it; a pruned historical session is no longer available through session inspection.
