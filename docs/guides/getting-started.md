# Getting started

Simple Agent Orchestrator is installed inside an existing Node.js 20+ project.

## Initialize

```bash
npm install -D simple-agent-orchestrator
npx simple-agent-orchestrator init
npx simple-agent-orchestrator doctor
```

`init` walks upward from the current directory to the nearest `package.json`, or uses `--root <path>`. The root must already be a directory and its `package.json` must be a regular file containing a JSON object. Initialization does not create a host package and does not edit its manifest or scripts.

The command creates `.simple-agent-orchestrator/orchestrator.ts`, a manual channel, a minimal example client, local TypeScript/package metadata, and one `.gitignore` for `state/`, `tmp/`, and `logs/`. If the orchestrator directory exists, initialization fails unless `--force` is supplied. Force replaces known generated files while preserving unknown files.

`doctor` loads config, initializes and validates the store, and validates registrations. It does not run hooks, HTTP, polls, or handlers.

## Process an event

```bash
npx simple-agent-orchestrator dispatch manual \
  --id first-event \
  --session demo \
  --input "Hello agent runtime"

npx simple-agent-orchestrator events list
npx simple-agent-orchestrator sessions list
```

`--id` is required. The generated example client logs only the internal event and session identifiers, so it does not add session state or notes. Replace `.simple-agent-orchestrator/clients/example.ts` with your integration.

CLI dispatch acquires offline ownership, persists the event, drains currently eligible work, and exits. It does not wait for a future delayed retry.

## Start the runtime

```bash
npx simple-agent-orchestrator start
```

Ordinary startup runs pollers and workers and binds HTTP to `127.0.0.1:3000` by default. In another terminal:

```bash
curl -i -X POST http://127.0.0.1:3000/webhooks/manual \
  -H 'Content-Type: application/json' \
  -d '{"id":"http-first","sessionKey":"http-demo","input":"Hello"}'
curl http://127.0.0.1:3000/api/v1/status
```

Webhook success means durable ingestion, not handler success. Stop the runtime before offline mutation commands. Use `start --no-http` when no listener is wanted or `start --drain` to poll once, process eligible deliveries, and stop.

## Add project code

Project-local TypeScript imports use explicit `.ts` extensions:

```ts
import { createChannel } from "simple-agent-orchestrator";
import { fetchReviewCandidates } from "../../src/lib/github/reviews.ts";

export const reviews = createChannel("github.reviews", (channel) => {
  channel.poll({
    id: "reviews",
    every: "60s",
    fetch: () => fetchReviewCandidates(),
    map: (review) => ({
      id: review.id,
      dedupeKey: `${review.id}:${review.updatedAt}`,
      sessionKey: `github:${review.repo}:pr:${review.prNumber}`,
      input: review.toMarkdown(),
      payload: review,
    }),
  });
});
```

Keep external operations idempotent. JSON state and normal logs are plaintext; do not persist or log secrets or sensitive event content by default.
