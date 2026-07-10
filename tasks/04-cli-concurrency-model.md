# CLI Concurrency Model

## Objective

Define and enforce how mutating CLI commands behave when a long-running local orchestrator is active.

## Why

Commands such as `dispatch`, retry, and session ending run in separate processes. If they write directly to the same JSON state while `start` is running, they violate the package's single-process assumptions. The CLI should have a coherent local execution model rather than appearing safe while relying on unsupported concurrent writes.

## Goals

- Clearly distinguish commands that only inspect state from commands that mutate it.
- Define whether mutating commands are offline one-shot operations or communicate with an active runtime.
- Prevent unsupported simultaneous writes to local state.
- Keep common manual dispatch and recovery workflows simple.
- Align the getting-started guide, CLI help, and runtime behavior with the chosen model.

## Scope Boundaries

- Do not build a general remote administration API.
- Do not introduce distributed command routing.
- Prefer an explicit limitation over hidden multi-process coordination complexity.

## Completion Signals

- Users can tell which commands are safe while `start` is active.
- Unsupported command combinations fail predictably instead of racing the state store.
- CLI examples no longer imply a concurrency model the runtime does not support.
