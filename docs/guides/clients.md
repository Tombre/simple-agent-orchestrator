# Process events with clients

You've got events arriving on a channel. Now you want code to do something with them. A client groups the handlers for one consumer and gives you one place to control retries, timeouts, parallel work, and any shared process resources.

## Handle your first event

Subscribe a client to the reviews channel:

```ts
// .simple-agent-orchestrator/clients/coding.ts
import { createClient } from "simple-agent-orchestrator";
import { reviewsChannel } from "../channels/reviews.ts";

export const codingClient = createClient("coding", (client) => {
  client.handle(reviewsChannel, async ({ event, logger }) => {
    logger.info("Handling review", { sourceId: event.id });
  });
});
```

Register the client and channel in `orchestrator.ts`. Client IDs must be globally unique.

Each accepted event creates a **delivery** for this handler. A delivery is the saved record that tracks this handler's attempts and result for that event. If three clients subscribe, all three get independent deliveries. One client can also register several handlers for the same channel, and each handler gets its own delivery.

## Use the event and its session

Most handlers need the event plus some context shared with related events:

```ts
client.handle(reviewsChannel, async ({ event, session, signal }) => {
  const response = await sendReviewToAgent(String(event.input), { signal });
  session.set("lastResponseId", response.id);
});
```

A **session** is the saved context for events with the same `sessionKey`. It lets a later delivery continue the same pull request, conversation, or task. Session changes made with `set`, `delete`, `note`, or `end` are saved only if the entire attempt succeeds.

An **environment** holds values such as an API client or local server for this client while the process runs. A **sandbox** is an optional worktree, remote workspace, or similar resource created separately for each session. You can start without either; the handler still receives an empty environment named `default`.

Every handler receives:

| Field | What you can use it for |
| --- | --- |
| `event` | The source event plus its channel ID and final dedupe and session keys. |
| `session` | Values and notes shared by related events. |
| `environment` | Values available to this client process and its optional per-session sandbox. It is always present. |
| `client` | The registered client description. |
| `project` | Project paths and package metadata. |
| `logger` | The configured logger. |
| `attempt` | This delivery's current attempt number, starting at `1`. |
| `signal` | Cancellation requested by shutdown or a handler timeout. |

Pass `signal` to `fetch`, subprocesses, agent SDKs, and your own cancellation-aware functions. That gives your code a chance to stop cleanly during shutdown or after a timeout.

## Run follow-up work on success or failure

Use the object form when you want a stable handler ID or extra steps around the main work:

```ts
client.handle(reviewsChannel, {
  id: "process-review",

  async handle({ event, session, signal }) {
    await sendReviewToAgent(String(event.input), {
      idempotencyKey: `agent-message:${event.channelId}:${event.dedupeKey}`,
      signal,
    });

    session.note("Sent review to the agent");
  },

  async onSuccess({ event, signal }) {
    await markReviewSeen(event.id, {
      idempotencyKey: `source-ack:${event.channelId}:${event.dedupeKey}`,
      signal,
    });
  },

  onFailure({ event, error, logger }) {
    logger.error("Review delivery failed", {
      sourceId: event.id,
      error: sanitizeError(error),
    });
  },
});
```

The runtime calls `handle` first and `onSuccess` second. Once the handler context exists, a failure in the attempt calls `onFailure` with the original error. A setup failure before that context exists can't call it. If `onFailure` throws too, that new error is logged but doesn't replace the delivery's original error.

Retries can repeat `handle` or `onSuccess`, including external work that completed just before an error or process exit. Use provider idempotency keys, lookup-before-create logic, or another source-specific safeguard for every external effect.

If an event fans out to several handlers, each delivery runs its own hooks. There is no event-wide `onSuccess` that waits for every delivery, so assign source confirmation to one handler whose success represents the result you need.

Handler IDs must be unique within a client. If you don't provide one, the ID includes the client ID, channel ID, and the handler's one-based registration position. Inserting a handler earlier or reordering handlers changes those generated IDs, so provide a stable `id` when you inspect or operate on deliveries over time.

## Retry temporary failures

Set shared defaults before registering handlers:

```ts
client.retries({ attempts: 5, delay: "10s" });
```

Override either value for one handler when its source needs different behavior:

```ts
client.handle(reviewsChannel, {
  retries: { attempts: 2, delay: "30s" },
  async handle(context) {
    // Process the event.
  },
});
```

`attempts` includes the first attempt. `delay` is the same fixed wait each time; the package doesn't add backoff or jitter. The built-in values are three attempts and no delay.

The runtime resolves `attempts` and `delay` separately, using the first value it finds:

1. The handler's options.
2. The client's defaults at the moment `client.handle(...)` was called.
3. Global config.
4. Three attempts and zero delay.

Order matters: changing `client.retries(...)` after registering a handler doesn't change that handler. Set client defaults first, then add handlers.

A delayed retry remains `pending` with a future `nextAttemptAt`. A continuously running worker processes it after that time. `start({ drain: true })` and `drain()` don't wait for future retries, so run another drain later or use ordinary `start()`.

If a process stops while a delivery is `processing`, startup or the next drain returns it to `pending` immediately and keeps the interrupted attempt in its count. If that interruption used the last configured attempt, the runtime grants one replacement attempt so the work isn't stranded.

After all automatic attempts fail, an operator can manually retry a failed delivery. That grants one additional attempt that can run immediately; it doesn't apply to pending, processing, or processed deliveries. See [end a session or retry failed work](cli.md#end-a-session-or-retry-failed-work).

## Stop an attempt that's taking too long

Set a client default:

```ts
client.timeout("10m");
```

Set `timeout` on one handler to override it. Use `timeout: 0` to disable a client or global timeout for that handler. Like retries, a handler keeps the client timeout that was active when you registered it.

The timer covers sandbox creation, `handle`, `onSuccess`, and sandbox cleanup. When it expires, the runtime aborts `signal`, waits for cancellation-aware code to finish, records a `HandlerTimeoutError`, and follows the ordinary retry rules. Catching the cancellation and returning normally doesn't turn the attempt into a success. `onFailure` receives the timeout error after the handler context exists, but it doesn't get a new timeout of its own.

JavaScript can't force code to stop. If your code ignores `signal`, the runtime still has to wait for it, and an external operation may finish even though the attempt timed out. Pass the signal through and keep external calls safe to repeat. If shutdown and the timeout happen together, shutdown cancellation takes precedence.

## Process several events at once

Clients start with one worker. Increase that when this client's handlers can safely overlap:

```ts
client.concurrency({ workers: 4, perSession: true });
```

`workers: 4` allows up to four deliveries for this client to run at once. `perSession: true` prevents this client from running two deliveries for the same session at the same time.

That same-session protection applies only to this client and only inside one runtime process. If another client handles the same sessions, it must also enable `perSession`. Separate runtime processes don't coordinate these locks.

Without `perSession`, same-session handlers can overlap. Changes to different session keys are merged. If two successful attempts write the same key, the one that finishes last wins. Enable `perSession` when order matters, but remember it can't coordinate multiple processes.

Client registrations and their retry, timeout, concurrency, and environment choices are captured when the runtime initializes. Create a new runtime after changing them. Also sanitize provider errors before logging or throwing them; default logs and saved delivery errors are plaintext.

## Next steps

- [Keep context in sessions](sessions-state.md)
- [Attach resources with environments and sandboxes](environments-sandboxes.md)
- [Design retry-safe effects](failure-semantics.md)
