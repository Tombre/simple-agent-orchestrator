# Documentation

## Start here

- [Getting started](guides/getting-started.md): initialize an existing package and process a manual event.
- [Project integration](guides/project-integration.md): layout, config discovery, runtime definitions, HTTP, and persistence.
- [API reference](api-reference.md): public exports from the root, runtime, and testing package subpaths.
- [CLI guide](guides/cli.md): strict command syntax, inspection, offline mutation, and exit behavior.

## Build an integration

- [Channels](guides/channels.md): polling, direct dispatch, event identity, dedupe, and cursors.
- [Clients and handlers](guides/clients.md): routing, retries, timeouts, hooks, and concurrency.
- [Sessions and state](guides/sessions-state.md): durable values, `ensure`, notes, and ending sessions.
- [Environments and sandboxes](guides/environments-sandboxes.md): process resources and session-scoped cleanup.
- [Testing](guides/testing.md): isolated test runtimes and state helpers.
- [GitHub and persistent coding-agent example](guides/github-opencode-example.md): a complete project-owned integration pattern.

## Operate safely

- [Failure semantics and idempotency](guides/failure-semantics.md): retries, rollback, interruption recovery, and plaintext data.
- [Design principles](design-principles.md): scope, ownership, and accepted architectural boundaries.
