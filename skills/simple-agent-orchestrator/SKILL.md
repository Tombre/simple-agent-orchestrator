---
name: simple-agent-orchestrator
description: Build, review, or modify Simple Agent Orchestrator integrations in TypeScript projects. Use for .simple-agent-orchestrator, durable agent sessions, channel/client/environment definitions, runtime dispatch, or the simple-agent-orchestrator CLI.
license: MIT
compatibility: Node.js 20+, TypeScript, npm projects
metadata:
  version: "0.1.0"
---

Simple Agent Orchestrator is embedded, one-process durable plumbing. Channels ingest events, client handlers receive independent retryable deliveries, sessions preserve continuity, environments own process resources and optional sandboxes, and ordinary startup may host built-in and project-defined HTTP routes.

## Procedure

1. **Locate the package.** Find the nearest existing valid `package.json` and `.simple-agent-orchestrator/orchestrator.ts`. `npx simple-agent-orchestrator init` discovers that nearest package; `--root` selects one explicitly. Init does not create or edit the host manifest. `--force` replaces known template files while preserving unknown files.

2. **Preserve dependency direction.** Keep orchestration code under `.simple-agent-orchestrator/` and let it import project code, not the reverse. Use explicit `.ts` extensions for all project-local TypeScript imports.

3. **Choose durable identities.** Require a stable event `id`; add `dedupeKey` when source identity differs from processing identity; add `sessionKey` for the durable work unit. Name polls whose cursor must survive registration reordering. Never recycle historical poll IDs for unrelated cursors.

4. **Respect the definition boundary.** Builders configure mutable channel, client, and environment definitions. Definitions are inspectable and readonly-typed but not frozen. A runtime snapshots config and registrations at `init()`; changes afterward do not affect it. Do not implement or imply live reconfiguration.

5. **Dispatch deliberately.** `channel.dispatch(event)` works only while exactly one initialized runtime is bound to that exact channel object. It throws with no binding or multiple bindings. Use `runtime.dispatch(channel, event)` to select by exact object or `runtime.dispatch(channelId, event)` to select by registered ID.

6. **Make every external effect retry-safe.** Event dedupe is not exactly-once handling. `handle`, `onSuccess`, sandbox work, and interrupted attempts can repeat. Use stable operation-specific idempotency keys or reconciliation, never `attempt`. Use `session.ensure` for eager durable identifiers, but keep its external factory retry-safe. Pass `signal` to cancellation-aware work; timeout is cooperative.

7. **Acknowledge sources after handling.** Put source acknowledgement in one designated `onSuccess`, not polling or the start of `handle`. It can still repeat after cleanup or persistence failure. Poll `commit` is an ingestion checkpoint, not delivery success.

8. **Keep HTTP ownership clear.** Built-in normalized webhook and operational routes belong to the runtime. Provider parsing, authentication, signature verification, CORS, rate limiting, TLS, and exposure policy belong to project middleware/routes. Built-in operational summaries omit sensitive bodies/state/errors, but project handlers and logs have no categorical redaction guarantee.

9. **Treat persistence and logs as plaintext.** The JSON store, events, state, notes, cursors, errors, and ordinary project/default logs are plaintext. Do not persist or log credentials, tokens, or sensitive source content without an explicit policy. The generated example logs identifiers only.

10. **Use the right runtime helper.** Prefer `createRuntime(config, options)` for programmatic persistent use; it defaults to the project JSON store. Project loaders discover config. The direct `OrchestratorRuntime` constructor plus `init()` is low-level. Use `runOffline(({ dispatch, drain, endSession, retryDelivery, pruneState }) => ...)` for scoped persistent mutations.

11. **Test through the public harness.** Call `createTestRuntime(config, options)`, not a nested `{ config }` object. It defaults to isolated memory state, a silent logger, and no HTTP. Prefer dispatch/session/event/delivery helpers and always stop it; `test.runtime` is the public escape hatch for lifecycle behavior.

12. **Validate strict CLI usage.** Useful checks:

```bash
npx simple-agent-orchestrator doctor
npx simple-agent-orchestrator state validate
npx simple-agent-orchestrator dispatch manual --id smoke-1 --session smoke --input "Smoke test"
npx simple-agent-orchestrator events list --json --limit 25
npx simple-agent-orchestrator sessions list --json --limit 25
```

`dispatch --id` is required. Unknown flags, extra arguments, missing values, invalid limits, and missing show/retry/end records fail. Stop a long-running JSON-store runtime before `dispatch`, `sessions end`, `events retry`, or `state prune --apply`. Inspection and prune preview remain available while it runs.

## References

- Read [`references/API-CHEATSHEET.md`](references/API-CHEATSHEET.md) before writing API calls.
- Read [`references/TEMPLATES.md`](references/TEMPLATES.md) before creating project-local files.
- Read [`references/ROUTING-CHECKLIST.md`](references/ROUTING-CHECKLIST.md) when reviewing or debugging.
