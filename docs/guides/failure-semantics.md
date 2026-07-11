# Design retry-safe work

The most important fact about a retried handler is simple: some of its code may already have succeeded.

An API request can reach a provider just before your process loses its connection. A source acknowledgement can finish just before saving the delivery result fails. A process can stop halfway through a handler. In each case, the orchestrator has to try again because it can't prove what happened outside the process.

This guide shows where retries begin, which session changes survive a failure, and how to keep repeated calls from creating duplicate real-world effects.

## Separate duplicate events from retried work

These protections answer different questions:

- Event dedupe asks, "Have I already accepted this source event?" A second dispatch with the same channel and `dedupeKey` returns the first event ID and creates no new deliveries.
- Delivery retry asks, "Did this handler finish successfully?" A failed or interrupted attempt runs that handler again for the event already on record.

Dedupe does not make a handler safe to retry. Once a delivery exists, its external calls may happen more than once.

## Know exactly what one attempt runs

For each delivery attempt, the runtime follows this order:

1. Find an active session for the event's session key, or create one.
2. Use the client's mounted environment.
3. Create or reuse the session sandbox, if the environment defines one.
4. Run `handle`.
5. Run `onSuccess`.
6. If the handler called `session.end()`, clean up that session's sandbox.
7. Save the successful session changes and mark the delivery `processed`.

An error in sandbox creation, `handle`, `onSuccess`, sandbox cleanup, or saving the successful result fails the attempt. If attempts remain, the delivery returns to `pending` and starts again at step 1 after its configured delay.

`attempts` includes the first run. The default is three attempts with no delay. Attempts and delay are resolved separately: a handler value overrides the client's value captured when that handler was registered, which overrides the config value. Delays are fixed; there is no built-in backoff or jitter. A normal drain runs work whose scheduled time has arrived and doesn't wait for a later retry.

## Use `onFailure` for reporting, not recovery state

`onFailure` runs when an error occurs after the runtime has built the handler context. It receives the original error. If sandbox creation fails before that context exists, `onFailure` can't run.

An error thrown by `onFailure` is logged but doesn't replace the original delivery error. Normal session changes made there are discarded with the failed attempt, so don't use `onFailure` to save a recovery checkpoint. A completed `session.ensure(...)` is the exception described below.

## Understand which session changes survive

| What your code does | If the whole attempt succeeds | If the attempt fails |
| --- | --- | --- |
| `session.set(...)` or `session.delete(...)` | Saved | Discarded |
| `session.note(...)` | Saved | Discarded |
| `session.end(...)` | Saved | Discarded |
| Completed `session.ensure(...)` | Already saved | Kept for the retry |
| Completed sandbox creation details | Already saved | Kept for the retry |
| Normal changes in `onFailure` | Not applicable | Discarded |

This split is intentional. Ordinary changes describe a successfully completed attempt, so a failure rolls them back. An `ensure` value usually identifies something already created outside the process; keeping it gives the retry a chance to reuse that same thing. Sandbox creation follows the same rule.

There is still a small but important gap: an `ensure` factory or sandbox creator can finish its external work just before the process stops and before the result is recorded. Make those creators safe to run again too.

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

That acknowledgement still needs to be safe to repeat. Sandbox cleanup or saving the successful result can fail after `onSuccess`, so the next attempt may call it again.

Every matching handler receives its own delivery and hooks. If an event fans out to several handlers, there is no package hook that waits for all of them. Pick one handler to acknowledge the source, or coordinate that decision in your application.

For polled sources, `commit` means the mapped events have been recorded locally. It runs before their handlers necessarily succeed. You can use it for source checkpoint work, but make that work safe to repeat: the external checkpoint may succeed even if saving the local cursor fails afterward.

## Cooperate with timeout and shutdown

When a handler times out or the runtime shuts down, the runtime aborts the `signal` and waits for active code to settle. JavaScript that ignores the signal can't be forcibly stopped.

Pass `signal` to `fetch`, provider SDKs, subprocess management, sandbox code, and your own APIs. Even cancellation-aware code may have completed an external call before noticing the abort, which is another reason stable keys matter.

If the timeout happens first, the attempt records a `HandlerTimeoutError` and follows the normal retry rules. If shutdown starts first, shutdown remains the cancellation reason. The timeout covers sandbox creation, `handle`, `onSuccess`, and sandbox cleanup.

## Expect a rerun after a process interruption

If the process stops while a delivery says it is `processing`, the next startup or drain returns it to `pending`. It can run again immediately rather than waiting for the normal retry delay.

The interrupted attempt still counts. If it had used the last configured attempt, recovery grants one replacement attempt so the event isn't left failed merely because the process disappeared mid-run.

The runtime doesn't call `onFailure` for the interrupted run because that process is gone. It also can't know whether the external work completed. The replacement starts the full handler again, so all external actions still need repeat protection.

## Retry manually when a person has fixed the cause

Once a delivery reaches `failed`, an operator can retry it through the testing helper, runtime API, or CLI. Manual retry only applies to failed deliveries. It grants one more attempt that can run immediately; it doesn't reset the historical attempt count.

Use this after fixing a bad credential, provider outage, or application bug. It isn't a substitute for safe external calls: the manual attempt can repeat the same actions as the earlier attempts.

## Plan for uncertain resource cleanup

Creation isn't the only risky edge. The process can stop in any of these gaps:

- An `ensure` factory creates a resource before its ID is recorded.
- Sandbox creation finishes before its marker is recorded.
- Sandbox cleanup finishes before the delivery is marked `processed`.

Use stable resource IDs, then check what exists before creating, cleaning up, or recreating anything. See [environments and sandboxes](environments-sandboxes.md#make-creation-and-cleanup-safe-to-repeat).

## Keep secrets out of saved data

Events, session state, notes, cursor values, delivery errors, the JSON state file, and normal logs are plaintext. Sanitize provider errors before throwing or logging them. Don't store credentials, access tokens, or unnecessary source content unless you've deliberately chosen to protect that data outside the package.

## Next steps

- [Configure retries, timeouts, and concurrency](clients.md)
- [Make sandbox creation and cleanup safe to repeat](environments-sandboxes.md#make-creation-and-cleanup-safe-to-repeat)
- [Test failed attempts and manual retries](testing.md)
