# Channels

Channels are event sources. They can poll APIs, receive manual CLI events, or be connected to your own webhook/server code.

## Manual channel

```ts
import { createManualChannel } from "simple-agent-orchestrator";

export const manualChannel = createManualChannel("manual");
```

Dispatch from the CLI:

```bash
npx simple-agent-orchestrator dispatch manual \
  --id manual-1 \
  --session demo \
  --input "Run a local agent task"
```

CLI dispatch is an offline one-shot operation. Stop a long-running JSON-store runtime first; the command fails before writing when that runtime owns the state.

## Polling channel

```ts
import { createChannel } from "simple-agent-orchestrator";

export const githubReviewsChannel = createChannel("github.reviews", (channel) => {
  channel.poll({
    id: "reviews",
    every: "60s",

    async fetch({ cursor }) {
      return fetchRecentReviewCandidates({
        since: cursor.get<string>("lastUpdatedAt"),
      });
    },

    async map(review) {
      return {
        id: review.id,
        dedupeKey: `github.review:${review.id}:${review.updatedAt}`,
        sessionKey: `github:${review.repo}:pr:${review.prNumber}`,
        input: review.toMarkdown(),
        payload: review,
        meta: {
          branch: review.branch,
          prNumber: review.prNumber,
        },
      };
    },

    async commit({ cursor, items }) {
      const latest = items.map((item) => item.updatedAt).sort().at(-1);
      if (latest) cursor.set("lastUpdatedAt", latest);
    },
  });
});
```

## Event shape

A channel maps source data into a dispatch event:

```ts
{
  id: "review-123",
  dedupeKey: "github.review:review-123:2026-07-07T00:00:00Z",
  sessionKey: "github:acme/api:pr:42",
  input: "Markdown sent to the agent",
  payload: rawReview,
  meta: {
    branch: "fix-login"
  }
}
```

Fields:

| Field | Purpose |
| --- | --- |
| `id` | Source event id. Required. |
| `dedupeKey` | Optional event uniqueness key. Defaults to `id`. |
| `sessionKey` | Optional durable session mapping key. Defaults to `channelId:id`. |
| `input` | Agent-facing input. |
| `payload` | Structured source payload. |
| `meta` | Lightweight routing/resource metadata. |

## Dedupe behavior

Events are deduped by `channelId + dedupeKey`. A duplicate dispatch is not enqueued again, but the original event remains available in the store.

Event records are also the durable dedupe ledger. State pruning retains them by default even after processed delivery history is removed. Explicitly applying `state prune --drop-dedupe` removes eligible old events with no retained deliveries; the same source identity can then dispatch and run again.

A delivery is only marked `processed` after the handler, `onSuccess`, required sandbox cleanup, and final persistence succeed. Dedupe does not prevent a failed delivery attempt or its external effects from repeating.

Executions of the same poll do not overlap within one runtime process. Mapping is sequential. Mapped events are durably dispatched before `commit` runs, and cursor changes are persisted only after `fetch`, mapping, dispatch, and `commit` complete. Previously dispatched events remain if a later poll step fails, so stable dedupe keys must make refetching safe.

`commit` records ingestion progress; it does not wait for delivery processing and is not source acknowledgement. Keep acknowledgement in a retry-safe, designated client `onSuccess`. Because hooks are per delivery, there is no event-wide acknowledgement hook that waits for every fan-out delivery.

Set `id` when a poll's cursor must survive registration reordering. Named polls use `${channelId}:${id}`; unnamed polls continue to use `${channelId}:${pollRegistrationIndex}`. Duplicate resolved poll IDs and ambiguous final cursor keys are rejected. In a multi-poll channel, name every poll before reorganizing registrations because unnamed neighbors remain positional.

Adding or renaming a descriptive ID selects another cursor key and leaves the old cursor record unchanged; the runtime does not infer migrations. A key that has never existed starts empty, while reusing a historical ID restores its existing cursor, so do not recycle IDs for unrelated polls. To retain existing positional cursors during adoption, assign each poll its current index as a string, such as `id: "0"`, before moving registrations.
