# Design principles

Simple Agent Orchestrator is intentionally a small, one-process tool that you add to an existing project. These principles explain where it helps and where your application stays in charge.

## Add it to the project you already have

Install the orchestrator alongside the agent code, API clients, and business rules you already own. You shouldn't have to move those integrations into a new service or adopt a workflow language just to process events reliably.

The dependency points in one direction: files under `.simple-agent-orchestrator/` can call your project code. Your application code doesn't need to import its project-specific orchestrator setup.

## Let the package handle the repeated bookkeeping

The package handles the plumbing around your handlers:

- accepting events from project calls, CLI commands, polls, and the package's HTTP event route
- saving events before reporting that they've been queued
- ignoring events you've already accepted, based on the channel and deduplication key
- creating a separate processing record for each matching handler
- tracking attempts, fixed-delay retries, and cooperative timeouts
- finding or creating a session so related events can share context
- saving ordinary session updates and notes after successful work, while letting `session.ensure` save retry-safe setup earlier
- remembering poll positions
- starting and stopping client environments
- tracking session sandboxes and running configured cleanup after a successful handler ends its session
- checking stored data and upgrading supported older formats
- providing small, read-only HTTP status summaries
- inspecting, retrying, ending, and pruning work through explicit runtime or CLI actions

These are general mechanics. They don't require the package to know which AI provider you use or what your source payload looks like.

## Keep application decisions in application code

Your project decides:

- how to call GitHub, Slack, or any other source API
- how to verify and translate provider-specific webhook payloads
- how to authenticate HTTP requests and provide CORS, rate limiting, TLS, and public routing
- how to build prompts and invoke an agent
- which tools an agent may use and how approvals work
- how to make outside actions safe to repeat
- when to acknowledge an item back to its source
- whether an agent should queue or combine messages
- how project-specific resources, such as repositories and worktrees, should behave

This split keeps the package useful without turning it into an agent SDK, provider integration, authorization layer, or hosted queue.

## Use sessions for a real unit of work

A session gives related events one shared place for context. For example, every comment and review update for a pull request can use the same key:

```ts
sessionKey: `github:${repo}:pr:${number}`
```

Future events with the same key reuse the active session. Once a handler ends it, the session remains in history and a later event with that key starts a new active one.

## Treat queued and completed as different things

Dispatch checks whether the same channel and deduplication key were already accepted. A duplicate returns the original internal event ID and creates no new deliveries.

For `POST /webhooks/:channelId`, `202 queued` means the event and matching deliveries were saved. It doesn't mean a handler finished. `200 duplicate` means the event was already present and returns its original internal ID.

A delivery becomes `processed` only after the handler, `onSuccess`, any required sandbox cleanup, and saving the successful result all complete.

## Assume outside actions may repeat

The orchestrator can't atomically combine its local save with an API call, agent action, or source acknowledgement. If the process stops between those steps, a retry may repeat the outside action. Use stable idempotency keys or check the outside system before acting again.

Deduplication prevents the same source event from being accepted twice. It doesn't promise that a handler runs only once. After an abrupt exit, unfinished deliveries run again on the next startup or drain.

Timeouts work the same way: the runtime sends an `AbortSignal` and waits for your code to stop. It can't terminate JavaScript or undo an action that already reached another system.

## Prefer a small set of understandable tools

The main building blocks are deliberately few:

- `createChannel`
- `createClient`
- `createEnvironment`
- `session.ensure`
- typed state keys
- key builders
- stores
- runtime/CLI inspection

Larger abstractions belong here only when several real integrations show that they're needed. Retry delays, for example, only determine when a failed delivery can try again. They aren't a scheduler, arbitrary timer system, or backoff strategy.

Channel, client, and environment builders set them up before startup. `init()` reads that setup once, so later changes require a new runtime.

`channel.dispatch(...)` is convenient when one initialized runtime uses that channel. Use `runtime.dispatch(...)` when your code may have several runtimes or needs to choose one directly.

Old history is removed only when you ask. Pruning starts with a preview, preserves active work, and keeps event deduplication records unless you explicitly choose to remove them.

## Run one process for each local state file

Workers, session updates, polls, and resource locks are managed only inside one runtime process. The JSON store uses a local lock file and rejects a second active runtime. It can reclaim a stale lock after the process that held it exits, but the file isn't a shared queue for several running processes.

Send HTTP events to the runtime that's using the JSON state file so accepting the event and processing it happen in that same process.

The same server exposes small, read-only status endpoints. They leave out event bodies, session state, notes, poll positions, errors, file paths, and administrative actions. Your project still provides authentication, provider verification, TLS, rate limiting, and any public-facing routing or security.

## Resolve paths from the project

Handlers and config receive `project` so code can use:

```ts
project.fromRoot("src")
project.fromOrchestrator("prompts/review.md")
project.statePath("state.json")
```

These helpers let integration code find project files without depending on the directory where someone happened to run the command.
