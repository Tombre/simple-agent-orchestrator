# Simple Agent Orchestrator templates

Use these as starting points. Adapt imports to the project’s existing code.

## Directory scaffold

```txt
.simple-agent-orchestrator/
  orchestrator.ts
  channels/
    manual.ts
  clients/
    coding.ts
  environments/
    opencode.ts
  prompts/
  state/.gitignore
  logs/.gitignore
  tmp/.gitignore
```

Each `.gitignore` in `state`, `logs`, and `tmp` should contain:

```gitignore
*
!.gitignore
```

## `orchestrator.ts`

```ts
import { defineConfig } from "simple-agent-orchestrator";

import { manualChannel } from "./channels/manual";
import { codingClient } from "./clients/coding";

export default defineConfig(({ project }) => ({
  name: String(project.packageJson.name ?? "agent-orchestrator"),
  channels: [manualChannel],
  clients: [codingClient],
}));
```

## Manual channel

```ts
import { createManualChannel } from "simple-agent-orchestrator";

export const manualChannel = createManualChannel("manual");
```

## Minimal client

```ts
import { createClient, sessionKey } from "simple-agent-orchestrator";

import { manualChannel } from "../channels/manual";

const fakeAgentSessionId = sessionKey<string>("fakeAgent.sessionId");

export const codingClient = createClient("coding", (client) => {
  client.handle(manualChannel, async ({ event, session, logger }) => {
    const agentSessionId = await session.ensure(fakeAgentSessionId, async () => {
      return `fake-agent-${session.id}`;
    });

    session.note("Handled manual event", { agentSessionId, input: event.input });
    logger.info("Manual event handled", { sessionId: session.id, agentSessionId });
  });
});
```

## GitHub review channel

```ts
import { createChannel, defineKey } from "simple-agent-orchestrator";
import { fetchRecentReviewCandidates } from "../../src/lib/github";

const githubPr = defineKey("github.pr", {
  parts: ["owner", "repo", "number"] as const,
});

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
        type: "github.review",
        dedupeKey: `github.review:${review.id}:${review.updatedAt}`,
        sessionKey: githubPr({
          owner: review.owner,
          repo: review.repo,
          number: review.prNumber,
        }),
        input: review.toMarkdown(),
        payload: review,
        meta: {
          owner: review.owner,
          repo: review.repo,
          branch: review.branch,
          prNumber: review.prNumber,
        },
      };
    },

    async commit({ cursor, items }) {
      const latest = items.map((review) => review.updatedAt).sort().at(-1);
      if (latest) cursor.set("lastUpdatedAt", latest);
    },
  });
});
```

## Persistent coding client

```ts
import {
  createClient,
  sessionKey,
} from "simple-agent-orchestrator";
import { githubReviewsChannel } from "../channels/github";
import { opencodeEnvironment, opencodeServerUrl } from "../environments/opencode";
import { createAgentSession, sendToAgent } from "../../src/lib/opencode";

const opencodeSessionId = sessionKey<string>("opencode.sessionId");

export const codingClient = createClient("coding", (client) => {
  client.useEnvironment(opencodeEnvironment);
  client.concurrency({ workers: 2, perSession: true });
  client.timeout("10m");

  client.handle(githubReviewsChannel, {
    id: "coding.githubReviews",

    async handle({ event, session, environment, signal }) {
      const serverUrl = environment.get(opencodeServerUrl);
      const agentSessionId = await session.ensure(opencodeSessionId, async () => {
        const agentSession = await createAgentSession(serverUrl, {
          idempotencyKey: `agent-session:${session.id}`,
          signal,
        });
        return agentSession.id;
      });
      await sendToAgent(serverUrl, agentSessionId, event.input, {
        idempotencyKey: `agent-message:${event.channelId}:${event.dedupeKey}`,
        signal,
      });
    },

    async onSuccess({ event }) {
      // Mark the source handled here with a stable idempotency key.
    },
  });
});
```

## Environment with sandbox

```ts
import { createEnvironment, envKey } from "simple-agent-orchestrator";
import { startPersistentOpencodeServer } from "../../src/lib/opencode";
import { closeWorktreeIdempotently, ensureActiveWorktree } from "../../src/lib/worktrees";

export const opencodeServerUrl = envKey<string>("opencode.serverUrl");

export const opencodeEnvironment = createEnvironment("opencode", (environment) => {
  let shutdown: (() => Promise<void>) | undefined;

  environment.onMount(async ({ environment, project }) => {
    const server = await startPersistentOpencodeServer({ cwd: project.root });
    environment.set(opencodeServerUrl, server.url);
    shutdown = () => server.shutdown();
  });

  environment.onUnmount(async () => {
    await shutdown?.();
    shutdown = undefined;
  });

  environment.useSandbox({
    async create({ event, session, project, signal }) {
      const branch = event.meta?.branch;
      if (typeof branch !== "string" || branch.trim() === "") {
        throw new Error("Expected event.meta.branch");
      }

      const worktreeId = await ensureActiveWorktree({
        resourceKey: `worktree:${session.id}`,
        rootDirectory: project.root,
        sourceCheckout: "main",
        branch,
        signal,
      });
      session.set("worktree.id", worktreeId);
    },

    async cleanup({ session, signal }) {
      const worktreeId = session.getOptional<string>("worktree.id");
      if (worktreeId) await closeWorktreeIdempotently(worktreeId, { signal });
    },
  });
});
```
