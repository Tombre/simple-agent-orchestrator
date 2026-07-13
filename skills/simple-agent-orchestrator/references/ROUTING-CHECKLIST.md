# Routing checklist

Use this when reviewing or debugging Simple Agent Orchestrator integrations.

## Event identity

- `event.id` is stable for the source item.
- `dedupeKey` is present when the source item can change and should be reprocessed by version/update time.
- `sessionKey` names the durable work unit, not the individual event.
- Session keys include enough namespace to avoid collisions across owners, repos, projects, threads, or tenants.
- `defineKey` is used for structured keys when there are multiple parts.
- The dispatch path is explicit: `channel.dispatch` is used only when exactly one initialized runtime can be bound; `runtime.dispatch(channel|string, event)` is used when runtime selection matters.

## Definitions

- Builder callbacks configure definitions before runtime initialization.
- Composition mutations, if any, finish before `runtime.init()`.
- Code does not expect post-init mutations to reconfigure a live runtime.
- Readonly TypeScript properties are not mistaken for runtime freezing.

## Handler safety

- Each handler works when it is the first event for a session.
- Persistent external identifiers are created with `session.ensure`; resources that need cleanup use `createSandbox` and a typed JSON-safe resource. Their external factories use stable idempotency keys or reconciliation.
- The handler does not require state created by another channel unless it can recreate or recover it.
- External source acknowledgement happens in one designated `onSuccess`, its ownership under fan-out is explicit, and it is safe to repeat.
- Each external handler or hook operation uses a stable idempotency key that does not include `attempt`, or reconciles external state before acting.
- Bounded operations receive the handler or sandbox `signal`; timeout is treated as cooperative cancellation, not proof that external work had no effect.
- Untrusted external text is separated from system/developer instructions using the target agent SDK's supported content or escaping mechanism.

## Session lifecycle

- `session.end(...)` is called only when the durable work unit is complete, such as a PR merge or resolved issue.
- Sandboxes have cleanup logic when they create external state, and every outside typed-cleanup effect is inside a durable cleanup step.
- Ended sessions remain useful for debugging, and future events with the same `sessionKey` create a fresh active session.

## Environment and sandbox

- Shared runtime resources start in `environment.onMount`, not at module import time.
- Cleanup is registered through `environment.onUnmount`.
- Typed sandbox creation returns its resource or calls `publishResource` eagerly once identity is known. The resource is JSON-safe and contains everything handlers and cleanup need.
- Handlers call `sandbox.get/getOptional` with the exact definition configured by `environment.useSandbox`; `existing-only` handlers do not rely on creation or reconciliation.
- Sandbox hooks use `currentStatus`; resource-aware `reconcile` checks the optional resource, publishes a recovered resource before reporting `active`, and reports `active`, `cleaned`, or `unknown` conservatively.
- Every outside cleanup effect uses `cleanup.step` with a stable non-empty ID and exactly one of `{ retry: "idempotent" }` or `{ reconcile }`.
- Step reconciliation reports `completed`, `incomplete`, or `unknown`; unknown blocks. Dependent steps are awaited sequentially. Independent `Promise.allSettled` results are checked and rethrown.
- Cleanup code does not place provider calls, process signals, or filesystem changes outside a step; typed cleanup re-enters directly from `cleaning`.
- Sandbox lifecycle logic treats persisted cleanup as complete; a retry of final delivery persistence does not recreate the sandbox.
- Cleanup steps are not treated as exactly-once work or a general workflow engine.

## Managed process lifecycle

- Spawned managed processes default stdio to `ignore`; explicit stdio does not ask Node to generate pipes, overlapped pipes, or IPC channels.
- Persisted processes are recovered with `adoptManagedProcess` only when the PID is greater than 1 and project identity data can implement mandatory `ownsProcess` verification.
- POSIX adoption intentionally targets only group `-pid`; code does not add a positive-PID fallback. Windows adoption targets the PID and does not claim descendant cleanup.
- Adopted ownership is checked before TERM and again before KILL. The first stop promise/options are reused, stop returns no exit result, and post-KILL disappearance is bounded.

## HTTP ingress

- Project HTTP middleware is registered through `config.http.middleware`, before built-in routes.
- Custom routes use `config.http.routes` and its runtime-backed `dispatch`; the HTTP listener is not modeled as a client environment.
- `/health`, `/webhooks/*`, and `/api/v1/*` remain reserved.
- Normalized webhooks enforce `application/json`, the 1 MiB body limit, strict fields, JSON safety, queued/duplicate semantics, and unknown-channel errors.
- Operational lists are bounded to 100, use stable ordering, and omit event bodies, metadata, session state, notes, delivery records, and errors.
- Authentication, source signature verification, additional edge limits, CORS, rate limiting, TLS, and public exposure are explicit project responsibilities.
- Built-in operational responses omit sensitive body/state/error fields, but project middleware, routes, handlers, and logs are reviewed separately for plaintext exposure.
- JSON state, event content, session state, notes, cursors, errors, and ordinary logs are treated as plaintext and not automatically redacted.
- A loopback bind is not treated as authentication, and non-loopback exposure receives an explicit security review.

## Queue and retries

- Dedupe is not treated as successful processing.
- Processing is not treated as exactly once; handlers, hooks, and resource operations may repeat.
- Failed deliveries remain visible through `events list`.
- Retry settings are explicit when the default is not enough.
- Retry delay is explicit when immediate retries could amplify an outage or rate limit.
- Handler timeout is explicit when an agent, subprocess, or network operation needs a cooperative deadline.
- One-shot drains are not expected to wait for delayed pending work.
- Fire-and-forget agents use `client.capacity(...)` when active external sessions need a durable cost or resource limit.
- Completion events reuse the original session key, use `session: "existing-only"` when they must not create or rebind a session, and release capacity only after the external agent has stopped.
- `client.concurrency({ perSession: true })` is used when the target agent/tool cannot safely receive same-session messages concurrently.

## CLI checks

```bash
npx simple-agent-orchestrator doctor
npx simple-agent-orchestrator state validate
npx simple-agent-orchestrator print-config
npx simple-agent-orchestrator dispatch manual --id smoke-1 --session smoke --input "Smoke test"
npx simple-agent-orchestrator sessions list
npx simple-agent-orchestrator capacity list
npx simple-agent-orchestrator events list --json --limit 25
npx simple-agent-orchestrator events show <internal-event-id>
curl http://127.0.0.1:3000/health
curl -X POST http://127.0.0.1:3000/webhooks/manual -H 'Content-Type: application/json' -d '{"id":"http-smoke","sessionKey":"smoke","input":"Smoke test"}'
curl http://127.0.0.1:3000/api/v1/status
curl 'http://127.0.0.1:3000/api/v1/events?limit=25'
```

The HTTP smoke commands run while ordinary `start` is active; stop it cleanly afterward. `dispatch`, `sessions end`, `sessions complete`, `capacity release`, `events retry`, and `state prune --apply` are offline mutations and require the long-running runtime to be stopped. Ordinary `start` opens HTTP unless `--no-http` is passed; drain and inspection commands do not. The inspection commands, including `capacity list`, `state validate`, and a retention preview without `--apply`, remain available while `start` is active. CLI dispatch requires `--id`; `sessions complete` requires an exact active session ID; list `--limit` must be positive; missing show/end/retry targets fail. Before pruning, back up persistent state and inspect the exact IDs; `--drop-dedupe` permits old source identities to run again.

## Common failures

### Persisted state does not validate

Cause: the JSON is malformed, its shape or references are invalid, or its version is outside the supported range.

Fix: run `state validate` for the exact path and recovery category. Do not delete or overwrite the file automatically; back it up, then repair it, restore a compatible backup, upgrade the package for future state, or use an intermediate package version for obsolete state.

### Duplicate external agent sessions

Cause: external creation had no stable idempotency key, or the handler created the resource without `session.ensure`.

Fix: use `session.ensure` for the durable external identifier and make its factory idempotent or reconciling. `session.ensure` cannot atomically couple external creation to local persistence.

### Review routes to the wrong session

Cause: `sessionKey` is too broad, often missing owner/repo or tenant.

Fix: include all stable namespace parts in `defineKey`.

### Event is never retried

Cause: source was marked handled before durable processing succeeded.

Fix: move source acknowledgement to `onSuccess` and make it safe to repeat.

### Config loads from the wrong package

Cause: command ran from a monorepo directory and discovery picked the wrong root.

Fix:

```bash
npx simple-agent-orchestrator start --root packages/api
# or
npx simple-agent-orchestrator start --config packages/api/.simple-agent-orchestrator/orchestrator.ts
```
