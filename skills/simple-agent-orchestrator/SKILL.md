---
name: simple-agent-orchestrator
description: Build, review, or modify Simple Agent Orchestrator integrations in TypeScript projects. Use for .simple-agent-orchestrator, durable agent sessions, channel/client/environment definitions, runtime dispatch, or the simple-agent-orchestrator CLI.
license: MIT
compatibility: Node.js 20+, TypeScript, npm projects
metadata:
  version: "0.1.0"
---

Simple Agent Orchestrator is embedded, one-process durable plumbing. Channels ingest events, client handlers receive independent retryable deliveries, sessions preserve continuity, retained client capacity can bound detached agent sessions, environments own process resources and optional sandboxes, and ordinary startup may host built-in and project-defined HTTP routes.

It is not exactly-once processing or a general workflow engine. Durable steps exist only inside typed sandbox cleanup.

## Procedure

1. **Locate the package.** Find the nearest existing valid `package.json` and `.simple-agent-orchestrator/orchestrator.ts`. `npx simple-agent-orchestrator init` discovers that nearest package; `--root` selects one explicitly. Init does not create or edit the host manifest. `--force` replaces known template files while preserving unknown files.

2. **Preserve dependency direction.** Keep orchestration code under `.simple-agent-orchestrator/` and let it import project code, not the reverse. Use explicit `.ts` extensions for all project-local TypeScript imports.

3. **Choose durable identities.** Require a stable event `id`; add `dedupeKey` when source identity differs from processing identity; add `sessionKey` for the durable work unit. Name polls whose cursor must survive registration reordering. Never recycle historical poll IDs for unrelated cursors.

4. **Respect the definition boundary.** Builders configure mutable channel, client, and environment definitions. Definitions are inspectable and readonly-typed but not frozen. A runtime snapshots config and registrations at `init()`; changes afterward do not affect it. Do not implement or imply live reconfiguration.

5. **Dispatch deliberately.** `channel.dispatch(event)` works only while exactly one initialized runtime is bound to that exact channel object. It throws with no binding or multiple bindings. Use `runtime.dispatch(channel, event)` to select by exact object or `runtime.dispatch(channelId, event)` to select by registered ID.

6. **Make every external effect retry-safe.** Event dedupe is not exactly-once handling. A delivery saves its next phase (`sandbox`, `handling`, `acknowledging`, `cleaning`, or `persisting`) and does not rerun completed earlier phases, but the phase interrupted before its checkpoint can repeat. Use stable operation-specific idempotency keys or reconciliation, never `attempt`. Use `session.ensure` for eager durable identifiers. Use `createSandbox<TResource extends JsonValue>` for a typed resource that also needs cleanup; return the resource or publish it eagerly once its identity is known. Keep every external factory retry-safe. Pass `signal` to cancellation-aware work; timeout is cooperative.

In a handler, access the configured typed resource with `sandbox.get(definition)` or `getOptional(definition)`. The definition must be the exact object passed to `environment.useSandbox`. `get` requires an active resource; `getOptional` returns `undefined` when there is no active resource, including a migrated active record without one. An `existing-only` handler does not create or reconcile before handling; if it explicitly ends the session, the later cleanup phase may reconcile uncertain saved state.

Typed cleanup re-enters directly from `cleaning`. Put **every outside cleanup effect** inside `cleanup.step(stableId, policy, operation)`. Choose exactly one policy: `{ retry: "idempotent" }` or `{ reconcile }`. Reconciliation reports `completed`, `incomplete`, or `unknown`; unknown blocks conservatively. Await dependencies sequentially. Use `Promise.allSettled` only for independent steps and propagate its failures. Abort prevents later sequential steps from starting after the current operation settles.

For completion callbacks that must not create or rebind a session, use the object handler option `session: "existing-only"`. It binds the exact active session at dispatch. A missing session is ignored without an attempt. If the session ends before a retry, the delivery is terminally ignored without running another phase and keeps its prior attempt metadata and uncommitted staged effects. Ignored work creates no new capacity or sandbox; inspect `ignoredReason` as `session-missing` or `session-ended`. There is no `onIgnored` hook.

7. **Acknowledge sources after handling.** Put source acknowledgement in one designated `onSuccess`, not polling or the start of `handle`. It can repeat if acknowledgement itself fails or is interrupted, but cleanup and persistence retries resume after it. Poll `commit` is an ingestion checkpoint, not delivery success.

8. **Use durable exhaustion work for terminal reporting.** Register at most one `client.onExhausted({ retries?, timeout?, handle })`. It receives the event, source delivery, optional read-only session, failed stage, sanitized failure descriptor, attempt, signal, project, logger, client, and mounted environment. It is independent historical work with its own retry budget, remains after a source delivery is manually retried, does not create a sandbox, and never recursively creates exhaustion work.

9. **Keep HTTP ownership clear.** Built-in normalized webhook and operational routes belong to the runtime. Provider parsing, authentication, signature verification, CORS, rate limiting, TLS, and exposure policy belong to project middleware/routes. Built-in operational summaries omit sensitive bodies/state/errors, but project handlers and logs have no categorical redaction guarantee.

10. **Treat persistence and logs as plaintext.** The JSON store, events, state, notes, cursors, errors, and ordinary project/default logs are plaintext. Do not persist or log credentials, tokens, or sensitive source content without an explicit policy. The generated example logs identifiers only.

11. **Use the right runtime helper.** Prefer `createRuntime(config, options)` for programmatic persistent use; it defaults to the project JSON store. Project loaders discover config. The direct `OrchestratorRuntime` constructor plus `init()` is low-level. Use `runOffline(({ dispatch, drain, endSession, completeSession, releaseCapacity, retryDelivery, pruneState }) => ...)` for scoped persistent mutations. `endSession` is metadata-only; `completeSession` requires an exact active session ID, rejects while that session has pending or processing deliveries, and cleans recorded sandboxes before ending or releasing capacity.

12. **Test through the public harness.** Call `createTestRuntime(config, options)`, not a nested `{ config }` object. It defaults to isolated memory state, a silent logger, and no HTTP. Prefer dispatch, `sessions.end/complete`, `sandboxes.list`, capacity, event, delivery, and exhaustion helpers and always stop it; `test.runtime` is the public escape hatch for lifecycle behavior.

13. **Manage detached local processes narrowly.** Import `spawnManagedProcess` and `adoptManagedProcess` from `simple-agent-orchestrator/node`. Spawn is shell-free and detached; stdio defaults to `ignore` and may use inherited streams or existing numeric file descriptors. It does not create pipes or IPC channels. Use `waitUntilReady` for an application-defined readiness check and call idempotent `stop()` during cleanup.

Adoption requires a PID greater than 1 and a mandatory `ownsProcess` check based on identity stronger than the PID. On POSIX it observes and signals only process group `-pid`, never a positive-PID fallback; on Windows it targets the PID. It verifies ownership before TERM and again before KILL, then waits a bounded five seconds after KILL. Its first stop promise and options are cached, and stop resolves with no exit result. Put adoption and stop inside a typed cleanup step. These helpers have no restart, port, HTTP, persistence, or provider policy.

14. **Validate strict CLI usage.** Useful checks:

```bash
npx simple-agent-orchestrator doctor
npx simple-agent-orchestrator state validate
npx simple-agent-orchestrator dispatch manual --id smoke-1 --session smoke --input "Smoke test"
npx simple-agent-orchestrator events list --json --limit 25
npx simple-agent-orchestrator sessions list --json --limit 25
```

`dispatch --id` is required. Unknown flags, extra arguments, missing values, invalid limits, and missing show/retry/end records fail. Stop a long-running JSON-store runtime before `dispatch`, `sessions end`, `sessions complete`, `capacity release`, `events retry`, or `state prune --apply`. Inspection, `capacity list`, and prune preview remain available while it runs.

## References

- Read [`references/API-CHEATSHEET.md`](references/API-CHEATSHEET.md) before writing API calls.
- Read [`references/TEMPLATES.md`](references/TEMPLATES.md) before creating project-local files.
- Read [`references/ROUTING-CHECKLIST.md`](references/ROUTING-CHECKLIST.md) when reviewing or debugging.
