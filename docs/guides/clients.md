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
    await sendToAgent(session.key, String(event.input));
  },

  async onSuccess({ event }) {
    await markReviewSeen(event.payload);
  },

  async onFailure({ event, error }) {
    console.error("Failed", event.id, error);
  },
});
```

## Concurrency

Default client concurrency is one worker.

```ts
client.concurrency({ workers: 4, perSession: true });
```

- `workers` controls how many deliveries the client processes at once.
- `perSession: true` prevents two deliveries for the same session key from running at the same time in the same runtime process.

For agents with their own queueing, you can leave `perSession` disabled.
