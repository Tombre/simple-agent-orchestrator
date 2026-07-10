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
      const since = await cursor.get<string>("lastUpdatedAt");
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
      if (latest) await cursor.set("lastUpdatedAt", latest);
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
      // Mark source item handled only after successful delivery.
    },
  });
});
```

Handler context:

```ts
type HandlerContext = {
  event: StoredEvent;
  session: Session;
  environment?: EnvironmentRuntime;
  client: ClientDefinition;
  project: ProjectContext;
  logger: Logger;
  attempt: number;
  signal?: AbortSignal;
};
```

## Sessions

```ts
import { sessionKey, createSessionResource } from "simple-agent-orchestrator";

const agentSessionId = sessionKey<string>("opencode.sessionId");

const id = await session.ensure(agentSessionId, async () => {
  const agentSession = await createAgentSession(serverUrl, prompt);
  return agentSession.id;
});

session.set("github.prNumber", event.meta.prNumber);
session.note("Sent review to agent", { reviewId: event.payload.id });
await session.end({ reason: "github.pr.merged" });
```

Use `session.ensure` when a value must be created once per session. Use `session.resource` when the value also needs cleanup.

```ts
const opencodeSession = createSessionResource(agentSessionId, {
  async create({ environment, event }) {
    const serverUrl = environment!.get(opencodeServerUrl);
    const agentSession = await createAgentSession(serverUrl, event.input);
    return agentSession.id;
  },

  async cleanup({ environment, value }) {
    const serverUrl = environment!.get(opencodeServerUrl);
    await closeAgentSession(serverUrl, value);
  },
});

client.useResource(opencodeSession);
const id = await session.resource(opencodeSession);
```

## Environments and sandboxes

```ts
import { createEnvironment, envKey } from "simple-agent-orchestrator";

export const opencodeServerUrl = envKey<string>("opencode.serverUrl");

export const opencodeEnvironment = createEnvironment("opencode", (environment) => {
  environment.onMount(async ({ project }) => {
    const server = await startPersistentOpencodeServer({ cwd: project.root });
    environment.set(opencodeServerUrl, server.url);
    environment.onUnmount(() => server.shutdown());
  });

  environment.useSandbox({
    async create({ event, session, project }) {
      const worktreeId = await createWorktree({
        rootDirectory: project.root,
        branch: String(event.meta.branch),
      });
      session.set("worktree.id", worktreeId);
    },

    async cleanup({ session }) {
      const worktreeId = session.get<string>("worktree.id");
      if (worktreeId) await closeWorktree(worktreeId);
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

Use `memoryStore()` in tests. Use a stronger Store adapter for multi-process production.
