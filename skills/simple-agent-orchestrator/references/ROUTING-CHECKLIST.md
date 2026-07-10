# Routing checklist

Use this when reviewing or debugging Simple Agent Orchestrator integrations.

## Event identity

- `event.id` is stable for the source item.
- `dedupeKey` is present when the source item can change and should be reprocessed by version/update time.
- `sessionKey` names the durable work unit, not the individual event.
- Session keys include enough namespace to avoid collisions across owners, repos, projects, threads, or tenants.
- `defineKey` is used for structured keys when there are multiple parts.

## Handler safety

- Each handler works when it is the first event for a session.
- Persistent external identifiers are created with `session.ensure`; resources that need cleanup use an environment sandbox. Their external factories use stable idempotency keys or reconciliation.
- The handler does not require state created by another channel unless it can recreate or recover it.
- External source acknowledgement happens in one designated `onSuccess`, its ownership under fan-out is explicit, and it is safe to repeat.
- Each external handler or hook operation uses a stable idempotency key that does not include `attempt`, or reconciles external state before acting.
- Bounded operations receive the handler or sandbox `signal`; timeout is treated as cooperative cancellation, not proof that external work had no effect.
- Untrusted external text is separated from system/developer instructions using the target agent SDK's supported content or escaping mechanism.

## Session lifecycle

- `session.end(...)` is called only when the durable work unit is complete, such as a PR merge or resolved issue.
- Sandboxes and session resources have cleanup logic when they create external state.
- Ended sessions remain useful for debugging, and future events with the same `sessionKey` create a fresh active session.

## Environment and sandbox

- Shared runtime resources start in `environment.onMount`, not at module import time.
- Cleanup is registered through `environment.onUnmount`.
- Sandbox creation receives `{ event, session, project, environment }`, so branch/repo metadata comes from the triggering event.
- Sandbox cleanup checks whether the resource exists before closing it.
- Sandbox lifecycle logic can reconcile create, cleanup, and recreate if final delivery persistence fails after cleanup.

## HTTP ingress

- Project HTTP middleware is registered through `config.http.middleware`, before built-in routes.
- Custom routes use `config.http.routes` and its runtime-backed `dispatch`; the HTTP listener is not modeled as a client environment.
- `/health`, `/webhooks/*`, and `/api/v1/*` remain reserved.
- Normalized webhooks enforce `application/json`, the 1 MiB body limit, strict fields, JSON safety, queued/duplicate semantics, and unknown-channel errors.
- Operational lists are bounded to 100, use stable ordering, and omit event bodies, metadata, session state, notes, delivery records, and errors.
- Authentication, source signature verification, additional edge limits, CORS, rate limiting, TLS, and public exposure are explicit project responsibilities.
- Request bodies are not logged by default, and unauthenticated dispatch is reviewed for external side effects and unbounded state growth.
- A loopback bind is not treated as authentication, and non-loopback exposure receives an explicit security review.

## Queue and retries

- Dedupe is not treated as successful processing.
- Processing is not treated as exactly once; handlers, hooks, and resource operations may repeat.
- Failed deliveries remain visible through `events list`.
- Retry settings are explicit when the default is not enough.
- Retry delay is explicit when immediate retries could amplify an outage or rate limit.
- Handler timeout is explicit when an agent, subprocess, or network operation needs a cooperative deadline.
- One-shot drains are not expected to wait for delayed pending work.
- `client.concurrency({ perSession: true })` is used when the target agent/tool cannot safely receive same-session messages concurrently.

## CLI checks

```bash
npx simple-agent-orchestrator doctor
npx simple-agent-orchestrator state validate
npx simple-agent-orchestrator print-config
npx simple-agent-orchestrator dispatch manual --id smoke-1 --session smoke --input "Smoke test"
npx simple-agent-orchestrator sessions list
npx simple-agent-orchestrator events list
curl http://127.0.0.1:3000/health
curl -X POST http://127.0.0.1:3000/webhooks/manual -H 'Content-Type: application/json' -d '{"id":"http-smoke","sessionKey":"smoke","input":"Smoke test"}'
curl http://127.0.0.1:3000/api/v1/status
curl 'http://127.0.0.1:3000/api/v1/events?limit=25'
```

The HTTP smoke commands run while ordinary `start` is active; stop it cleanly afterward. `dispatch`, `sessions end`, `events retry`, and `state prune --apply` are offline mutations and require the long-running runtime to be stopped. Normal `start` and `dev` open HTTP unless `--no-http` is passed; drain and inspection commands do not. The inspection commands, including `state validate` and a retention preview without `--apply`, remain available while `start` is active. Before pruning, back up persistent state and inspect the exact IDs; `--drop-dedupe` permits old source identities to run again.

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
