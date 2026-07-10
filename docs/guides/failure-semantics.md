# Failure semantics and idempotency

Delivery processing is retryable, not exactly once. Event dedupe prevents a second event record for the same `channelId + dedupeKey`; it does not prevent a delivery attempt or an external effect from being repeated.

## Attempt order

For a claimed delivery, the runtime:

1. resolves or creates the session;
2. uses the mounted client environment and creates its sandbox if needed;
3. runs `handle`;
4. runs `onSuccess`;
5. cleans up the sandbox if the handler ended the session;
6. persists ordinary session changes, notes, and the `processed` delivery status together.

An error from `handle`, `onSuccess`, sandbox cleanup, or final persistence fails the attempt. A configured attempt timeout also fails with `HandlerTimeoutError`. If attempts remain, the runtime persists the delivery as `pending`; a configured fixed retry delay also persists `nextAttemptAt`. The next eligible automatic attempt or an operator-requested manual attempt runs `handle` again, including when the previous `handle` completed its external work. A continuing store failure can instead leave the delivery `processing` until a later runtime startup or drain recovers it.

`onFailure` runs after a failed attempt when a handler context was created. It receives the original error. If `onFailure` throws, that secondary error is logged and does not replace the delivery error or change retry behavior. Failures before the context exists, including sandbox creation failures, do not invoke `onFailure`.

The timeout signal is cooperative. The runtime aborts it, waits for the active sandbox or handler operation to settle, and records a timeout even if that code catches cancellation and returns. Code that ignores the signal remains in progress and can block indefinitely. Runtime shutdown aborts the same derived signal; when shutdown happens first, it cancels the deadline rather than misclassifying shutdown as a timeout. Neither cancellation path proves that an external side effect did not happen.

Environment mounting occurs during runtime startup or drain setup, before deliveries are claimed. A mount failure rejects that lifecycle operation without consuming a delivery attempt or invoking its failure hook. Failed startup aborts in-flight work, clears poll intervals, unmounts every environment that mounted successfully, and releases store ownership before rejecting. Cleanup proceeds in reverse mount and hook-registration order and continues after individual unmount failures.

Persisted-state validation occurs before polling, environment mounting, interrupted-delivery recovery, or handler work. A validation or unsupported-version failure leaves the JSON file unchanged, releases ownership acquired for startup, and requires repair, a compatible package, or a restored backup before processing can continue. `state validate` performs the same read-only compatibility check without running work.

## What persists

| Change | Successful attempt | Failed attempt |
| --- | --- | --- |
| ordinary handler/hook `session.set`, `session.delete` | Persisted | Discarded |
| `session.note` | Persisted | Discarded |
| handler/hook `session.end` | Persisted | Discarded |
| successful `session.ensure` value | Persisted eagerly | Remains persisted |
| state mutations made during sandbox creation | Persisted eagerly | Remain persisted if creation and marker persistence completed |

Success means `handle`, `onSuccess`, required sandbox cleanup, and final store persistence all completed. Ordinary changes made in `onFailure` are also discarded. `session.ensure` remains eager even when called from a failure hook.

`session.ensure` and sandbox hooks cannot atomically commit an external resource operation with local state. A process or store failure after external creation but before marker persistence can run creation again. Cleanup has the corresponding uncertainty window. Cleanup can also finish and clear the marker before final delivery persistence fails, in which case a retry creates a new sandbox. Factories and lifecycle hooks must use provider idempotency, lookup-and-reconcile behavior, or another retry-safe project-owned strategy that supports the complete create-cleanup-recreate lifecycle.

## External effects

Use a stable, operation-specific idempotency key for every retryable external action. Do not include `attempt`, because attempts for the same logical operation must use the same key.

```ts
client.handle(channel, {
  async handle({ event, session }) {
    const agentSessionId = await session.ensure("agent.sessionId", async () => {
      const created = await createAgentSession({
        idempotencyKey: `agent-session:${session.id}`,
      });
      return created.id;
    });

    await sendToAgent(agentSessionId, String(event.input), {
      idempotencyKey: `agent-message:${event.channelId}:${event.dedupeKey}`,
    });
  },

  async onSuccess({ event }) {
    await acknowledgeSource(event.payload, {
      idempotencyKey: `source-ack:${event.channelId}:${event.dedupeKey}`,
    });
  },
});
```

This avoids the unsafe pattern of submitting the first prompt while creating an ensured session and then using an attempt-local `createdNow` flag. If a later step fails, a retry can otherwise submit that first event again.

When a provider has no idempotency-key feature, use stable external identifiers and reconcile current state before acting. Keep effects naturally idempotent where possible, and record enough project-owned identity to inspect uncertain outcomes.

## Source acknowledgement

Put acknowledgement in `onSuccess`, after `handle`, rather than in polling or at the start of a handler. This preserves retries when handling fails. The acknowledgement is still not atomic with sandbox cleanup or final delivery persistence, so it must itself be retry-safe and may run more than once.

`onSuccess` is per handler delivery. When an event fans out, designate one handler as the acknowledgement owner only if its success is the required source outcome. There is no event-wide hook that waits for every matching delivery to succeed.

Poll `commit` is an ingestion checkpoint, not a successful-processing acknowledgement. Poll order is `fetch`, sequential `map` and durable dispatch, `commit`, then cursor persistence. If a poll or commit fails, previously dispatched events remain durable while cursor changes roll back. Stable event dedupe keys make fetching those source items again safe.

## Process failures

External effects may be uncertain whenever a process stops between an external operation and local persistence. On the next startup or drain, after acquiring store ownership, the runtime changes every persisted `processing` delivery to `pending` and logs the affected delivery IDs and interrupted attempt numbers. The consumed attempt number and `startedAt` remain intact. If that interruption used the final configured attempt, recovery grants one replacement attempt; otherwise the original remaining retry budget applies.

Recovery does not call `onFailure` for the interrupted attempt because the runtime has no reliable error or handler context from the exited process. It records an interruption explanation in `lastError` while the delivery is pending. Recovery is immediately eligible rather than applying the automatic retry delay. The next claim increments `attempt`, reruns the complete handler attempt, and clears that explanation only after success or replaces it with a new failure. No operator command is required. Recovery cannot determine whether external work completed, so handlers, hooks, acknowledgements, ensured factories, and sandbox operations must all remain safe to repeat.

Stored delivery errors, JSON state, and default logs are plaintext and are not redacted automatically. Sanitize provider errors before throwing or logging them when they may contain credentials, request bodies, source content, or other sensitive values.
