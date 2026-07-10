# AGENTS.md

## Purpose

Simple Agent Orchestrator is a dependency-light Node.js 20+ TypeScript library and CLI for embedding event-driven agent orchestration inside an existing project.

The framework owns event ingestion, deduplication, deliveries, retries, durable sessions, state, notes, polling cursors, client environments, session sandboxes, config discovery, and operational inspection.

User integrations own source APIs, webhooks, prompts, agent/tool invocation, source acknowledgement, authorization, security policy, and project-specific resource behavior.

Do not turn this project into a hosted platform, general workflow engine, or bundled provider integration without an explicit requirement.

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

Public package subpaths are `.`, `./runtime`, and `./testing`. The package is ESM-only.

## Data Flow

1. A channel poll, CLI command, or project integration calls `runtime.dispatch(channelId, event)`.
2. Dispatch defaults `dedupeKey` to `event.id` and `sessionKey` to `${channelId}:${event.id}`.
3. Dedupe is scoped to `channelId + dedupeKey`.
4. A new event creates one pending delivery for every matching client handler.
5. A worker claims a delivery, increments its attempt, and resolves or creates an active session.
6. The runtime mounts the client environment and creates its sandbox if needed.
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
- `session.get` throws when a value is absent; use `getOptional`, `has`, or `ensure` when absence is valid.
- `session.end()` preserves history and cannot be undone by a concurrently completing handler.
- Concurrent deliveries merge mutations to different session-state keys.
- Concurrent writes to the same state key use completion-order last-write-wins behavior.
- Executions of the same poll do not overlap within one runtime process.
- Poll mapping is sequential. Mapped events are durably dispatched before `commit`.
- Cursor changes persist only after `fetch`, `map`, dispatch, and `commit` complete.
- Poll cursor identity is `${channelId}:${pollRegistrationIndex}`; reordering polls can reinterpret persisted cursors.
- `memoryStore` isolates reads and writes by cloning.
- `jsonFileStore` does not replace malformed state silently and writes via temporary file plus rename.
- Persisted event, session, note, and cursor values must be JSON-safe when using `jsonFileStore`.

## Lifecycle And Concurrency

- Treat an `OrchestratorRuntime` as one-shot. Its abort controller remains aborted after `stop()`.
- Normal `start()` mounts environments, starts pollers, and starts client workers.
- `start({ drain: true })` polls once, drains pending deliveries, and always stops and unmounts before resolving.
- Direct `drain()` mounts environments but does not unmount them; its caller must eventually call `stop()`.
- Environment instances are scoped by client ID and environment ID. Their values are process-local.
- Mount hooks run in registration order. Unmount hooks run in reverse order.
- Shutdown is cooperative. Handlers and hooks must observe their `AbortSignal` when appropriate.
- `workers` controls in-process parallelism.
- `perSession: true` serializes same-session deliveries only within one runtime process.
- Session merging, `session.ensure`, sandbox locks, poll locks, and `StoreMutex` provide only in-process coordination.
- Sandbox creation and cleanup are serialized per session/environment in one process.
- Sandbox cleanup runs only after `handle` and `onSuccess` succeed and the handler called `session.end()`.
- Keep external side effects idempotent because delivery state and external systems are not one transaction.

## Accepted Limitations

Do not claim these are solved unless code and regression tests explicitly solve them.

- The JSON store is not safe for multiple orchestrator processes; atomic rename is not cross-process locking.
- There is no distributed worker coordination or distributed per-session lock.
- A crash can leave a delivery permanently `processing`; stale-claim recovery is not implemented.
- Processing is not exactly once, and retries can repeat external side effects.
- Retries have no delay, backoff, timeout, schedule, or dead-letter queue.
- Only memory and JSON-file stores ship.
- There is no retention, compaction, or pruning policy.
- Sandbox creation has a crash window between external creation and marker persistence.
- Administrative `sessions end` does not invoke sandbox cleanup.
- Runtime shutdown unmounts environments but does not clean every active session sandbox.
- Poll dispatch, source acknowledgement, cursor commit, and external effects are not transactionally coupled.
- `dev` has no watch or reload behavior.
- No webhook server, provider integration, prompt renderer, approval system, or agent queue is bundled.
- TypeScript config files are transpiled by `tsx` at runtime, not type-checked while loading.
- `doctor` validates config loading, identifiers, and store initialization; it does not execute environment hooks, polls, handlers, or sandboxes.
- `paused` and `failed` are session status types, but pause/resume and session-failure workflows are not implemented.

## Code Conventions

- Use ESM and NodeNext conventions. TypeScript source imports use `.js` specifiers.
- Keep Node.js 20 compatibility and avoid dependencies for functionality already provided by Node.
- Preserve strict TypeScript, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Prefer `import type` for type-only imports.
- Keep the builder-style channel, client, and environment APIs.
- Keep public exports explicit in `src/index.ts`, `src/runtime/index.ts`, and `src/testing/index.ts`.
- Follow existing formatting: two spaces, double quotes, semicolons, and trailing commas.
- There is no lint or formatter command; do not claim lint passed.
- Keep durable identifiers stable. Changing channel IDs, handler IDs, poll order, keys, or sandbox markers can reinterpret persisted state.
- Keep store reads and writes for runtime state inside the runtime mutex.
- Do not make ordinary session writes eager; failed attempts intentionally roll them back.
- Do not make `session.ensure` or sandbox bookkeeping success-only; retries rely on eager persistence.
- Avoid concurrent config loads that depend on different working directories because config loading temporarily changes `process.cwd()`.

## TDD Workflow

- Add or change a failing behavioral test before changing runtime semantics.
- Use `createTestRuntime` for normal dispatch, retry, session, note, and event assertions.
- Use `createRuntime`, `deferred`, and `waitFor` from `tests/helpers.ts` for lifecycle and concurrency tests.
- Coordinate concurrency tests with barriers or deferred promises, not arbitrary timing.
- Use temporary directories for CLI, project-loading, and JSON-store tests.
- Exercise public behavior where practical; test internals only when a contract cannot be observed publicly.
- Persistence changes need success, failure, retry, concurrency, and restart coverage as applicable.
- CLI or template changes need a temporary-project integration test.

Run during development:

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

`npm run pack:local` builds through `prepack` and creates a package archive. Remove local archives after inspection.

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

Do not reintroduce stale generated claims:

- `createSessionResource`, `session.resource`, `client.useResource`, and `untrustedMarkdown` are not package APIs.
- `--process` and `events deliveries` are not CLI features.
- Cursor and environment methods are synchronous.
- `HandlerContext.environment` and `signal` are present, not optional.
- Register `onUnmount` on the environment builder during setup, not on the mounted environment instance.

## Pre-Finish Checklist

- The behavior change has a regression test.
- Failure-path persistence was checked, not only the success path.
- Same-session concurrency and multi-process limitations were considered.
- External side effects are idempotent or their duplicate risk is documented.
- Public exports, package metadata, CLI usage, docs, templates, and skill references agree.
- No accepted limitation is described as solved.
- `npm test`, `npm run typecheck`, and `npm run build` pass.
- Package contents were checked when exports, templates, or metadata changed.
- Generated state, logs, temporary files, and package archives are not included accidentally.
