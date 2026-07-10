# Simple Agent Orchestrator API cheatsheet

Use these imports from `simple-agent-orchestrator` unless the project has local wrappers.

## Config

```ts
import { defineConfig } from "simple-agent-orchestrator";

export default defineConfig(({ project }) => ({
  name: String(project.packageJson.name ?? "agent-orchestrator"),
  channels: [manualChannel],
  clients: [codingClient],
}));
```

The config lives at `.simple-agent-orchestrator/orchestrator.ts`.

The `project` helper exposes stable paths:

```ts
project.root;
project.orchestratorDir;
project.fromRoot("src/lib/github");
project.fromOrchestrator("prompts/review.md");
project.statePath("state.json");
```

## Channels

```ts
import { createChannel, createManualChannel } from "simple-agent-orchestrator";

export const manualChannel = createManualChannel("manual");

export const githubReviewsChannel = createChannel("github.reviews", (channel) => {
  channel.poll({
    every: "60s",

    async fetch({ cursor }) {
      const since = cursor.get<string>("lastUpdatedAt");
      return fetchRecentReviewCandidates({ since });
    },

    async map(review) {
      return {
        id: review.id,
        type: "github.review",
        dedupeKey: `github.review:${review.id}:${review.updatedAt}`,
        sessionKey: `github.pr:${review.repo}:${review.prNumber}`,
        input: review.toMarkdown(),
        payload: review,
        meta: {
          repo: review.repo,
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

Event fields:

```ts
type DispatchEvent = {
  id: string;
  type?: string;
  dedupeKey?: string;
  sessionKey?: string;
  input?: unknown;
  payload?: unknown;
  meta?: Record<string, unknown>;
  occurredAt?: string | Date;
};
```

## Clients

```ts
import { createClient } from "simple-agent-orchestrator";

export const codingClient = createClient("coding", (client) => {
  client.useEnvironment(opencodeEnvironment);
  client.concurrency({ workers: 2, perSession: true });
  client.retries({ attempts: 3 });

  client.handle(githubReviewsChannel, {
    id: "coding.githubReviews",

    async handle({ event, session, environment, project, logger, signal }) {
      // Route event to persistent resource.
    },

    async onSuccess({ event }) {
      // Mark the source handled with a stable idempotency key.
    },
  });
});
```

Handler context:

```ts
type HandlerContext = {
  event: OrchestratorEvent;
  session: Session;
  environment: EnvironmentInstance;
  client: ClientDefinition;
  project: ProjectContext;
  logger: Logger;
  attempt: number;
  signal: AbortSignal;
};
```

## Sessions

```ts
import { sessionKey } from "simple-agent-orchestrator";

const agentSessionId = sessionKey<string>("opencode.sessionId");

const id = await session.ensure(agentSessionId, async () => {
  const agentSession = await createAgentSession(serverUrl, {
    idempotencyKey: `agent-session:${session.id}`,
  });
  return agentSession.id;
});

session.set("github.prNumber", event.meta.prNumber);
session.note("Sent review to agent", { reviewId: event.payload.id });
session.end({ reason: "github.pr.merged" });
```

Use `session.ensure` when retries should reuse a persisted value. Its external factory can repeat if creation succeeds before local persistence, so use provider idempotency or reconciliation. Use an environment sandbox when an external resource also needs cleanup; sandbox create and cleanup hooks have the same retry requirement.

Ordinary handler/hook state, notes, and `session.end()` persist only after the complete attempt succeeds. Ensured values and state mutations made during sandbox creation persist eagerly. Cleanup followed by final-persistence failure can require sandbox recreation. Processing is retryable, not exactly once.

## Environments and sandboxes

```ts
import { createEnvironment, envKey } from "simple-agent-orchestrator";

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
    async create({ event, session, project }) {
      const branch = event.meta?.branch;
      if (typeof branch !== "string" || branch.trim() === "") {
        throw new Error("Expected event.meta.branch");
      }

      const worktreeId = await ensureActiveWorktree({
        resourceKey: `worktree:${session.id}`,
        rootDirectory: project.root,
        branch,
      });
      session.set("worktree.id", worktreeId);
    },

    async cleanup({ session }) {
      const worktreeId = session.getOptional<string>("worktree.id");
      if (worktreeId) await closeWorktreeIdempotently(worktreeId);
    },
  });
});
```

## Key helpers

```ts
import { defineKey, sessionKey, envKey } from "simple-agent-orchestrator";

const githubPr = defineKey("github.pr", {
  parts: ["owner", "repo", "number"] as const,
});

const sessionKeyValue = githubPr({ owner: "acme", repo: "api", number: 42 });
```

## Stores

```ts
import { fileStore, memoryStore } from "simple-agent-orchestrator";

export default defineConfig(({ project }) => ({
  store: fileStore(project.statePath("state.json")),
  channels: [],
  clients: [],
}));
```

Use `memoryStore()` in tests. `fileStore()`/`jsonFileStore()` rejects a second active `start` or `drain` for the same state file and reclaims ownership left by a dead PID. Runtime ownership requires a local filesystem with atomic hard-link support and fails startup explicitly when unavailable. The runtime remains single-process because worker, session, poll, and sandbox coordination is process-local; do not run offline mutating commands beside an active JSON-store runtime. Custom stores can opt into the same enforcement with `runtimeLockPath`; omitting it is appropriate only for process-isolated state or a store that independently rejects additional active runtimes, not coordinated multi-runtime execution through the snapshot `Store` API.
