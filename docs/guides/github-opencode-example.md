# Connect GitHub reviews to a persistent coding agent

Let's build a review workflow that keeps one coding-agent session and one worktree for each pull request. New review revisions return to the same context, while two different pull requests can run in parallel.

```text
GitHub poll -> review event -> coding client -> pull request session
                                       |
                                       +-> typed worktree + OpenCode process sandbox
```

By the end, you can poll GitHub once with `start --drain`, watch the coding agent handle a review, and inspect the resulting event and session from the CLI.

## Know what the package provides

The orchestrator connects the pieces, but it doesn't include GitHub, OpenCode, or Git worktree adapters.

| Piece | Who provides it | Role in this example |
| --- | --- | --- |
| Channel and poll | This package | Fetch reviews, map them to events, and remember where the next poll should continue |
| Client and handler | This package | Route each review to the coding-agent calls |
| Session | This package | Keep the agent conversation ID for one pull request |
| Environment and sandbox | This package calls your hooks | Save one typed worktree and OpenCode process resource per pull request |
| Managed process helpers | This package | Spawn the detached process and safely adopt its saved POSIX group or Windows PID during cleanup |
| GitHub, OpenCode, ownership, and worktree functions | Your project | Talk to real APIs and verify real resource identity |

Every import from `../../src/` below is **project-provided code**. You'll need to implement those functions for your GitHub client, coding-agent SDK, and worktree manager. Imports from `simple-agent-orchestrator` are package APIs.

## 1. Define stable keys

Use one orchestrator session per pull request. Typed keys make it harder to mix up process-only environment values and saved session values.

```ts
// .simple-agent-orchestrator/keys.ts
import { defineKey, sessionKey } from "simple-agent-orchestrator";

export const githubPullRequest = defineKey<{
  owner: string;
  repo: string;
  number: number;
}>("github.pr", {
  parts: ["owner", "repo", "number"],
});

export const agentSessionId = sessionKey<string>("agent.sessionId");
```

`githubPullRequest(...)` produces the same session key whenever a review refers to the same owner, repository, and pull request number. The agent conversation ID is saved in session state. The worktree and process identity belong to the typed sandbox resource shown below.

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

The poll maps items one at a time. A map may return one event or an array; the runtime records the flattened events sequentially before `commit` updates the cursor. `commit` confirms local event recording, not successful agent work. If a handler later fails, its delivery retries from the saved event.

## 3. Create a typed worktree and OpenCode process

The environment owns one sandbox for each pull request session. Its saved resource contains everything later handlers and cleanup need: the worktree, the OpenCode endpoint, and an ownership token stronger than a PID.

```ts
// .simple-agent-orchestrator/environments/coding.ts
import { createEnvironment, createSandbox } from "simple-agent-orchestrator";
import { adoptManagedProcess } from "simple-agent-orchestrator/node";

// Project-provided OpenCode, process-ownership, and worktree adapters.
import {
  findOpencodeProcess,
  opencodeProcessStillMatches,
  startOpencodeProcess,
} from "../../src/opencode.ts";
import {
  closeWorktree,
  ensureWorktree,
  findWorktree,
  worktreeExists,
} from "../../src/worktrees.ts";

type CodingResource = {
  worktreeId: string;
  worktreePath: string;
  opencode?: {
    url: string;
    pid: number;
    ownershipToken: string;
  };
};

export const codingSandbox = createSandbox<CodingResource>({
  async create({ session, event, project, signal, publishResource }) {
    const branch = event.meta?.branch;
    if (typeof branch !== "string" || branch.trim() === "") {
      throw new Error("Expected event.meta.branch");
    }

    const worktree = await ensureWorktree({
      resourceKey: `worktree:${session.id}`,
      repository: project.root,
      branch,
      signal,
    });
    await publishResource({
      worktreeId: worktree.id,
      worktreePath: worktree.path,
    });

    const opencode = await startOpencodeProcess({
      resourceKey: `opencode:${session.id}`,
      cwd: worktree.path,
      signal,
    });

    await publishResource({
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      opencode: {
        url: opencode.url,
        pid: opencode.pid,
        ownershipToken: opencode.ownershipToken,
      },
    });
  },

  async reconcile({ resource, currentStatus, cause, session, project, signal, publishResource }) {
    const savedWorktreeActive = resource
      ? await worktreeExists(resource.worktreeId, { signal })
      : false;
    const worktree = savedWorktreeActive
      ? { id: resource!.worktreeId, path: resource!.worktreePath }
      : await findWorktree({
          resourceKey: `worktree:${session.id}`,
          repository: project.root,
          signal,
        });
    let opencode = resource?.opencode &&
        await opencodeProcessStillMatches(resource.opencode.pid, resource.opencode.ownershipToken)
      ? resource.opencode
      : await findOpencodeProcess({
          resourceKey: `opencode:${session.id}`,
          signal,
    });
    if (!worktree && !opencode) return "cleaned";
    if (!worktree) return "unknown";

    if (!opencode && cause.type === "delivery" && currentStatus === "creating") {
      opencode = await startOpencodeProcess({
        resourceKey: `opencode:${session.id}`,
        cwd: worktree.path,
        signal,
      });
    }
    if (!opencode && cause.type === "completion") {
      await publishResource({ worktreeId: worktree.id, worktreePath: worktree.path });
      return "active";
    }
    if (!opencode) return "unknown";

    await publishResource({
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      opencode: {
        url: opencode.url,
        pid: opencode.pid,
        ownershipToken: opencode.ownershipToken,
      },
    });
    return "active";
  },

  async cleanup({ cleanup }) {
    await cleanup.step("stop-opencode", { retry: "idempotent" }, async ({ resource }) => {
      if (!resource.opencode) return;
      const processHandle = adoptManagedProcess(resource.opencode.pid, {
        ownsProcess: (pid) => opencodeProcessStillMatches(pid, resource.opencode!.ownershipToken),
      });
      await processHandle.stop();
    });

    await cleanup.step("remove-worktree", { retry: "idempotent" }, async ({ resource, signal }) => {
      await closeWorktree(resource.worktreeId, { signal });
    });
  },
});

export const codingEnvironment = createEnvironment("coding", (environment) => {
  environment.useSandbox(codingSandbox);
});
```

Every function imported from `../../src/` is project code. The package does not provide GitHub, OpenCode, worktree, process discovery, or ownership-token APIs. Implement `ensureWorktree` and `startOpencodeProcess` as get-or-create operations keyed by `resourceKey`, make `closeWorktree` treat an already-removed worktree as success, and make the ownership check return true only for the process represented by the saved token. On POSIX, `startOpencodeProcess` must create a detached process group and return its leader PID so later adoption refers to the same group; `spawnManagedProcess` is the package helper for that launch pattern.

The first `publishResource` saves the worktree identity before process startup. If startup fails, `reconcile` can discover or restart the missing process and publish the complete resource. During administrative completion, it can instead return the partial resource as active so cleanup removes the worktree without starting a process only to stop it. The second publication replaces the saved resource after startup succeeds.

The adopted-process ownership check is mandatory. On POSIX, `adoptManagedProcess` signals only the saved process group and never falls back to a positive PID; on Windows it targets the PID. It rechecks ownership before KILL escalation. The `stop-opencode` step is marked idempotent because the project ownership check and adopted handle make an already-stopped target a successful no-op.

Every outside cleanup effect is inside a step because typed cleanup is re-entered directly from `cleaning`. The worktree step waits for the OpenCode step because removing a working directory while the process uses it would be unsafe. This narrow step mechanism is not a general workflow engine and does not make other handling exactly once.

## 4. Send each review to the coding agent

Attach the environment, choose concurrency and retry settings, then register the review handler.

```ts
// .simple-agent-orchestrator/clients/coding.ts
import { createClient } from "simple-agent-orchestrator";

// Project-provided coding-agent and GitHub adapters.
import { createAgentSession, sendToAgent } from "../../src/agent.ts";
import { markReviewSeen } from "../../src/github.ts";

import { githubReviews } from "../channels/github.ts";
import {
  codingEnvironment,
  codingSandbox,
} from "../environments/coding.ts";
import { agentSessionId } from "../keys.ts";

export const codingClient = createClient("coding", (client) => {
  client.useEnvironment(codingEnvironment);
  client.concurrency({ workers: 2, perSession: true });
  client.retries({ attempts: 3, delay: "10s" });
  client.timeout("10m");

  client.handle(githubReviews, {
    id: "process-review",

    async handle({ event, session, sandbox, signal }) {
      const resource = sandbox.get(codingSandbox);
      if (!resource.opencode) throw new Error("Active coding sandbox has no OpenCode process");
      const externalSessionId = await session.ensure(agentSessionId, async () => {
        const created = await createAgentSession(resource.opencode.url, {
          idempotencyKey: `agent-session:${session.id}`,
          signal,
        });
        return created.id;
      });

      await sendToAgent(resource.opencode.url, externalSessionId, String(event.input), {
        cwd: resource.worktreePath,
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

`sandbox.get(codingSandbox)` requires the exact typed definition configured on this client and returns its readonly `CodingResource`. `session.ensure(...)` records one external agent conversation ID for the pull request. A failed `handle` call keeps a completed `ensure` value but discards ordinary changes that didn't reach the handling checkpoint. After `handle` succeeds, ordinary changes stay staged on the delivery until acknowledgement, cleanup, and saving finish.

An agent call can repeat if handling fails or is interrupted before its checkpoint. `markReviewSeen` can repeat if acknowledgement fails or is interrupted before its checkpoint. A later cleanup or local-save failure resumes that later phase without repeating either call. Keep stable idempotency keys anyway: the runtime can't atomically save a checkpoint with an outside API response. Don't include the attempt number in those keys.

This example awaits `sendToAgent`, so its two workers limit the calls currently in progress. If your adapter returns immediately while each coding agent keeps running, configure `client.capacity({ maxActiveSessions: 2 })` instead to retain those two slots until a completion event calls `capacity.release()` or ends the session. See [limit active fire-and-forget agents](clients.md#limit-active-fire-and-forget-agents).

Acknowledgement belongs in `onSuccess` so GitHub isn't marked before the agent call succeeds. If you add other handlers for the same event, remember that each gets an independent delivery; this hook doesn't wait for those other handlers.

## 5. Register the client

Register the client in `orchestrator.ts`:

```ts
// .simple-agent-orchestrator/orchestrator.ts
import { defineConfig } from "simple-agent-orchestrator";
import { codingClient } from "./clients/coding.ts";

export default defineConfig({
  clients: [codingClient],
});
```

The channel produces normalized review events. The client subscribes to that channel. Its environment supplies one typed worktree and OpenCode process resource for each pull request session.

## 6. Run one review cycle

Check the config, poll once, process work that can run now, and inspect the outcome:

```bash
npx simple-agent-orchestrator doctor
npx simple-agent-orchestrator start --drain
npx simple-agent-orchestrator events list
npx simple-agent-orchestrator sessions list
```

After a review is found, expect `events list` to show a `processed` delivery and `sessions list` to show an active session keyed by the pull request. To inspect the saved agent conversation and typed sandbox resource, use the ID from the list:

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

The default JSON state file allows only one process to make changes at a time. Don't run `dispatch`, `events retry`, `sessions end`, `sessions complete`, `capacity release`, or prune with `--apply` beside that process. Lists and shows, including `capacity list`, are safe.

## 7. Decide when a pull request is finished

This review-only example intentionally never ends the session, so its OpenCode process and worktree remain available for later reviews. In a complete integration, route a pull-request closed or merged event to the existing session without creating a replacement:

```ts
client.handle(pullRequestsMerged, {
  id: "finish-pull-request",
  session: "existing-only",
  handle({ session }) {
    session.end();
  },
});
```

`pullRequestsMerged` is a project-defined channel whose events use the same pull-request `sessionKey`. Calling `session.end()` triggers the adopted-process and worktree cleanup steps. A late merge event with no active session is ignored instead of creating a new worktree and process.

Running `sessions end` from the CLI marks the session ended but does not invoke `closeWorktree`. Use `sessions complete <session-id>` when operators need the configured sandbox cleanup to finish before the session ends.

## Check the design before shipping

- Review revisions have distinct dedupe keys but share one pull request session.
- Each pull request gets one typed worktree and OpenCode process resource.
- Adopted cleanup verifies process ownership before signaling and again before KILL escalation.
- Every outside cleanup effect is inside a durable sandbox cleanup step.
- External agent creation, messaging, acknowledgement, and worktree calls are safe to repeat.
- GitHub acknowledgement happens after the agent handles the review.
- Poll cursor progress doesn't claim that agent work succeeded.
- Every project adapter receives the cancellation signal where supported.
- State, event payloads, notes, cursor values, and errors are stored as plaintext, so don't put GitHub tokens or other secrets in them.

## Next steps

- [Adapt the channel to your event source](channels.md)
- [Test the integration before connecting real providers](testing.md)
- [Review retry behavior for external calls](failure-semantics.md)
