# Environments and sandboxes

An environment mounts resources that handlers need, such as local servers, API clients, credentials, or sandboxes.

## Basic environment

```ts
import { createEnvironment, envKey } from "simple-agent-orchestrator";

const opencodeServerUrl = envKey<string>("opencode.serverUrl");

export const opencodeEnvironment = createEnvironment("opencode", (environment) => {
  environment.onMount(async ({ environment }) => {
    const server = await startPersistentOpencodeServer();

    environment.set(opencodeServerUrl, server.url);

    environment.onUnmount(async () => {
      await server.shutdown();
    });
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
      const worktreeId = await createHerdrWorkTree({
        sourceCheckout: "main",
        branch: String(event.meta?.branch),
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

The runtime creates the sandbox before the first delivery for a session. If the handler calls `session.end()`, sandbox cleanup runs after the handler succeeds.
