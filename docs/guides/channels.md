# Receive events with channels

You want your app to react when something happens: a pull request changes, a command arrives, or a scheduled check finds new work. A channel names that source and gives every event from it the same entry point.

Start with a manual channel. You can send it an event from the CLI now, then add HTTP or polling when you need it.

## Send your first event

Create a channel with a globally unique ID:

```ts
// .simple-agent-orchestrator/channels/manual.ts
import { createManualChannel } from "simple-agent-orchestrator";

export const manualChannel = createManualChannel("manual");
```

Use the channel in a [client handler](clients.md#handle-your-first-event) and register that client in `orchestrator.ts`. Then send an event:

```bash
npx simple-agent-orchestrator dispatch manual \
  --id manual-1 \
  --session demo \
  --input "Run a local agent task"
```

The channel identifies where the event came from. The event's `id` identifies what happened at that source. Dispatch saves the event before returning.

When a client subscribes to this channel, dispatch also creates a **delivery** for its handler. A delivery is the saved record of one handler's work on one event, including attempts and the final result. An event can be accepted even when no handlers subscribe, so `queued` means "saved," not "processed successfully."

The CLI command changes saved project data without starting workers. If your project uses the JSON file store and a running runtime is already changing that file, stop it first; otherwise, the command fails without writing.

## Shape source data into an event

Only `id` is required. A useful event often looks like this:

```ts
{
  id: "review-123",
  type: "github.review.updated",
  dedupeKey: "review-123:2026-07-10T10:30:00Z",
  sessionKey: "github:acme/api:pr:42",
  input: "Please address this review comment",
  payload: rawReview,
  meta: { branch: "fix-login" },
  occurredAt: "2026-07-10T10:30:00Z",
}
```

| Field | What to put there |
| --- | --- |
| `id` | The source's stable ID for this event. |
| `type` | The kind of event, when handlers need to distinguish kinds. |
| `dedupeKey` | A stable key for one source update. It defaults to `id`. |
| `sessionKey` | A stable key shared by events that should continue the same work. It defaults to `${channelId}:${id}`. |
| `input` | Text or other direct input for your handler or agent. |
| `payload` | Structured source data the handler needs. |
| `meta` | Small routing details, such as a branch or repository name. |
| `occurredAt` | When the event happened at the source. |

The runtime checks duplicates using the channel ID together with `dedupeKey`. If `review-123` can change several times, use a version or update timestamp in the key. Otherwise, later updates will be treated as copies of the first one.

Choose `sessionKey` separately. For example, several review updates can have different dedupe keys but share one pull-request session. A **session** is the saved context reused by related deliveries while that session is active.

## Send events from your application

If the runtime is already running and uses this exact `manualChannel` object, you can dispatch through the channel:

```ts
const result = await manualChannel.dispatch({
  id: "manual-2",
  sessionKey: "demo",
});
```

If you already have the runtime, call it directly:

```ts
await runtime.dispatch(manualChannel, { id: "manual-3" });
await runtime.dispatch("manual", { id: "manual-4" });
```

Passing the channel object requires that exact object to be registered. Passing `"manual"` asks the runtime to find its registered channel by ID. This is the safer choice when your code might create or manage more than one runtime.

Every call returns after the event and all matching deliveries have been saved:

```ts
type DispatchResult = {
  status: "queued" | "duplicate";
  eventId: string;
};
```

`eventId` is the runtime's internal stored ID, not your source `id`. A duplicate returns the original internal ID and creates no new deliveries.

Saved events also remember which dedupe keys have already been accepted. Removing old processed deliveries doesn't remove that memory by default. If you explicitly prune an old event with `state prune --drop-dedupe`, the same channel and dedupe key can be accepted and processed again.

Dispatch calls that change state reject after the runtime stops. Create and initialize a new runtime before sending more events.

If you're loading a fresh runtime for a one-off change to the JSON store, wrap the work in `runOffline()`. That acquires the state-file lock for the whole operation:

```ts
await runtime.runOffline(async ({ dispatch, drain }) => {
  await dispatch("manual", { id: "manual-5" });
  await drain();
});
```

Calling `runtime.dispatch(...)` on a runtime that is only initialized does not acquire that lock by itself. Direct calls are fine with the memory store or a runtime that already owns its store through `start()` or `drain()`.

## Accept event-shaped JSON over HTTP

Ordinary `start()` provides `POST /webhooks/:channelId`:

```bash
curl -i -X POST http://127.0.0.1:3000/webhooks/manual \
  -H 'Content-Type: application/json' \
  -d '{"id":"manual-5","sessionKey":"demo","input":"Run this task"}'
```

A new event returns `202`; a duplicate returns `200`. Both responses mean dispatch finished saving its records. They don't mean a handler has finished.

This route expects JSON already shaped like `DispatchEvent`, not GitHub, Stripe, or another provider's original body. If a provider sends a different shape, add a project route that verifies the signature, checks who may send events, and then calls `dispatch`. If you use the built-in route directly, add authentication in project middleware. See [add provider-specific HTTP routes](project-integration.md#add-provider-specific-http-routes).

The built-in route requires `Content-Type: application/json`, accepts at most 1 MiB and 100 nested levels, and rejects unknown fields or invalid values. Identifiers can be at most 512 characters, and `type` can be at most 256. See [built-in HTTP routes](../api-reference.md#built-in-routes) for every request rule and response.

## Check a source on a schedule

Suppose you want to check a review API every minute. A **cursor** is the poll's saved checkpoint, such as the latest update timestamp it has seen. It lets the next run continue from the right place after a restart.

Add a poll to a channel and update its cursor only after the fetched events are saved:

```ts
// .simple-agent-orchestrator/channels/reviews.ts
import { createChannel, cursorKey } from "simple-agent-orchestrator";
import { fetchReviews } from "../../src/github.ts";

const lastUpdatedAt = cursorKey<string>("lastUpdatedAt");

export const reviewsChannel = createChannel("github.reviews", (channel) => {
  channel.poll({
    id: "reviews",
    every: "60s",

    async fetch({ cursor, pollStartedAt, signal }) {
      return fetchReviews({
        since: cursor.get(lastUpdatedAt),
        updatedBefore: pollStartedAt,
        signal,
      });
    },

    map(review) {
      return {
        id: review.id,
        dedupeKey: `${review.id}:${review.updatedAt}`,
        sessionKey: `github:${review.repository}:pr:${review.pullRequest}`,
        input: review.body,
        payload: review,
      };
    },

    commit({ cursor, items }) {
      const latest = items.map((item) => item.updatedAt).sort().at(-1);
      if (latest) cursor.set(lastUpdatedAt, latest);
    },
  });
});
```

Each run follows this order:

1. `fetch` returns source items.
2. `map` converts each item, one at a time and in order, into one event or an array of events. Return `null` or `undefined` to skip one.
3. The runtime flattens mapped arrays and saves each event sequentially in order, creating matching deliveries.
4. `commit` performs any checkpoint work you add.
5. Cursor changes are saved.

If `fetch`, `map`, dispatch, or `commit` fails, cursor changes from that run are discarded. Events saved before the failure stay saved. Use stable dedupe keys so the next run safely recognizes those events instead of creating more deliveries.

`pollStartedAt` is an ISO timestamp captured once immediately before `fetch`. The same value reaches `fetch`, every `map` call, and `commit`, so you can use it as a stable upper bound even when a long poll crosses into a later time window.

Keep external work in `commit` safe to repeat. For example, an API checkpoint can succeed just before saving the local cursor fails. The next poll then runs `commit` again.

One runtime won't execute the same poll twice at once. That protection doesn't coordinate separate processes, so run only one polling runtime for a source unless the source API provides its own coordination. Pass `signal` to API calls so shutdown can cancel a request that's still running.

Polls run immediately by default and then repeat at `every`. Set `immediate: false` if the first run should wait for the interval.

## Keep each poll's checkpoint attached to it

Give every poll an `id`, especially when a channel has more than one. A named poll saves its cursor under `${channelId}:${pollId}`, so moving its registration doesn't change which checkpoint it reads.

If you change the poll ID, it starts with the values stored under the new ID; the old values aren't moved automatically. Reusing an older ID also reuses its older cursor, so don't recycle IDs for unrelated polls.

An unnamed poll uses `${channelId}:${pollRegistrationIndex}`. If you reorder unnamed polls, they can read each other's old cursor values. Add stable IDs before you reorder them.

With `jsonFileStore`, cursor values and event fields must contain valid JSON values. The file is plaintext, so don't put access tokens or other secrets in them.

## Acknowledge the source after processing

`commit` means the poll fetched and saved events. Handlers may not have started yet, so don't use `commit` to tell a source that processing succeeded.

If the source needs that confirmation, choose one handler and send it from `onSuccess`. Make that call safe to repeat if acknowledgement fails or is interrupted before its checkpoint. Later cleanup and persistence retries do not rerun it. If an event fans out to several handlers, there is no event-wide callback that waits for all of them, so pick the handler whose success is enough to confirm the source. See [acknowledge the source](failure-semantics.md#acknowledge-the-source-at-the-right-time).

Channel and poll registrations are captured when the runtime initializes. If you add, remove, or reorder them afterward, create a new runtime to apply the change.

## Next steps

- [Process events with clients](clients.md)
- [Keep context with sessions](sessions-state.md)
- [Look up the channel API](../api-reference.md#channels-and-events)
