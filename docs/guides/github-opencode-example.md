# GitHub review to persistent coding agent example

This guide shows the intended integration style for a GitHub review workflow.

The framework does not ship GitHub or opencode integrations. You import your existing project code and wire it into channels and clients.

## Keys

```ts
// .simple-agent-orchestrator/keys.ts
import { defineKey, envKey, sessionKey } from "simple-agent-orchestrator";

export const githubPrSession = defineKey<{
  owner: string;
  repo: string;
  number: number;
}>("github.pr", {
  parts: ["owner", "repo", "number"],
});

export const opencodeServerUrl = envKey<string>("opencode.serverUrl");
export const opencodeSessionId = sessionKey<string>("opencode.sessionId");
export const herdrWorktreeId = sessionKey<string>("herdr.worktreeId");
```

## Channel

```ts
// .simple-agent-orchestrator/channels/github.ts
import { createChannel } from "simple-agent-orchestrator";
import { fetchRecentReviewCandidates } from "../../src/lib/github/reviews";
import { githubPrSession } from "../keys";

export const githubReviewsChannel = createChannel("github.reviews", (channel) => {
  channel.poll({
    every: "60s",

    async fetch({ cursor }) {
      return fetchRecentReviewCandidates({
        since: cursor.get<string>("lastReviewUpdatedAt"),
      });
    },

    async map(review) {
      return {
        id: review.id,
        dedupeKey: `github.review:${review.id}:${review.updatedAt}`,
        sessionKey: githubPrSession({
          owner: review.owner,
          repo: review.repo,
          number: review.prNumber,
        }),
        input: review.toMarkdown(),
        payload: review,
        meta: {
          owner: review.owner,
          repo: review.repo,
          prNumber: review.prNumber,
          branch: review.branch,
        },
      };
    },

    async commit({ cursor, items }) {
      const latest = items.map((item) => item.updatedAt).sort().at(-1);
      if (latest) cursor.set("lastReviewUpdatedAt", latest);
    },
  });
});
```

## Environment

```ts
// .simple-agent-orchestrator/environments/opencode-herdr.ts
import { createEnvironment } from "simple-agent-orchestrator";
import { startPersistentOpencodeServer } from "../../src/lib/opencode/server";
import {
  closeHerdrWorkTreeIdempotently,
  ensureActiveHerdrWorkTree,
} from "../../src/lib/herdr/worktrees";
import { herdrWorktreeId, opencodeServerUrl } from "../keys";

export const opencodeHerdrEnvironment = createEnvironment("opencode-herdr", (environment) => {
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
    async create({ session, event, project }) {
      const branch = event.meta?.branch;
      if (typeof branch !== "string" || branch.trim() === "") {
        throw new Error("Expected event.meta.branch");
      }

      const worktreeId = await ensureActiveHerdrWorkTree({
        resourceKey: `worktree:${session.id}`,
        rootDirectory: project.root,
        sourceCheckout: "main",
        branch,
      });

      session.set(herdrWorktreeId, worktreeId);
    },

    async cleanup({ session }) {
      const worktreeId = session.getOptional(herdrWorktreeId);
      if (worktreeId) await closeHerdrWorkTreeIdempotently(worktreeId);
    },
  });
});
```

## Client

```ts
// .simple-agent-orchestrator/clients/coding.ts
import { createClient } from "simple-agent-orchestrator";
import { githubReviewsChannel } from "../channels/github";
import { opencodeHerdrEnvironment } from "../environments/opencode-herdr";
import { opencodeServerUrl, opencodeSessionId } from "../keys";
import { createAgentSession, sendToAgent } from "../../src/lib/opencode/agent";
import { markReviewSeen } from "../../src/lib/github/reviews";

export const codingClient = createClient("coding", (client) => {
  client.useEnvironment(opencodeHerdrEnvironment);
  client.concurrency({ workers: 2, perSession: true });

  client.handle(githubReviewsChannel, {
    retries: { attempts: 3 },

    async handle({ event, session, environment }) {
      const serverUrl = environment.get(opencodeServerUrl);

      const agentSessionId = await session.ensure(opencodeSessionId, async () => {
        const created = await createAgentSession(serverUrl, {
          idempotencyKey: `agent-session:${session.id}`,
        });

        return created.id;
      });

      await sendToAgent(serverUrl, agentSessionId, String(event.input), {
        idempotencyKey: `agent-message:${event.channelId}:${event.dedupeKey}`,
      });
    },

    async onSuccess({ event }) {
      await markReviewSeen(event.payload, {
        idempotencyKey: `source-ack:${event.channelId}:${event.dedupeKey}`,
      });
    },
  });
});
```

The project-owned agent and source functions must honor these keys or reconcile by stable identity. A retry can rerun both `handle` and `onSuccess`; event dedupe alone does not dedupe those external operations.

## Config

```ts
// .simple-agent-orchestrator/orchestrator.ts
import { defineConfig, jsonFileStore } from "simple-agent-orchestrator";
import { githubReviewsChannel } from "./channels/github";
import { codingClient } from "./clients/coding";

export default defineConfig(({ project }) => ({
  store: jsonFileStore(project.statePath("state.json")),
  channels: [githubReviewsChannel],
  clients: [codingClient],
}));
```
