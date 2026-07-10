# Design principles

## Embedded, not external

The orchestrator should be installed into an existing TypeScript project and use that project’s own code. It should not force users to move integrations into a separate service.

## Durable plumbing, not an agent framework

The framework owns boring but important stateful plumbing:

- event ingestion
- normalized webhook ingestion, bounded operational summaries, and project-level HTTP extension hooks
- dedupe
- delivery attempts
- session resolution
- session state
- persisted-state validation and compatible upgrades
- environment lifecycle
- sandbox cleanup
- CLI inspection
- explicit operator-controlled state retention

User code owns:

- how source APIs are called
- provider payload conversion, HTTP authentication, source signature verification, CORS, rate limiting, TLS, and exposure policy
- how prompts are rendered
- how agents are invoked
- how external effects are made idempotent or reconciled
- when and how source items are acknowledged
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

For normalized HTTP ingress, `202 queued` means the event and matching deliveries are durable, not that processing succeeded. `200 duplicate` returns the original internal event ID and likewise says nothing about delivery success.

A delivery is only marked processed after the handler, success hook, required sandbox cleanup, and final persistence succeed.

## Retryable, not exactly once

Local delivery state cannot be committed atomically with source acknowledgement, agent calls, or other external effects. A failed attempt may therefore repeat work that completed externally. Integrations own stable external idempotency keys or reconciliation, and acknowledgement belongs after successful handling.

Event dedupe is not an exactly-once processing guarantee. After an abrupt exit, the next startup or drain requeues deliveries left `processing`; because the interrupted attempt may already have completed external work, recovery can repeat effects.

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

State retention is an explicit preview-and-apply operation, not a background compaction service. It preserves operational work and dedupe by default; surrendering old dedupe history requires a separate operator choice.

A fixed durable retry eligibility timestamp is delivery plumbing, not a general scheduling API. Backoff strategies, arbitrary timers, and workflow schedules remain outside the runtime until demonstrated integration needs justify them.

A fixed cooperative delivery-attempt deadline is also local reliability plumbing, not process isolation. The runtime communicates cancellation through `AbortSignal` and waits for project code to settle; it does not claim to terminate JavaScript or roll back external side effects.

## One active local runtime

Worker claims, session merging, polling, and resource locks coordinate within one process. Stores that depend on those guarantees should identify a project-local runtime lock so a second active runtime fails early instead of appearing to provide unsupported distributed coordination. Stale local ownership may be reclaimed after its process exits; this is not a lease, consensus mechanism, or replacement for a multi-process-safe store.

Normalized webhook ingress that mutates the default JSON store belongs on the same runtime-owned HTTP server, not in a second process or a client-scoped environment. This keeps dispatch, workers, the mutex, and store ownership together without turning the runtime into a hosted web platform. The same listener exposes only bounded read-only operational summaries; it does not expose event bodies, session state, notes, cursors, errors, resources, paths, or administrative mutations. The framework owns the webhook's 1 MiB validation limit and operational list bounds. Project code still owns every security, provider-specific, edge, and exposure concern.

## Keep paths project-aware

Handlers and config receive `project` so code can use:

```ts
project.fromRoot("src")
project.fromOrchestrator("prompts/review.md")
project.statePath("state.json")
```

This keeps the framework pleasant inside large existing repositories.
