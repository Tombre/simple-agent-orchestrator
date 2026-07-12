# Design retry-safe work

The most important fact about a retried handler is simple: some of its code may already have succeeded.

An API request can reach a provider just before your process loses its connection. A source acknowledgement can finish just before saving the delivery result fails. A process can stop halfway through a handler. In each case, the orchestrator has to try again because it can't prove what happened outside the process.

This guide shows where retries begin, which session changes survive a failure, and how to keep repeated calls from creating duplicate real-world effects.

## Separate duplicate events from retried work

These protections answer different questions:

- Event dedupe asks, "Have I already accepted this source event?" A second dispatch with the same channel and `dedupeKey` returns the first event ID and creates no new deliveries.
- Delivery retry asks, "Did this delivery finish successfully?" A failed or interrupted phase runs again for the event already on record. Earlier phases that reached their saved checkpoint don't repeat.

Dedupe does not make a handler safe to retry. Once a delivery exists, its external calls may happen more than once.

## Know exactly what one attempt runs

For each delivery attempt, the runtime follows this order:

1. Find an active session for the event's session key, or create one. An `existing-only` handler instead uses only its dispatch-time session ID. If that session is no longer active, the delivery is ignored without running another attempt; a prior failed attempt remains recorded.
2. Acquire or reuse its client capacity reservation, when configured.
3. Use the client's mounted environment.
4. Create or reuse the session sandbox, if the environment defines one.
5. Run `handle`.
6. Run `onSuccess`.
7. If the handler called `session.end()`, clean up that session's sandbox.
8. Save the successful session changes and mark the delivery `processed`.

An error in sandbox creation, `handle`, `onSuccess`, sandbox cleanup, or saving the successful result fails the attempt. If attempts remain, the delivery returns to `pending` after its configured delay and resumes the failed phase. Completed earlier phases do not run again.

`attempts` includes the first run. The default is three attempts with no delay. Attempts and delay are resolved separately: a handler value overrides the client's value captured when that handler was registered, which overrides the config value. Delays are fixed; there is no built-in backoff or jitter. A normal drain runs work whose scheduled time has arrived and doesn't wait for a later retry.

## Use `onFailure` for reporting, not recovery state

`onFailure` runs when an error occurs after the runtime has built the handler context. It receives the original `error` and a `stage` value: `handling`, `acknowledging`, `cleaning`, or `persisting`. If sandbox creation fails before that context exists, `onFailure` can't run.

An error thrown by `onFailure` is logged but doesn't replace the original delivery error. Normal session changes made there are discarded with the failed attempt, so don't use `onFailure` to save a recovery checkpoint. A completed `session.ensure(...)` is the exception described below.

## Understand which session changes survive

| What your code does | After its phase succeeds | If that phase fails before its checkpoint |
| --- | --- | --- |
| `session.set(...)` or `session.delete(...)` | Saved | Staged after successful handling; committed only after all phases finish |
| `session.note(...)` | Saved | Staged after successful handling; committed only after all phases finish |
| `session.end(...)` | Saved | Staged after successful handling; committed only after all phases finish |
| Completed `session.ensure(...)` | Already saved | Kept for the retry |
| Completed sandbox creation details | Already saved | Kept for the retry |
| Normal changes in `onFailure` | Not applicable | Discarded |

This split is intentional. Ordinary changes remain attached to the delivery after `handle` succeeds, but other deliveries don't see them until every phase finishes. If `handle` fails before its checkpoint, those changes are discarded. An `ensure` value usually identifies something already created outside the process; keeping it gives the retry a chance to reuse that same thing. Sandbox creation follows the same rule.

There is still a small but important gap: an `ensure` factory or sandbox creator can finish its external work just before the process stops and before final status is recorded. Save external IDs through the sandbox checkpoint API and use `reconcile` to check them before creating again. The external create call still needs a stable key because a process can stop before the first checkpoint write.

## Give every external action a stable key

If a provider supports idempotency keys, use one stable key per real-world action:

```ts
client.handle(channel, {
  async handle({ event, session, signal }) {
    const agentSessionId = await session.ensure("agent.sessionId", async () => {
      const created = await createAgentSession({
        idempotencyKey: `agent-session:${session.id}`,
        signal,
      });
      return created.id;
    });

    await sendToAgent(agentSessionId, String(event.input), {
      idempotencyKey: `agent-message:${event.channelId}:${event.dedupeKey}`,
      signal,
    });
  },

  async onSuccess({ event, signal }) {
    await acknowledgeSource(event.payload, {
      idempotencyKey: `source-ack:${event.channelId}:${event.dedupeKey}`,
      signal,
    });
  },
});
```

Don't put `attempt` in these keys. Attempt 2 is repeating the same action as attempt 1, so the provider must receive the same key.

Use a different prefix for each action. Creating an agent session, sending a message, and acknowledging the source are three separate calls and shouldn't accidentally suppress one another.

If the provider has no idempotency-key feature, choose a stable external identifier and read the provider's current state before changing it. For example, look up a worktree by a session-derived name before creating one.

## Acknowledge the source at the right time

Put source acknowledgement in `onSuccess`, after `handle`. If the main work fails, the source hasn't been told that it completed.

That acknowledgement still needs to be safe to repeat if it fails or the process stops before its completion checkpoint. Once `onSuccess` is durably complete, cleanup or persistence retries do not call it again.

Every matching handler receives its own delivery and hooks. If an event fans out to several handlers, there is no package hook that waits for all of them. Pick one handler to acknowledge the source, or coordinate that decision in your application.

For polled sources, `commit` means the mapped events have been recorded locally. It runs before their handlers necessarily succeed. You can use it for source checkpoint work, but make that work safe to repeat: the external checkpoint may succeed even if saving the local cursor fails afterward.

## Cooperate with timeout and shutdown

When a handler times out or the runtime shuts down, the runtime aborts the `signal` and waits for active code to settle. JavaScript that ignores the signal can't be forcibly stopped.

Pass `signal` to `fetch`, provider SDKs, subprocess management, sandbox code, and your own APIs. Even cancellation-aware code may have completed an external call before noticing the abort, which is another reason stable keys matter.

If the timeout happens first, the attempt records a `HandlerTimeoutError` and follows the normal retry rules. If shutdown starts first, shutdown remains the cancellation reason. The timeout covers sandbox creation, `handle`, `onSuccess`, and sandbox cleanup.

## Expect a rerun after a process interruption

If the process stops while a delivery says it is `processing`, the next startup or drain returns it to `pending`. It can run again immediately rather than waiting for the normal retry delay.

The interrupted attempt still counts. If it had used the last configured attempt, recovery grants one replacement attempt so the event isn't left failed merely because the process disappeared mid-run.

The runtime doesn't call `onFailure` for the interrupted run because that process is gone. Recovery resumes the saved next phase. The phase that was running can repeat because the runtime can't know whether its external work completed before the process stopped.

## Handle terminal failure durably

Register `client.onExhausted(...)` when every exhausted primary delivery needs follow-up work such as alerting or dead-letter publication. The runtime creates one saved exhaustion record with the source delivery, failed stage, optional read-only session, and a sanitized failure descriptor. It runs with its own retries and timeout, never creates a sandbox, and cannot recursively create more exhaustion work. This is independent historical work: manually retrying the source does not remove it or require the source delivery to remain failed.

The same uncertainty applies to retained capacity. If a capacity-configured handler fails, times out, or is interrupted after it may have launched an external agent, its session keeps the slot. Confirm that the external work has stopped before releasing that capacity through a completion handler, the runtime API, or the CLI.

## Retry manually when a person has fixed the cause

Once a delivery or exhaustion record reaches `failed`, an operator can retry it through the testing helper, runtime API, or CLI. Manual retry grants that record one more attempt that can run immediately; it doesn't reset the historical attempt count.

Use this after fixing a bad credential, provider outage, or application bug. It isn't a substitute for safe external calls: the manual attempt can repeat the same actions as the earlier attempts.

## Plan for uncertain resource cleanup

Creation isn't the only risky edge. The process can stop in any of these gaps:

- An `ensure` factory creates a resource before its ID is recorded.
- Sandbox creation finishes before its `active` status is recorded.
- Sandbox cleanup finishes before the delivery is marked `processed`.

Use stable resource IDs, then check what exists before creating, cleaning up, or recreating anything. See [environments and sandboxes](environments-sandboxes.md#make-creation-and-cleanup-safe-to-repeat).

## Keep secrets out of saved data

Events, session state, notes, cursor values, delivery errors, the JSON state file, and normal logs are plaintext. Sanitize provider errors before throwing or logging them. Don't store credentials, access tokens, or unnecessary source content unless you've deliberately chosen to protect that data outside the package.

## Next steps

- [Configure capacity, retries, timeouts, and concurrency](clients.md)
- [Make sandbox creation and cleanup safe to repeat](environments-sandboxes.md#make-creation-and-cleanup-safe-to-repeat)
- [Test failed attempts and manual retries](testing.md)
