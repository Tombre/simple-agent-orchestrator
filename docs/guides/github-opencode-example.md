# Connect GitHub reviews to a persistent coding agent

Let's build a review workflow that keeps one coding-agent session and one worktree for each pull request. New review revisions return to the same context, while two different pull requests can run in parallel.

```text
GitHub poll -> review event -> coding client -> pull request session
                                      |
                                      +-> agent server environment
                                      +-> worktree sandbox
```

By the end, you can poll GitHub once with `start --drain`, watch the coding agent handle a review, and inspect the resulting event and session from the CLI.

## Know what the package provides

The orchestrator connects the pieces, but it doesn't include GitHub, OpenCode, or Git worktree adapters.

| Piece | Who provides it | Role in this example |
| --- | --- | --- |
| Channel and poll | This package | Fetch reviews, map them to events, and remember where the next poll should continue |
| Client and handler | This package | Route each review to the coding-agent calls |
| Session | This package | Keep the agent session ID and worktree ID together for one pull request |
| Environment | This package | Start one agent server for the coding client while the process runs |
| Sandbox | This package calls your hooks | Create or reuse one worktree for each pull request session |
| GitHub, agent, and worktree functions | Your project | Talk to real APIs and manage real resources |

Every import from `../../src/` below is **project-provided code**. You'll need to implement those functions for your GitHub client, coding-agent SDK, and worktree manager. Imports from `simple-agent-orchestrator` are package APIs.

## 1. Define stable keys

Use one orchestrator session per pull request. Typed keys make it harder to mix up process-only environment values and saved session values.

```ts
// .simple-agent-orchestrator/keys.ts
import { defineKey, envKey, sessionKey } from "simple-agent-orchestrator";

export const githubPullRequest = defineKey<{
  owner: string;
  repo: string;
  number: number;
}>("github.pr", {
  parts: ["owner", "repo", "number"],
});

export const agentServerUrl = envKey<string>("agent.serverUrl");
export const agentSessionId = sessionKey<string>("agent.sessionId");
export const worktreeId = sessionKey<string>("worktree.id");
```

`githubPullRequest(...)` produces the same session key whenever a review refers to the same owner, repository, and pull request number. The server URL exists only while this process runs. The two session keys are saved and reused by later review events.

## 2. Poll GitHub for review changes

Give the poll an explicit ID so its saved cursor keeps the same identity if you reorganize registrations later.

```ts
// .simple-agent-orchestrator/channels/github.ts
import { createChannel, cursorKey } from "simple-agent-orchestrator";

// Project-provided GitHub adapter.
import { fetchRecentReviews } from "../../src/github.ts";

import { githubPullRequest } from "../keys.ts";

const lastUpdatedAt = cursorKey<string>("lastUpdatedAt");

export const githubReviews = createChannel("github.reviews", (channel) => {
  channel.poll({
    id: "reviews",
    every: "60s",

    fetch({ cursor, signal }) {
      return fetchRecentReviews({
        since: cursor.get(lastUpdatedAt),
        signal,
      });
    },

    map(review) {
      return {
        id: review.id,
        dedupeKey: `${review.id}:${review.updatedAt}`,
        sessionKey: githubPullRequest({
          owner: review.owner,
          repo: review.repo,
          number: review.pullRequestNumber,
        }),
        input: review.toMarkdown(),
        payload: review,
        meta: { branch: review.branch },
      };
    },

    commit({ cursor, items }) {
      const latest = items.map((item) => item.updatedAt).sort().at(-1);
      if (latest) cursor.set(lastUpdatedAt, latest);
    },
  });
});
```

The two event keys do different jobs:

- `dedupeKey` includes `updatedAt`, so a changed review becomes new work but an identical poll result doesn't run twice.
- `sessionKey` identifies only the pull request, so all its review revisions share one agent conversation and worktree.

This sample assumes `updatedAt` values are canonical timestamps whose string order matches time order. If GitHub pagination or your query can return equal timestamps, use the source API's cursor rules and a tie-breaker instead.

The poll maps items one at a time and records each event before `commit` updates the cursor. `commit` confirms local event recording, not successful agent work. If a handler later fails, its delivery retries from the saved event.

## 3. Start the agent server and prepare worktrees

The environment starts one agent server for this client. Its sandbox calls your worktree adapter once for each pull request session, then reuses the recorded worktree on later reviews.

```ts
// .simple-agent-orchestrator/environments/coding.ts
import { createEnvironment } from "simple-agent-orchestrator";

// Project-provided agent-server and worktree adapters.
import { startAgentServer } from "../../src/agent-server.ts";
import { closeWorktree, ensureWorktree } from "../../src/worktrees.ts";

import { agentServerUrl, worktreeId } from "../keys.ts";

export const codingEnvironment = createEnvironment("coding", (environment) => {
  let shutdown: (() => Promise<void>) | undefined;

  environment.onMount(async ({ environment, project, signal }) => {
    const server = await startAgentServer({ cwd: project.root, signal });
    environment.set(agentServerUrl, server.url);
    shutdown = server.shutdown;
  });

  environment.onUnmount(async () => {
    await shutdown?.();
    shutdown = undefined;
  });

  environment.useSandbox({
    async create({ session, event, project, signal }) {
      const branch = event.meta?.branch;
      if (typeof branch !== "string" || branch.trim() === "") {
        throw new Error("Expected event.meta.branch");
      }

      const id = await ensureWorktree({
        resourceKey: `worktree:${session.id}`,
        repository: project.root,
        branch,
        signal,
      });

      session.set(worktreeId, id);
    },

    async cleanup({ session, signal }) {
      const id = session.getOptional(worktreeId);
      if (id) await closeWorktree(id, { signal });
    },
  });
});
```

Implement `ensureWorktree` as a get-or-create call keyed by `resourceKey`. A process can stop after the worktree is created but before its ID is recorded, so a retry may call it again. `closeWorktree` should likewise treat an already-removed worktree as success.

The environment's server is stopped when the runtime stops. The per-session worktree is different: sandbox cleanup runs only after a successful handler calls `session.end()`. The handler below keeps sessions active, which is what makes the worktree persistent across reviews.

## 4. Send each review to the coding agent

Attach the environment, choose concurrency and retry settings, then register the review handler.

```ts
// .simple-agent-orchestrator/clients/coding.ts
import { createClient } from "simple-agent-orchestrator";

// Project-provided coding-agent and GitHub adapters.
import { createAgentSession, sendToAgent } from "../../src/agent.ts";
import { markReviewSeen } from "../../src/github.ts";

import { githubReviews } from "../channels/github.ts";
import { codingEnvironment } from "../environments/coding.ts";
import { agentServerUrl, agentSessionId } from "../keys.ts";

export const codingClient = createClient("coding", (client) => {
  client.useEnvironment(codingEnvironment);
  client.concurrency({ workers: 2, perSession: true });
  client.retries({ attempts: 3, delay: "10s" });
  client.timeout("10m");

  client.handle(githubReviews, {
    id: "process-review",

    async handle({ event, session, environment, signal }) {
      const serverUrl = environment.get(agentServerUrl);
      const externalSessionId = await session.ensure(agentSessionId, async () => {
        const created = await createAgentSession(serverUrl, {
          idempotencyKey: `agent-session:${session.id}`,
          signal,
        });
        return created.id;
      });

      await sendToAgent(serverUrl, externalSessionId, String(event.input), {
        idempotencyKey: `agent-message:${event.channelId}:${event.dedupeKey}`,
        signal,
      });
    },

    async onSuccess({ event, signal }) {
      await markReviewSeen(event.id, {
        idempotencyKey: `source-ack:${event.channelId}:${event.dedupeKey}`,
        signal,
      });
    },
  });
});
```

Here's how those settings affect what you'll see:

- Two workers can process two pull requests at once.
- `perSession: true` keeps this client's reviews for the same pull request from overlapping in this one process.
- Each delivery gets up to three attempts, including the first, with a fixed ten-second delay after a failure.
- The ten-minute timeout covers worktree setup, `handle`, `onSuccess`, and cleanup. Your adapters must observe `signal`; JavaScript can't be forcibly stopped.

`session.ensure(...)` records one external agent session ID for the pull request. A failed attempt keeps a completed `ensure` value, while ordinary session changes from that attempt are discarded.

Both agent calls and `markReviewSeen` can repeat after a timeout, process interruption, cleanup error, or local save error. Their stable idempotency keys must cause your adapters and providers to return the earlier result rather than repeating the effect. Don't include the attempt number in those keys.

Acknowledgement belongs in `onSuccess` so GitHub isn't marked before the agent call succeeds. If you add other handlers for the same event, remember that each gets an independent delivery; this hook doesn't wait for those other handlers.

## 5. Register the channel and client

The config is the final wiring layer:

```ts
// .simple-agent-orchestrator/orchestrator.ts
import { defineConfig } from "simple-agent-orchestrator";
import { githubReviews } from "./channels/github.ts";
import { codingClient } from "./clients/coding.ts";

export default defineConfig({
  channels: [githubReviews],
  clients: [codingClient],
});
```

The channel produces normalized review events. The client subscribes to that channel. The client's environment supplies the process-wide agent server and its sandbox supplies the per-session worktree.

## 6. Run one review cycle

Check the config, poll once, process work that can run now, and inspect the outcome:

```bash
npx simple-agent-orchestrator doctor
npx simple-agent-orchestrator start --drain
npx simple-agent-orchestrator events list
npx simple-agent-orchestrator sessions list
```

After a review is found, expect `events list` to show a `processed` delivery and `sessions list` to show an active session keyed by the pull request. To inspect the agent session and worktree IDs saved in that session, use the ID from the list:

```bash
npx simple-agent-orchestrator sessions show <session-id>
```

If the delivery failed, copy its `deliveryId`, fix the cause, and retry it while the long-running runtime is stopped:

```bash
npx simple-agent-orchestrator events retry <delivery-id>
```

For continuous polling and processing, run:

```bash
npx simple-agent-orchestrator start
```

The default JSON state file allows only one process to make changes at a time. Don't run `dispatch`, `events retry`, `sessions end`, or prune with `--apply` beside that process. Lists and shows are safe.

## 7. Decide when a pull request is finished

This review-only example intentionally never ends the session, so its worktree remains available for later reviews. In a complete integration, add a pull-request closed or merged event and have its successful handler call `session.end()` after any final agent work. That is what triggers sandbox cleanup.

Running `sessions end` from the CLI marks the session ended but does not invoke `closeWorktree`. If operators need administrative cleanup, provide a separate, repeat-safe cleanup command or send a normal event through a handler that ends the session.

## Check the design before shipping

- Review revisions have distinct dedupe keys but share one pull request session.
- One agent server is mounted for the coding client, while each pull request gets its own worktree.
- External agent creation, messaging, acknowledgement, and worktree calls are safe to repeat.
- GitHub acknowledgement happens after the agent handles the review.
- Poll cursor progress doesn't claim that agent work succeeded.
- Every project adapter receives the cancellation signal where supported.
- State, event payloads, notes, cursor values, and errors are stored as plaintext, so don't put GitHub tokens or other secrets in them.

## Next steps

- [Adapt the channel to your event source](channels.md)
- [Test the integration before connecting real providers](testing.md)
- [Review retry behavior for external calls](failure-semantics.md)
