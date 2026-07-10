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
- Persistent external identifiers are created with `session.ensure`; resources that need cleanup use an environment sandbox.
- The handler does not require state created by another channel unless it can recreate or recover it.
- External source acknowledgement happens after successful handling.
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

## Queue and retries

- Dedupe is not treated as successful processing.
- Failed deliveries remain visible through `events list`.
- Retry settings are explicit when the default is not enough.
- `client.concurrency({ perSession: true })` is used when the target agent/tool cannot safely receive same-session messages concurrently.

## CLI checks

```bash
npx simple-agent-orchestrator doctor
npx simple-agent-orchestrator print-config
npx simple-agent-orchestrator dispatch manual --id smoke-1 --session smoke --input "Smoke test"
npx simple-agent-orchestrator sessions list
npx simple-agent-orchestrator events list
```

## Common failures

### Duplicate external agent sessions

Cause: handler used `session.get` then created the resource manually.

Fix: use `session.ensure` for the durable external identifier.

### Review routes to the wrong session

Cause: `sessionKey` is too broad, often missing owner/repo or tenant.

Fix: include all stable namespace parts in `defineKey`.

### Event is never retried

Cause: source was marked handled before durable processing succeeded.

Fix: move source acknowledgement to `onSuccess`.

### Config loads from the wrong package

Cause: command ran from a monorepo directory and discovery picked the wrong root.

Fix:

```bash
npx simple-agent-orchestrator start --root packages/api
# or
npx simple-agent-orchestrator start --config packages/api/.simple-agent-orchestrator/orchestrator.ts
```
