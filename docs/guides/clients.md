# Clients and handlers

A client subscribes to channels and handles event deliveries.

```ts
import { createClient } from "simple-agent-orchestrator";
import { githubReviewsChannel } from "../channels/github";

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
| `signal` | Abort signal for graceful shutdown. |

## Handler object form

Use object form when you need retries or success hooks:

```ts
client.handle(githubReviewsChannel, {
  retries: { attempts: 5 },

  async handle({ event, session }) {
    await sendToAgent(session.key, String(event.input), {
      idempotencyKey: `agent-message:${event.channelId}:${event.dedupeKey}`,
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

Retry defaults are resolved in this order: handler options, `client.retries(...)`, global config `retries`, then three attempts. Automatic retries run immediately without backoff. Manual retry accepts only a failed delivery and grants one additional attempt.

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
