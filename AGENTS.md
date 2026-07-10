# AGENTS.md

## Purpose

Simple Agent Orchestrator is a dependency-light Node.js 20+ TypeScript library and CLI for embedding event-driven agent orchestration inside an existing project.

The framework owns event ingestion, deduplication, deliveries, retries, durable sessions, state, notes, polling cursors, client environments, session sandboxes, config discovery, and operational inspection.

User integrations own source APIs, webhooks, prompts, agent/tool invocation, source acknowledgement, authorization, security policy, and project-specific resource behavior.

## Design Ethos

This project is intentionally a **simple, one-process orchestrator**. It provides durable plumbing, gets users running quickly, and then gets out of their way.

- Optimize for a small API, understandable control flow, few dependencies, and project-local operation.
- Prefer explicit TypeScript primitives over a workflow DSL, plugin system, service boundary, or abstraction added for hypothetical future use.
- Improve local reliability before adding scope. New behavior must solve a demonstrated integration need.
- Preserve the dependency direction `.simple-agent-orchestrator -> existing project code`; application code should not need to depend on project-local orchestrator definitions.
- Treat one runtime process as the supported coordination boundary. Do not introduce distributed coordination merely to disguise that limit.
- Do not turn this into a hosted platform, general workflow engine, bundled provider integration, agent SDK, prompt system, authorization layer, or queue without an explicit requirement.

Read [the design principles](docs/design-principles.md) before changing project ownership, scope, or the public model.

## Domain Model

- **Project**: an existing repository containing project-local orchestration code, normally under `.simple-agent-orchestrator/`.
- **Channel**: a globally identified source of events. A channel may register polls or receive dispatches from user-owned webhook/server code. A manual channel is simply a channel without polls.
- **Poll and cursor**: a poll fetches source items and optionally maps them to dispatch events. Its durable cursor records source progress.
- **Event**: the durable input unit. Source IDs, dedupe keys, and session keys are separate identities and must be chosen deliberately.
- **Delivery**: one event's processing record for one matching client handler. Fan-out creates multiple independent deliveries.
- **Client**: a globally identified consumer that registers handlers, concurrency policy, retry defaults, and at most one environment.
- **Handler**: a client's subscription to a channel. It owns `handle`, `onSuccess`, `onFailure`, and an optional retry override.
- **Session**: durable continuity for a `sessionKey`. It stores typed state and notes across related deliveries; only active sessions are reused.
- **Environment**: process-local resources mounted for a client. Values are not durable and environment definitions may own one sandbox lifecycle.
- **Sandbox**: an optional session-scoped resource created and cleaned up by an environment. The package tracks lifecycle state; integrations own the actual resource.
- **Store**: a full runtime-state snapshot adapter. The package ships isolated memory storage and a local JSON-file store.
- **Runtime**: the one-shot, in-process coordinator for dispatch, polling, workers, lifecycle, locking, and persistence.

Canonical API details live in [the API reference](docs/api-reference.md), not in this summary.

## Repository Map

- `src/core/`: public definitions for channels, clients, environments, sessions, keys, events, and config.
- `src/runtime/runtime.ts`: dispatch, polling, delivery claiming, retries, concurrency, lifecycle, and persistence.
- `src/runtime/project.ts`: project-root discovery and TypeScript/JavaScript config loading.
- `src/stores/`: full-state store contract plus memory and JSON-file implementations.
- `src/cli.ts`: initialization, execution, dispatch, inspection, and retry commands.
- `src/testing/`: public in-memory test harness.
- `src/index.ts`: curated root public API.
- `tests/`: executable behavioral contract.
- `templates/default/`: files copied by `simple-agent-orchestrator init`.
- `README.md` and `docs/`: user-facing behavior and examples.
- `skills/simple-agent-orchestrator/`: coding-agent integration guidance shipped with the project.
- `tasks/`: proposed reliability work; these documents are plans, not implemented behavior.

Public package subpaths are `.`, `./runtime`, and `./testing`. The package is ESM-only.

## Guides And Skill

- [Getting started](docs/guides/getting-started.md)
- [Project integration](docs/guides/project-integration.md)
- [Channels](docs/guides/channels.md)
- [Clients and handlers](docs/guides/clients.md)
- [Sessions and state](docs/guides/sessions-state.md)
- [Environments and sandboxes](docs/guides/environments-sandboxes.md)
- [Testing](docs/guides/testing.md)
- [CLI](docs/guides/cli.md)
- [GitHub and persistent coding-agent example](docs/guides/github-opencode-example.md)

The installable coding-agent skill is [skills/simple-agent-orchestrator/SKILL.md](skills/simple-agent-orchestrator/SKILL.md), with supporting references in the same directory. It is included in the npm package for use by agents working in consumer projects. Treat it as a public product surface: whenever behavior, API, CLI usage, recommended patterns, templates, or limitations change, update and verify the skill in the same change.

## Data Flow

1. A channel poll, CLI command, or project integration calls `runtime.dispatch(channelId, event)`.
2. Dispatch defaults `dedupeKey` to `event.id` and `sessionKey` to `${channelId}:${event.id}`.
3. Dedupe is scoped to `channelId + dedupeKey`.
4. A new event creates one pending delivery for every matching client handler.
5. A worker claims a delivery, increments its attempt, and resolves or creates an active session.
6. The runtime ensures the client environment is mounted and creates its sandbox if needed.
7. The runtime calls `handle`, then `onSuccess`.
8. Success persists session mutations and notes and marks the delivery `processed`.
9. Failure calls `onFailure`, records the error, and returns the delivery to `pending` or marks it `failed`.
10. Ended sessions remain as history; a later event with the same key creates a new active session.

## Behavioral Invariants

Preserve these contracts unless implementation, tests, and documentation are deliberately changed together.

- Dispatch persists the event and matching deliveries before returning `queued`.
- Duplicate dispatch returns the original internal event ID and creates no new deliveries.
- Events fan out across clients and across handlers on one client.
- Channel and client IDs are globally unique. Handler IDs are unique within a client.
- Retry precedence is handler override, client default captured at handler registration, config default, then three attempts.
- `handle` runs before `onSuccess`. An error from either fails the attempt.
- `onFailure` runs when a handler context exists; an error from `onFailure` is logged and does not replace the delivery error.
- Manual retry applies only to `failed` deliveries and grants one additional attempt.
- Ordinary session mutations and notes persist only after a successful attempt.
- `session.ensure` values persist eagerly and survive a failed attempt.
- Sandbox creation state persists eagerly so handler retries reuse the same sandbox.
- Sandbox cleanup is part of the delivery attempt: it runs after `handle` and `onSuccess`, but before final success persistence. Cleanup failure fails the attempt.
- `session.get` throws when a value is absent; use `getOptional`, `has`, or `ensure` when absence is valid.
- `session.end()` preserves history and cannot be undone by a concurrently completing handler.
- Concurrent deliveries merge mutations to different session-state keys.
- Concurrent writes to the same state key use completion-order last-write-wins behavior.
- Executions of the same poll do not overlap within one runtime process.
- `jsonFileStore` permits one active `start` or `drain` runtime per state file, releases ownership on `stop()`, and reclaims locks whose owning PID has exited.
- Poll mapping is sequential. Mapped events are durably dispatched before `commit`.
- Cursor mutations made during a poll persist only after `fetch`, `map`, dispatch, and `commit` complete.
- Poll cursor identity is `${channelId}:${pollRegistrationIndex}`; reordering polls can reinterpret persisted cursors.
- `memoryStore` isolates reads and writes by cloning.
- `jsonFileStore` does not replace malformed state silently and writes via temporary file plus rename.
- Persisted event, session, note, and cursor values must be JSON-safe when using `jsonFileStore`.
- Dispatch may return `queued` with no matching handlers. Sessions are created only when a delivery is processed.

## Lifecycle And Concurrency

- Treat an `OrchestratorRuntime` as one-shot. Its abort controller remains aborted after `stop()`.
- Normal `start()` mounts environments, starts pollers, and starts client workers.
- `start({ drain: true })` polls once, drains pending deliveries, and always stops and unmounts before resolving.
- Direct `drain()` mounts environments but does not unmount them; its caller must eventually call `stop()`.
- Environment instances are scoped by client ID and environment ID. Their values are process-local.
- Mount hooks run in registration order. Unmount hooks run in reverse order.
- Shutdown is cooperative. Handlers and hooks must observe their `AbortSignal` when appropriate.
- `workers` controls in-process parallelism.
- `perSession: true` serializes same-session deliveries for that client only within one runtime process; every participating client must opt in for runtime-wide same-session serialization.
- Session merging, `session.ensure`, sandbox locks, poll locks, and `StoreMutex` provide only in-process coordination.
- Sandbox creation and cleanup are serialized per session/environment in one process.
- Sandbox cleanup runs only after `handle` and `onSuccess` succeed and the handler called `session.end()`.
- Keep external side effects idempotent because delivery state and external systems are not one transaction.
- Do not run mutating CLI commands such as dispatch, retry, or session end concurrently with a long-running runtime when using `jsonFileStore`.

## Accepted Limitations

Do not claim these are solved unless code and regression tests explicitly solve them.

- The JSON store rejects multiple active runtimes but is not safe for general concurrent writers; runtime ownership is not cross-process store locking for offline mutations.
- JSON-store runtime ownership requires a local filesystem with atomic hard-link support.
- Persisted state has no schema-validation or migration system. The JSON store currently coerces the read version to `1` instead of rejecting unsupported versions.
- There is no distributed worker coordination or distributed per-session lock.
- Runtime lifecycle calls do not yet have complete duplicate-start or restart guards.
- A crash can leave a delivery permanently `processing`; stale-claim recovery is not implemented.
- Processing is not exactly once, and retries can repeat external side effects.
- Retries have no delay, backoff, timeout, schedule, or dead-letter queue.
- Only memory and JSON-file stores ship.
- There is no retention, compaction, or pruning policy.
- Sandbox creation has a crash window between external creation and marker persistence.
- `session.ensure` has the same crash window between external factory work and value persistence; factories must be retry-safe.
- Sandbox markers are keyed by environment ID, not client ID, and can collide when clients with the same environment ID share a session.
- Administrative `sessions end` does not invoke sandbox cleanup.
- Runtime shutdown unmounts environments but does not clean every active session sandbox.
- Poll dispatch, source acknowledgement, cursor commit, and external effects are not transactionally coupled.
- `dev` has no watch or reload behavior.
- No webhook server, provider integration, prompt renderer, approval system, or agent queue is bundled.
- TypeScript config files are transpiled by `tsx` at runtime, not type-checked while loading.
- `doctor` validates config loading, identifiers, and store initialization; it does not execute environment hooks, polls, handlers, or sandboxes.
- `paused` and `failed` are session status types, but pause/resume and session-failure workflows are not implemented.
- After a session key has historical and active records, lookup by key can select an older record; use the session ID when the distinction matters.

## Code Conventions

- Use ESM and NodeNext conventions. Package source and test imports use `.js` specifiers. Generated project templates deliberately use `.ts` for local imports.
- Keep Node.js 20 compatibility and avoid dependencies for functionality already provided by Node.
- Preserve strict TypeScript, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Prefer `import type` for type-only imports.
- Keep the builder-style channel, client, and environment APIs.
- Keep public exports explicit in `src/index.ts`, `src/runtime/index.ts`, and `src/testing/index.ts`.
- Follow existing formatting: two spaces, double quotes, semicolons, and trailing commas.
- There is no lint or formatter command; do not claim lint passed.
- Keep durable identifiers stable. Changing channel IDs, handler IDs, poll order, keys, or sandbox markers can reinterpret persisted state.
- Keep state mutations and read-modify-write sequences inside the runtime mutex. Read-only snapshot inspection may remain outside it.
- Do not make ordinary session writes eager; failed attempts intentionally roll them back.
- Do not make `session.ensure` or sandbox bookkeeping success-only; retries rely on eager persistence.
- Avoid concurrent config loads that depend on different working directories because config loading temporarily changes `process.cwd()`.

## Change Workflow

- Add or change a failing behavioral test before changing runtime semantics.
- Use `createTestRuntime` for normal dispatch, retry, session, note, and event assertions.
- Use `createRuntime`, `deferred`, and `waitFor` from `tests/helpers.ts` for lifecycle and concurrency tests.
- Coordinate concurrency tests with barriers or deferred promises, not arbitrary timing.
- Use temporary directories for CLI, project-loading, and JSON-store tests.
- Exercise public behavior where practical; test internals only when a contract cannot be observed publicly.
- Persistence changes need success, failure, retry, concurrency, and restart coverage as applicable.
- CLI or template changes need a temporary-project integration test.
- Keep changes focused. Do not combine unrelated cleanup with feature work, and do not rewrite working code only to match a preference.
- Read the affected implementation, tests, public exports, docs, template, and skill before changing a public contract.

## Verification

Use proportionate checks during development, then broaden them according to impact.

- Every behavior fix or feature: run the smallest relevant test first, add a regression test, then run `npm run typecheck`.
- Shared runtime, persistence, lifecycle, concurrency, public API, CLI, or template changes: run the full suite, typecheck, and build.
- Large changes: also exercise the real CLI/runtime in a temporary project. Process a manual event, run `start --drain`, and inspect the resulting delivery/session. Tests alone are not sufficient.
- Export, package metadata, build, binary, template, skill, or release-facing changes: inspect the packed artifact and install it into a clean temporary consumer. Verify `.`, `./runtime`, and `./testing` imports as applicable and run the installed CLI.
- Documentation-only changes: verify links, paths, examples, commands, and statements against source. Full code checks are optional unless documentation exposes a discovered inconsistency.

Full verification from the repository root:

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Focused tests:

```bash
npx vitest run tests/runtime-behavior.test.ts
npx vitest run tests/runtime-concurrency.test.ts
npx vitest run tests/cli.test.ts
```

An end-to-end package smoke test should perform this sequence in a temporary consumer:

1. From the repository root, run `npm run pack:local`; then install the resulting archive into an empty npm project.
2. From the temporary consumer, run `npx simple-agent-orchestrator init` and `npx simple-agent-orchestrator doctor`.
3. Import `loadProjectOrchestrator` from `simple-agent-orchestrator/runtime` in a short Node script, call `runtime.dispatch("manual", { id: "smoke-1", sessionKey: "smoke", input: "Smoke test" })`, and exit without draining. This leaves a pending delivery using only public package APIs.
4. Run `npx simple-agent-orchestrator start --drain` to execute the installed CLI, orchestrator, and handler.
5. Run `npx simple-agent-orchestrator sessions show smoke` and `npx simple-agent-orchestrator events list`; confirm the delivery is `processed`.
6. Remove the temporary consumer and local package archive.

Tarball installation may need registry access for the package's dependencies unless npm's cache is already populated. Keep the runtime sequence sequential when using the generated JSON store; do not run a second mutating process beside `start`.

## Documentation Synchronization

When behavior or public API changes, update all affected surfaces in the same change:

- `README.md`
- `docs/api-reference.md`
- Relevant files under `docs/guides/`
- `docs/design-principles.md` when ownership or scope changes
- `templates/default/`
- `skills/simple-agent-orchestrator/`
- Package exports and public index files
- CLI usage text and CLI guide

The package's API and the consumer-facing skill must agree on imports, method signatures, synchronous versus asynchronous methods, failure semantics, safe state access, lifecycle ordering, and CLI commands. Run examples mentally and typecheck executable examples where practical; do not only search and replace names.

Do not reintroduce stale generated claims:

- `createSessionResource`, `session.resource`, `client.useResource`, and `untrustedMarkdown` are not package APIs.
- `--process` and `events deliveries` are not CLI features.
- Cursor and environment methods are synchronous.
- `HandlerContext.environment` and `signal` are present, not optional.
- Register `onUnmount` on the environment builder during setup, not on the mounted environment instance.

## Security And Dependency Review

Every change gets a final security pass appropriate to its impact.

- Inspect changed code for unsafe command execution, path traversal, temporary-file races, secret exposure, untrusted input handling, accidental code execution, and persistence/logging of sensitive data.
- Treat project configs as trusted executable code, not a sandbox or security boundary.
- Remember that JSON state and default logs are plaintext and are not automatically redacted. Do not persist credentials or tokens in events, notes, session state, or cursors without an explicit design decision.
- Preserve idempotency for external side effects because handlers, success hooks, cleanup, and eager resource creation can repeat.
- When `package.json` or `package-lock.json` changes, inspect the dependency diff, runtime footprint, Node.js 20 support, lifecycle scripts, and licenses. Run `npm audit --audit-level=high` and report unresolved findings.
- Never use `npm audit fix --force` or widen dependency ranges automatically. Apply and test intentional upgrades.
- Do not publish, add credentials, or change release authorization unless explicitly requested.

For code changes, run `npm audit --audit-level=high` during final verification when registry access is available. If it cannot run, report that rather than claiming a clean scan.

## Review And Cleanup Loop

Before finishing any change:

1. Review the complete diff for correctness, regressions, failure paths, concurrency assumptions, public compatibility, security, and unnecessary complexity. For substantial work, use an independent sub-agent/reviewer when available.
2. Check tests, type declarations, exports, docs, templates, CLI help, and the shipped skill for drift according to the change triggers above.
3. Check for dead code, duplicate helpers, stale comments, debug output, generated state, logs, temporary files, package archives, and unrelated edits. Prefer removing newly introduced clutter over broad refactoring.
4. Fix every concrete in-scope finding and rerun affected checks.
5. Re-review the resulting diff. Continue until one pass finds no actionable in-scope issue, up to three complete review passes. If findings remain after that, the same issue survives two fix attempts, or a larger product decision is required, stop the loop and report the blocker or residual risk explicitly.

## Completion Checklist

- The behavior change has a regression test.
- Failure-path persistence was checked, not only the success path.
- Same-session concurrency and multi-process limitations were considered.
- External side effects are idempotent or their duplicate risk is documented.
- Public exports, package metadata, CLI usage, docs, templates, and skill references agree.
- No accepted limitation is described as solved.
- Required focused, full, runtime-smoke, and package checks passed for the change's impact.
- The security and dependency review completed, with unresolved findings reported.
- Package contents were checked when exports, templates, or metadata changed.
- Generated state, logs, temporary files, and package archives are not included accidentally.
- A final review pass found no actionable in-scope issue, or the remaining blocker was reported.
