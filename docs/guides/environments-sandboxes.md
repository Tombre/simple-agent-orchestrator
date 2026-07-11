# Manage resources with environments and sandboxes

Your handler may need an API client shared by all its work, or a separate worktree for every pull request. Environments and sandboxes cover those two cases:

- An **environment** holds values and resources for one client while the runtime process is running, such as an API client or local server.
- A **sandbox** creates and tracks one external resource for each session, such as a worktree or remote workspace, so retries can reuse it.

Environment values disappear when the process stops. Sandbox creation details are saved with the session so a later retry can see that creation completed; with the project JSON store, that information is also available after a restart.

## Share a process resource with your handlers

Suppose every coding handler needs the same local agent server. Create it when the client starts and expose its URL:

```ts
// .simple-agent-orchestrator/environments/agent.ts
import { createEnvironment, envKey } from "simple-agent-orchestrator";
import { startAgentServer } from "../../src/agent.ts";

export const agentServerUrl = envKey<string>("agent.serverUrl");

export const agentEnvironment = createEnvironment("agent", (environment) => {
  let shutdown: (() => Promise<void>) | undefined;

  environment.onMount(async ({ environment, project, signal }) => {
    const server = await startAgentServer({
      cwd: project.root,
      signal,
    });

    environment.set(agentServerUrl, server.url);
    shutdown = server.shutdown;
  });

  environment.onUnmount(async () => {
    await shutdown?.();
    shutdown = undefined;
  });
});
```

Attach it to a client and read the value in a handler:

```ts
export const codingClient = createClient("coding", (client) => {
  client.useEnvironment(agentEnvironment);

  client.handle(reviewsChannel, async ({ environment }) => {
    const serverUrl = environment.get(agentServerUrl);
    // Send work to the mounted server.
  });
});
```

Each client gets a separate environment instance, even when clients use the same environment. An instance is identified by both client ID and environment ID. A client can use at most one environment; calling `useEnvironment` again replaces the previous choice.

Register `onUnmount` while creating the environment, as shown above. Mount functions run in registration order. During shutdown, environments are unmounted in reverse mount order, and each environment's unmount functions run in reverse registration order. This lets you start dependencies first and stop them last.

If one cleanup function fails, the runtime continues running the others. A later `stop()` retries cleanup that didn't finish, so write unmount code that can safely run again.

Environment values aren't written to the JSON state file. Recreate them every time the runtime starts, and don't expect a value set by one process to appear in another.

Environment registrations are captured when the runtime initializes. If you add a mount function, change the sandbox, or attach a different environment afterward, create a new runtime to apply that change.

## Give each session its own workspace

Now suppose each pull request needs a worktree. Add one sandbox to the client's environment:

```ts
import { createEnvironment, sessionKey } from "simple-agent-orchestrator";

const worktreeId = sessionKey<string>("worktree.id");

export const codingEnvironment = createEnvironment("coding", (environment) => {
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

A **delivery** is one handler's saved work record for an event, including its attempts and result. The runtime calls `create` before the handler on the first delivery that uses this environment for the session. When `create` finishes, its session changes and a marker saying creation completed are saved immediately. If the handler later fails, a retry reuses that information instead of intentionally creating another sandbox.

Only one sandbox can be configured on an environment. A later `useSandbox` call replaces the earlier one.

Choose event data used by `create` carefully. Creation normally happens on the first delivery for a session, so later events with a different branch or workspace request won't recreate the sandbox automatically.

## Clean up after the session ends

Call `session.end()` in the handler when the work is complete. Sandbox cleanup runs as part of that delivery only after all three conditions are met:

1. `handle` succeeds.
2. `onSuccess` succeeds.
3. The handler called `session.end()`.

Cleanup must also succeed before the delivery is marked processed and the ordinary session changes are saved. If cleanup throws, the attempt fails and follows the handler's retry rules.

Ending a session through `sessions end` or `runtime.endSession()` does not call sandbox cleanup. If you end it administratively, remove the external workspace yourself. Stopping the runtime only unmounts process environments; it doesn't walk through active sessions and clean their sandboxes.

State pruning also doesn't clean external workspaces. It keeps an ended session while its sandbox marker still says the sandbox is active. Prefer ending through a handler when cleanup is required; if you've already ended it administratively, clean the external resource yourself and don't expect pruning to remove that saved session automatically.

## Make creation and cleanup safe to repeat

The runtime saves what it knows, but it can't save an external API change and the local session update as one indivisible operation. If the process stops between those two actions, the next attempt can't know exactly what happened.

Plan for these cases:

| If this happens | Expect this consequence | What your code should do |
| --- | --- | --- |
| The worktree is created, then the process stops before saving | `create` may run again | Find or create by a stable key such as `worktree:${session.id}`. |
| Cleanup succeeds, then the process stops before saving the attempt | A retry may create a replacement sandbox | Treat an already-missing worktree as cleaned, and make replacement creation safe. |
| Cleanup changes part of the resource and then fails | `cleanup` may run again | Check the current external state and finish the desired cleanup. |
| The process exits during either function | Local records may not match the provider | Look up the resource by the stable key before changing it. |

Locks prevent two deliveries from creating or cleaning the same session sandbox at once only inside one runtime process. They don't coordinate separate processes.

Sandbox markers use the environment ID, not the client ID. If two clients can handle the same session and use environments with the same ID, their markers can collide. Give those environments different IDs.

## Respond to timeouts and shutdown

Sandbox `create` and `cleanup` receive the delivery attempt's `signal`. Pass it to external APIs and subprocesses. A handler timeout or runtime shutdown can abort it, but JavaScript can't forcibly stop code that ignores cancellation.

The handler timeout includes sandbox creation and cleanup. If either operation times out, the attempt follows ordinary retry rules, so the operation still needs to be safe to repeat.

Environment mount and unmount functions receive the runtime shutdown signal. Handler timeouts don't apply to those process-level functions. During shutdown, cancellation takes precedence over a later attempt timeout, and the runtime waits for cancellation-aware work to settle.

## Next steps

- [Make external changes safe to repeat](failure-semantics.md)
- [Test your integration](testing.md)
- [Look up the Environment API](../api-reference.md#environments-and-sandboxes)
