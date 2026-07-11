# Clients and handlers

A client subscribes to channels and handles event deliveries.

```ts
import { createClient } from "simple-agent-orchestrator";
import { githubReviewsChannel } from "../channels/github.ts";

export const codingClient = createClient("coding", (client) => {
  client.handle(githubReviewsChannel, async ({ event, session, logger }) => {
    logger.info("Handling review", { eventId: event.id, sessionKey: session.key });
  });
});
```

## Handler context

Handlers receive one context object:

```ts
async function handler({
  event,
  session,
  environment,
  client,
  project,
  logger,
  attempt,
  signal,
}) {}
```

| Field | Description |
| --- | --- |
| `event` | Durable event with `input`, `payload`, and `meta`. |
| `session` | Active session for `event.sessionKey`. |
| `environment` | Mounted client environment. |
| `client` | Client definition. |
| `project` | Project root/path helpers. |
| `logger` | Runtime logger. |
| `attempt` | Current delivery attempt number. |
| `signal` | Abort signal for an attempt timeout or graceful shutdown. |

## Handler object form

Use object form when you need retries, a timeout, or success hooks:

```ts
client.handle(githubReviewsChannel, {
  retries: { attempts: 5, delay: "10s" },
  timeout: "2m",

  async handle({ event, session, signal }) {
    await sendToAgent(session.key, String(event.input), {
      idempotencyKey: `agent-message:${event.channelId}:${event.dedupeKey}`,
      signal,
    });
  },

  async onSuccess({ event }) {
    await markReviewSeen(event.payload, {
      idempotencyKey: `source-ack:${event.channelId}:${event.dedupeKey}`,
    });
  },

  async onFailure({ event, error, logger }) {
    logger.error("Failed delivery", { eventId: event.id, error: sanitizeError(error) });
  },
});
```

Retry fields are resolved independently in this order: handler options, `client.retries(...)`, global config `retries`, then three attempts and zero delay. `delay` is fixed and accepts milliseconds or strings such as `"500ms"`, `"10s"`, `"5m"`, and `"1h"`. Positive fractions round up to a whole millisecond. The maximum is `2_147_483_647` ms (about 24.9 days). The first attempt is immediate. After a failed nonterminal attempt, a positive delay leaves the delivery durably `pending` with a `nextAttemptAt` timestamp.

Normal workers process delayed retries after they become eligible, including after restart. One-shot and direct drains process only currently eligible work and return without waiting. Manual retry accepts only a failed delivery, grants one immediately eligible attempt, and bypasses delay. Startup and drain also recover deliveries left `processing` immediately; the interrupted attempt remains counted, with one replacement attempt granted only when the interruption exhausted the configured budget. Retry delay is fixed, not backoff, jitter, or general scheduling.

Timeout resolves from handler `timeout`, `client.timeout(...)`, global config `timeout`, then `0` (disabled). It uses the same duration syntax, rounding, and maximum as retry delay; an explicit `0` disables an inherited timeout. The deadline covers sandbox creation, `handle`, `onSuccess`, and sandbox cleanup. At expiry the runtime aborts `signal` with `HandlerTimeoutError`, waits for cooperative code to settle, and applies ordinary retry rules. A handler that catches the abort and returns is still timed out. Runtime shutdown wins if it aborts first.

Cancellation is cooperative. Pass `signal` into agent SDKs, `fetch`, subprocess handling, and other project APIs. Code that ignores it cannot be forcefully terminated and can block past the deadline; external side effects may have completed and can repeat on retry. `onFailure` receives the timeout error and aborted signal when the handler context was created, but the failure hook itself is not deadline-bounded.

The order is `handle`, `onSuccess`, required sandbox cleanup, then final success persistence. An error from any step fails the attempt and can rerun `handle`. `onFailure` receives the original error when a handler context exists; if it throws, its error is logged without replacing the original. Setup failures before the context exists do not call `onFailure`.

External effects in all hooks must be retry-safe. `onSuccess` is the correct place for source acknowledgement because handling has completed, but acknowledgement can still repeat if cleanup or persistence later fails. See [Failure semantics and idempotency](failure-semantics.md).

Hooks are per handler delivery. If an event fans out, designate an acknowledgement-owning handler only when its success represents the required source outcome; there is no event-wide hook that waits for every delivery. Errors and default logs are plaintext, so sanitize provider errors that may contain credentials or sensitive payloads before throwing or logging them.

## Concurrency

Default client concurrency is one worker.

```ts
client.concurrency({ workers: 4, perSession: true });
```

- `workers` controls how many deliveries the client processes at once.
- `perSession: true` prevents two deliveries for the same session key from running at the same time in the same runtime process.

For agents with their own queueing, you can leave `perSession` disabled.

Concurrent successful deliveries merge writes to different session-state keys. Concurrent writes to the same key use completion order, so enable `perSession` when same-session ordering matters.

Client definitions remain inspectable through readonly-typed properties such as `handlers`, `environment`, and concurrency/retry defaults, but they are not frozen. Builder calls configure the definition before it is returned. A runtime snapshots client registrations at `init()`; later mutation does not add handlers or reconfigure a live runtime.
