# Single-Process Enforcement

## Objective

Protect a project from accidentally running multiple active orchestrator runtimes against state intended for one local process.

## Why

The runtime, JSON store, session locks, polling locks, and worker coordination are intentionally process-local. Concurrent orchestrator processes can lose writes or process the same work without providing any useful supported capability. Rejecting accidental concurrency is simpler and safer than adding distributed coordination.

## Goals

- Make the single-active-runtime constraint explicit and enforceable.
- Fail early with a useful explanation when another active runtime owns the project.
- Allow normal recovery after an earlier runtime exits unexpectedly.
- Keep direct library use, tests, and one-shot commands practical.
- Ensure the behavior is consistent with the documented local-only execution model.

## Scope Boundaries

- Do not add distributed locks, leases, consensus, or cross-machine coordination.
- Do not make the JSON store safe for general concurrent writers.
- Do not turn process ownership into a hosted control-plane feature.

## Completion Signals

- A second active runtime cannot silently operate on the same project state.
- A stale ownership condition does not permanently prevent future starts.
- Errors explain what is running and what the user should do next.
