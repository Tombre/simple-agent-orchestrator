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

## Polling channel

```ts
import { createChannel } from "simple-agent-orchestrator";

export const githubReviewsChannel = createChannel("github.reviews", (channel) => {
  channel.poll({
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

A delivery is only marked `processed` after the client handler succeeds.
