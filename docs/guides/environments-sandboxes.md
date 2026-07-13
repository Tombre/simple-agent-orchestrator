# Manage resources with environments and sandboxes

Your handler may need an API client shared by all its work, or a separate worktree for every pull request. Environments and sandboxes cover those two cases:

- An **environment** holds values and resources for one client while the runtime process is running, such as an API client or local server.
- A **sandbox** creates and tracks one external resource for each session, such as a worktree or remote workspace, so retries can reuse it.

Environment values disappear when the process stops. Each sandbox has its own saved record, identified by session, client, and environment. It keeps lifecycle status, a JSON-safe typed resource, checkpoint data, and cleanup-step progress across retries and restarts.

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
import { createEnvironment, createSandbox } from "simple-agent-orchestrator";

type WorktreeResource = {
  id: string;
  path: string;
};

export const worktreeSandbox = createSandbox<WorktreeResource>({
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

    // Save the identity before doing more work that could fail.
    await publishResource({ id: worktree.id, path: worktree.path });
  },

  async reconcile({ resource, currentStatus, session, project, signal, publishResource }) {
    if (resource && await worktreeExists(resource.id, { signal })) return "active";

    const worktree = await findWorktree({
      resourceKey: `worktree:${session.id}`,
      repository: project.root,
      signal,
    });
    if (!worktree) return currentStatus === "cleaning" ? "cleaned" : "unknown";

    if (!resource) {
      await publishResource({ id: worktree.id, path: worktree.path });
    }
    return "active";
  },

  async cleanup({ cleanup }) {
    await cleanup.step("remove-worktree", { retry: "idempotent" }, async ({ resource, signal }) => {
      await closeWorktree(resource.id, { signal });
    });
  },
});

export const codingEnvironment = createEnvironment("coding", (environment) => {
  environment.useSandbox(worktreeSandbox);
});
```

`ensureWorktree`, `findWorktree`, `worktreeExists`, and `closeWorktree` are project functions, not package APIs. Their stable `resourceKey` and lookup behavior are what make creation recoverable.

A **delivery** is one handler's saved work record for an event, including its attempts and result. Before calling `create`, the runtime saves a `creating` sandbox record. `publishResource(resource)` immediately saves the JSON-safe resource, even if later code in `create` fails. You can instead return the resource from `create`; that shorter pattern publishes it after the function resolves:

```ts
export const worktreeSandbox = createSandbox({
  async create(context) {
    const worktree = await createWorktreeFor(context.session.id);
    return { id: worktree.id, path: worktree.path };
  },
});
```

Use the eager `publishResource` pattern when you need the identity saved before the rest of creation finishes. Use the returned pattern when creation is one retry-safe operation. Either way, the resource must be JSON-safe. `undefined` means no resource was returned, while `null` is a valid resource if the definition's type allows it.

When `create` finishes with a published resource, the status becomes `active` and its session changes are saved immediately. If creation was interrupted, `reconcile` receives `resource` when one was saved, plus `currentStatus` and the checkpoint. It may call `publishResource` to recover an older or partially saved record. Reporting `active` without a resource is an error.

Only one sandbox can be configured on an environment. A later `useSandbox` call replaces the earlier one.

Choose event data used by `create` carefully. Creation normally happens on the first delivery for a session, so later events with a different branch or workspace request won't recreate the sandbox automatically.

## Read the typed resource in a handler

The sandbox definition is also its typed handle:

```ts
export const codingClient = createClient("coding", (client) => {
  client.useEnvironment(codingEnvironment);

  client.handle(reviewsChannel, async ({ sandbox }) => {
    const worktree = sandbox.get(worktreeSandbox);
    await runAgentIn(worktree.path);
  });
});
```

`sandbox.get(worktreeSandbox)` returns a readonly value with the type inferred by `createSandbox`. It throws unless the same definition object was configured on this client's environment and its saved resource is active. `getOptional` performs the same definition-identity check but returns `undefined` when no active resource exists. A resumed cleanup attempt also retains the resource in the `onFailure` context so failure reporting can identify what cleanup was handling.

An `existing-only` handler does not create or reconcile a sandbox before handling. It can read a resource already active for that exact session and client. With no active record, `getOptional` returns `undefined` and `get` throws. An invalid `active` typed record with no resource fails before the handler runs. If the handler calls `session.end()`, the later cleanup phase may reconcile uncertain saved state before cleanup; it still does not create a replacement session for a late event.

## Clean up after the session ends

Call `session.end()` in the handler when the work is complete. Sandbox cleanup runs as part of that delivery only after all three conditions are met:

1. `handle` succeeds.
2. `onSuccess` succeeds.
3. The handler called `session.end()`.

Cleanup must also succeed before the delivery is marked processed and the staged ordinary session changes are committed. If cleanup throws, the attempt fails and retries cleanup without rerunning `handle` or `onSuccess`.

Ending a session through `sessions end` or `runtime.endSession()` is still metadata-only: it releases retained capacity without sandbox cleanup. Use `sessions complete <session-id>` or `runtime.completeSession(sessionId)` when the runtime should mount the recorded environments and run cleanup. Completion requires the exact active session ID and rejects while pending or processing deliveries target that session or its key. It ends the session only after every cleanup succeeds. A failed cleanup leaves the session active and retains capacity.

Typed cleanup can safely re-enter from a saved `cleaning` record because each outside effect belongs to a durable step. Sandbox-level `reconcile` still runs when the sandbox resource itself is missing or its lifecycle status is otherwise uncertain. It doesn't replace step-level reconciliation.

State pruning also doesn't clean external workspaces. It keeps an ended session while any sandbox record is not `cleaned`, and it conservatively keeps legacy active flags whose client owner is unknown.

## Give each cleanup effect its own saved step

**Every outside effect in typed cleanup belongs inside `cleanup.step(...)`.** Typed cleanup is re-entered directly when the sandbox is already `cleaning`; the runtime does not call sandbox-level `reconcile` first. A provider call or process signal outside a step can therefore repeat with no durable record of its outcome.

Give each step a stable, non-empty ID and exactly one retry policy:

```ts
async cleanup({ cleanup }) {
  await cleanup.step("remove-worktree", {
    reconcile: async ({ resource }) => {
      const exists = await worktreeExists(resource.id);
      return exists ? "incomplete" : "completed";
    },
  }, async ({ resource, signal }) => {
    await closeWorktree(resource.id, { signal });
  });
}
```

Use `{ retry: "idempotent" }` only when repeating the operation is safe. Use `reconcile` when a previous attempt may have succeeded but cannot safely be repeated without checking. For a previously started step, the reconciler returns:

| Result | What happens |
| --- | --- |
| `completed` | Save the step as complete and skip its operation. |
| `incomplete` | Start another operation attempt. |
| `unknown` | Save conservative uncertainty and stop cleanup. |

The saved step status is `running`, `completed`, `failed`, or `unknown`. Completed IDs are skipped when the cleanup hook runs again. Cleanup-step sessions are readonly so cleanup cannot introduce new staged session changes.

Await dependent steps sequentially, as in the example above. For independent cleanup, use `Promise.allSettled` so one rejection doesn't prevent another operation from settling, then throw the failures so the sandbox does not become `cleaned`:

```ts
const results = await Promise.allSettled([
  cleanup.step("remove-label", { retry: "idempotent" }, removeLabel),
  cleanup.step("close-worktree", { retry: "idempotent" }, closeWorktree),
]);

const failures = results.filter((result) => result.status === "rejected");
if (failures.length > 0) {
  throw new AggregateError(failures.map(({ reason }) => reason));
}
```

Here `removeLabel` and `closeWorktree` are project cleanup callbacks with the step-operation signature; the package supplies `cleanup.step` and the context passed to each callback.

The signal is checked before a step starts and after reconciliation. Once your operation is running, abort remains cooperative. If sequential cleanup is aborted while one operation runs, the next step does not start after the current operation settles.

Cleanup steps solve only this narrow sandbox-cleanup problem. They don't make outside effects exactly once, and they aren't a general workflow engine.

## Make creation and cleanup safe to repeat

The runtime saves what it knows, but it can't save an external API change and the local session update as one indivisible operation. If the process stops between those two actions, the next attempt can't know exactly what happened.

Plan for these cases:

| If this happens | Expect this consequence | What your code should do |
| --- | --- | --- |
| The worktree is created, then the process stops before saving `active` | The record remains `creating` | Publish its typed resource eagerly, then have `reconcile` check whether it exists. |
| A typed cleanup step succeeds, then the process stops before saving `completed` | The step remains `running` | Mark it idempotent or reconcile that specific step before repeating it. |
| Cleanup changes part of the resource and then fails | The cleanup hook and unfinished steps may run again | Put each outside effect in a step and use the right step retry policy. |
| The process exits during either function | Local records may not match the provider | Look up the resource by the stable key before changing it. |

Locks prevent two deliveries from creating or cleaning the same session sandbox at once only inside one runtime process. They don't coordinate separate processes.

Sandbox records include the client ID as well as the environment ID, so two clients can use the same environment ID for one session without sharing lifecycle state.

## Respond to timeouts and shutdown

Sandbox `create`, `reconcile`, `cleanup`, and cleanup steps receive the delivery attempt's `signal`. Pass it to external APIs and subprocesses. A handler timeout or runtime shutdown can abort it, but JavaScript can't forcibly stop code that ignores cancellation.

The handler timeout includes sandbox creation and cleanup. If either operation times out, the attempt follows ordinary retry rules, so the operation still needs to be safe to repeat.

Environment mount and unmount functions receive the runtime shutdown signal. Handler timeouts don't apply to those process-level functions. During shutdown, cancellation takes precedence over a later attempt timeout, and the runtime waits for cancellation-aware work to settle.

## Next steps

- [Make external changes safe to repeat](failure-semantics.md)
- [Test your integration](testing.md)
- [Look up the Environment API](../api-reference.md#environments-and-sandboxes)
