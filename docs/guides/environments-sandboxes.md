# Environments and sandboxes

An environment mounts resources that handlers need, such as local servers, API clients, credentials, or sandboxes.

## Basic environment

```ts
import { createEnvironment, envKey } from "simple-agent-orchestrator";

const opencodeServerUrl = envKey<string>("opencode.serverUrl");

export const opencodeEnvironment = createEnvironment("opencode", (environment) => {
  let shutdown: (() => Promise<void>) | undefined;

  environment.onMount(async ({ environment }) => {
    const server = await startPersistentOpencodeServer();

    environment.set(opencodeServerUrl, server.url);
    shutdown = () => server.shutdown();
  });

  environment.onUnmount(async () => {
    await shutdown?.();
    shutdown = undefined;
  });
});
```

Use it from a client:

```ts
export const codingClient = createClient("coding", (client) => {
  client.useEnvironment(opencodeEnvironment);

  client.handle(githubReviewsChannel, async ({ environment }) => {
    const serverUrl = environment.get(opencodeServerUrl);
  });
});
```

## Sandbox

A sandbox is a session-scoped resource managed by an environment.

```ts
export const opencodeHerdrEnvironment = createEnvironment("opencode-herdr", (environment) => {
  environment.useSandbox({
    async create({ session, event }) {
      const branch = event.meta?.branch;
      if (typeof branch !== "string" || branch.trim() === "") {
        throw new Error("Expected event.meta.branch");
      }

      const worktreeId = await createHerdrWorkTree({
        sourceCheckout: "main",
        branch,
        rootDirectory: "/",
      });

      session.set("herdr.worktreeId", worktreeId);
    },

    async cleanup({ session }) {
      const worktreeId = session.getOptional<string>("herdr.worktreeId");
      if (worktreeId) await closeHerdrWorkTree(worktreeId);
    },
  });
});
```

The runtime creates the sandbox before the first delivery for a session and persists its state before running the handler, so automatic retries reuse it. If the handler calls `session.end()`, sandbox cleanup runs after the handler and `onSuccess` succeed.

Sandbox creation and cleanup are serialized only inside one runtime process. External hooks should still be idempotent because a process can crash between creating a resource and persisting its marker. Administratively ending a session with `sessions end` records the end state but does not run sandbox cleanup.
