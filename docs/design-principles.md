# Design principles

## Embedded, not external

The orchestrator should be installed into an existing TypeScript project and use that project’s own code. It should not force users to move integrations into a separate service.

## Durable plumbing, not an agent framework

The framework owns boring but important stateful plumbing:

- event ingestion
- dedupe
- delivery attempts
- session resolution
- session state
- environment lifecycle
- sandbox cleanup
- CLI inspection

User code owns:

- how source APIs are called
- how prompts are rendered
- how agents are invoked
- whether the agent queues messages
- how tools are approved
- how project-specific resources behave

## Sessions are the unit of continuity

A session is the durable mapping between external events and ongoing work.

The framework should make this easy:

```ts
sessionKey: `github:${repo}:pr:${number}`
```

Future events with the same key reuse the same active session.

## Event dedupe is not processing success

The runtime dedupes events when they are dispatched. A duplicate event is not enqueued twice.

A delivery is only marked processed after the client handler succeeds.

## Prefer small composable primitives

Important primitives:

- `createChannel`
- `createClient`
- `createEnvironment`
- `session.ensure`
- typed state keys
- key builders
- stores
- runtime/CLI inspection

Avoid large abstractions until repeated real-world integrations prove they are necessary.

## Keep paths project-aware

Handlers and config receive `project` so code can use:

```ts
project.fromRoot("src")
project.fromOrchestrator("prompts/review.md")
project.statePath("state.json")
```

This keeps the framework pleasant inside large existing repositories.
