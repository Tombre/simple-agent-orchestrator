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

Mount hooks run in registration order. Shutdown and failed-startup rollback unmount environments in reverse mount order and run each environment's unmount hooks in reverse registration order. Cleanup continues if a hook fails; repeated `stop()` calls retry only hooks that failed. Keep unmount hooks safe to retry because cleanup can fail after partially completing external work.

## Sandbox

A sandbox is a session-scoped resource managed by an environment.

```ts
export const opencodeHerdrEnvironment = createEnvironment("opencode-herdr", (environment) => {
  environment.useSandbox({
    async create({ session, event, signal }) {
      const branch = event.meta?.branch;
      if (typeof branch !== "string" || branch.trim() === "") {
        throw new Error("Expected event.meta.branch");
      }

      const worktreeId = await ensureActiveHerdrWorkTree({
        resourceKey: `worktree:${session.id}`,
        sourceCheckout: "main",
        branch,
        rootDirectory: "/",
        signal,
      });

      session.set("herdr.worktreeId", worktreeId);
    },

    async cleanup({ session, signal }) {
      const worktreeId = session.getOptional<string>("herdr.worktreeId");
      if (worktreeId) await closeHerdrWorkTreeIdempotently(worktreeId, { signal });
    },
  });
});
```

The runtime creates the sandbox before the first delivery for a session and eagerly persists all state mutations made by `create`, so normal handler retries reuse it. If the handler calls `session.end()`, sandbox cleanup runs after the handler and `onSuccess` succeed.

Sandbox hooks receive the delivery attempt signal, including a configured timeout. They must pass it to their own cancellation-aware APIs. Timeout is cooperative and does not force termination. Environment mount and unmount hooks use the runtime shutdown signal and are not covered by handler timeouts.

Sandbox creation and cleanup are serialized only inside one runtime process. Creation can repeat if external work succeeds before its marker is persisted; cleanup can repeat after an uncertain failure. Cleanup can also succeed before final delivery persistence fails, requiring creation of a new active resource on retry. External hooks must reconcile by stable resource identity across create, cleanup, and recreate, rather than blindly replaying an identifier for a resource that may now be closed. Administratively ending a session with `sessions end` records the end state but does not run sandbox cleanup.
