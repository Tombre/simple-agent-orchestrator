# Simple Agent Orchestrator templates

Use explicit `.ts` extensions for project-local imports.

## Generated scaffold

`npx simple-agent-orchestrator init` writes these known files under the nearest existing npm package:

```text
.simple-agent-orchestrator/
  .gitignore
  package.json
  tsconfig.json
  orchestrator.ts
  channels/manual.ts
  clients/example.ts
```

It does not edit the host `package.json`. The generated `.gitignore` contains:

```gitignore
state/
tmp/
logs/
```

`--force` replaces these known template files but preserves unknown files.

## Minimal config

```ts
import { defineConfig } from "simple-agent-orchestrator";
import { manualChannel } from "./channels/manual.ts";
import { exampleClient } from "./clients/example.ts";

export default defineConfig({
  channels: [manualChannel],
  clients: [exampleClient],
});
```

Omitting `store` in a loaded project config uses `.simple-agent-orchestrator/state/state.json`.

## Manual channel

```ts
import { createManualChannel } from "simple-agent-orchestrator";

export const manualChannel = createManualChannel("manual");
```

## Generated example client

```ts
import { createClient } from "simple-agent-orchestrator";
import { manualChannel } from "../channels/manual.ts";

export const exampleClient = createClient("example", (client) => {
  client.handle(manualChannel, ({ event, session, logger }) => {
    logger.info("Example client handled event", {
      eventId: event.id,
      sessionId: session.id,
    });
  });
});
```

The example intentionally logs identifiers, not `input`, `payload`, or `meta`. Logs and JSON state are plaintext; keep sensitive content out unless the project has an explicit policy.

## Polling channel

```ts
import { createChannel } from "simple-agent-orchestrator";
import { fetchRecentReviewCandidates } from "../../src/lib/github/reviews.ts";

export const githubReviewsChannel = createChannel("github.reviews", (channel) => {
  channel.poll({
    id: "reviews",
    every: "60s",
    fetch: () => fetchRecentReviewCandidates(),
    map: (review) => ({
      id: review.id,
      dedupeKey: `${review.id}:${review.updatedAt}`,
      sessionKey: `github:${review.repo}:pr:${review.prNumber}`,
      input: review.toMarkdown(),
      payload: review,
      meta: { branch: review.branch },
    }),
  });
});
```

## Retry-safe client

```ts
import { createClient, sessionKey } from "simple-agent-orchestrator";
import { githubReviewsChannel } from "../channels/github.ts";
import { createAgentSession, sendToAgent } from "../../src/lib/agent.ts";

const agentSessionId = sessionKey<string>("agent.sessionId");

export const codingClient = createClient("coding", (client) => {
  client.timeout("10m");
  client.handle(githubReviewsChannel, async ({ event, session, signal }) => {
    const id = await session.ensure(agentSessionId, async () => {
      const created = await createAgentSession({
        idempotencyKey: `agent-session:${session.id}`,
        signal,
      });
      return created.id;
    });

    await sendToAgent(id, String(event.input), {
      idempotencyKey: `agent-message:${event.channelId}:${event.dedupeKey}`,
      signal,
    });
  });
});
```

## Programmatic runtime and tests

```ts
import { createRuntime } from "simple-agent-orchestrator/runtime";

const runtime = await createRuntime(
  { channels: [manualChannel], clients: [exampleClient] },
  { root: process.cwd() },
);
await runtime.start({ http: false });
```

```ts
import { createTestRuntime } from "simple-agent-orchestrator/testing";

const test = await createTestRuntime({
  channels: [manualChannel],
  clients: [exampleClient],
});
try {
  await test.dispatch(manualChannel, { id: "test-1" });
} finally {
  await test.stop();
}
```
