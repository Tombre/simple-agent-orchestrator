# Keep context with sessions

You want several events to continue the same task or conversation. Give those events the same `sessionKey`, and they'll reuse one active session: a saved set of values and notes shared by related deliveries. A **delivery** is one handler's saved work record for an event, including its attempts and result. With the project JSON store, both sessions and deliveries remain available after restarts.

For example, all events for one pull request could use:

```ts
sessionKey: `github:${repository}:pr:${pullRequestNumber}`
```

A session isn't created when you dispatch an event. It's created when a normal matching delivery starts processing. A handler configured with `session: "existing-only"` instead binds an active session at dispatch and never creates or rebinds one. If no handler matches, no session is needed or created.

## Remember a value for the next event

Read a value if it exists, then update it:

```ts
const count = session.getOptional<number>("messageCount") ?? 0;
session.set("messageCount", count + 1);
```

Use `get` when a missing value means your code can't continue. It throws if the key isn't present:

```ts
const agentId = session.get<string>("agent.sessionId");
```

You can also check or remove values:

```ts
if (session.has("agent.sessionId")) {
  session.delete("agent.sessionId");
}
```

These ordinary changes are staged on the delivery after `handle` and again after `onSuccess`. They aren't visible as committed session state until acknowledgement, cleanup, and final persistence succeed. A retry reconstructs the session from the staged effects and resumes the failed phase instead of rerunning completed earlier phases.

## Keep key names and TypeScript types together

For values used in several places, create a typed key:

```ts
import { sessionKey } from "simple-agent-orchestrator";

const agentSessionId = sessionKey<string>("agent.sessionId");

session.set(agentSessionId, "agent_123");
const id = session.get(agentSessionId); // string
```

Typed keys don't change how values are stored. They help TypeScript catch a mismatched value while keeping the saved key name explicit.

## Create one value and reuse it on retries

Sometimes creating the value is itself external work. Use `session.ensure` when the first attempt should create an agent session and every later attempt should reuse its ID:

```ts
const id = await session.ensure(agentSessionId, async () => {
  const created = await createAgentSession({
    idempotencyKey: `agent-session:${session.id}`,
  });

  return created.id;
});
```

Inside one runtime process, concurrent calls for the same session and key wait for the same creation work instead of creating separate values. The completed value is saved immediately, so it remains available even if the rest of the handler fails.

This protection doesn't coordinate separate processes. There is also a crash window between the provider creating the external object and the runtime saving its ID. If the process stops in that window, `ensure` can call your factory again. Use a provider idempotency key or look up the existing object before creating another.

Use ordinary `set` when a failed attempt should roll back the value. Use `ensure` only when retries must keep and reuse a successfully created value.

## Know exactly what survives a failure

| Change made during `handle` | After handling reaches its checkpoint | If handling fails before its checkpoint |
| --- | --- | --- |
| `set` or `delete` | Staged until the delivery finishes | Discarded |
| `note` | Staged until the delivery finishes | Discarded |
| `end` | Staged until the delivery finishes | Discarded |
| Completed `ensure` | Already saved | Kept |
| Completed sandbox creation changes | Already saved | Kept |

After `handle` succeeds, its ordinary changes stay on the delivery while acknowledgement, cleanup, or saving retries. Other deliveries don't see them until the delivery finishes.

If handlers for the same session overlap, successful changes to different keys are merged. If they write the same key, whichever attempt completes last wins. Set `perSession: true` on every participating client when you need one-at-a-time processing, and remember that this only coordinates work inside one runtime process. See [control concurrency](clients.md#process-several-events-at-once).

Ending a session also releases every retained capacity reservation attached to it. It does not stop any client's external agent, so end shared sessions only after all attached external work has stopped. Calling `capacity.release()` from a handler is different: it releases only the current client's slot and keeps the session active.

If one handler ends a session while another is finishing, the later completion can't make the ended session active again.

## Leave a useful history for people

Use a note for information an operator may want to read later instead of mixing status messages into your keyed values:

```ts
session.note("Sent review to the agent", {
  reviewId: event.id,
});
```

Notes are saved only when the attempt succeeds. Inspect them with:

```bash
npx simple-agent-orchestrator sessions show <session-id-or-key>
```

In application code, use `runtime.listSessionNotes(idOrKey)`.

## End work and allow a fresh session

When the pull request, conversation, or task is complete, end its session from the handler:

```ts
session.end({ reason: "github.pr.merged" });
```

The ended session remains available as history. A later delivery with the same `sessionKey` creates a new active session instead of reopening the old one.

You can also end a session from the CLI:

```bash
npx simple-agent-orchestrator sessions end <session-id-or-key> \
  --reason "closed by operator"
```

If the session has a sandbox, CLI or runtime administrative ending doesn't run its cleanup function. Clean the external resource yourself before or after the command, or end the session in a handler when automatic cleanup is required. See [clean up a session sandbox](environments-sandboxes.md#clean-up-after-the-session-ends).

To clean recorded sandboxes before ending, stop the long-running runtime and complete the exact active session ID:

```bash
npx simple-agent-orchestrator sessions complete <session-id> \
  --reason "closed by operator"
```

Completion mounts the relevant client environments and can be retried after a cleanup failure. A retry requires the sandbox's `reconcile` hook to decide whether cleanup completed, should repeat, or remains unknown. Completion does not accept a session key, because historical and active sessions can share one.

When the same key has both old ended records and a newer active record, lookup by key can return an older one. Use the session ID for `sessions show`, `sessions end`, and runtime lookup when you need one specific record.

Session records can contain `paused` and `failed` status values, but the package doesn't currently provide pause, resume, or session-failure commands and workflows.

## Store values safely

With `jsonFileStore`, session values and note data must be valid JSON and no more than 100 levels deep: strings, finite numbers, booleans, `null`, arrays, and plain objects containing those values. Don't store `undefined`, class instances, functions, `BigInt`, circular objects, or non-finite numbers. Invalid values fail the save instead of being silently changed.

The JSON file is plaintext. Don't put credentials, tokens, or other secrets in session values or notes unless you've made an explicit decision to protect that file appropriately.

Old ended sessions aren't removed automatically. A state-prune operation can remove one only when no kept delivery or exhaustion work refers to it and every sandbox record is `cleaned`. Preview the prune first; after you apply it, that session, its cleaned sandbox records, and its notes are no longer available for inspection.

## Next steps

- [Create session-specific resources](environments-sandboxes.md)
- [See what is kept after a failed attempt](failure-semantics.md#understand-which-session-changes-survive)
- [Look up the Session API](../api-reference.md#sessions)
