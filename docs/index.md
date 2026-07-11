# Simple Agent Orchestrator documentation

Use Simple Agent Orchestrator when you want events from your project to trigger AI agent code without building all the surrounding bookkeeping yourself. It records incoming work, retries handlers when they fail, and lets related events continue with shared context. Your project remains in charge of agents, prompts, provider APIs, authentication, and business rules.

## Start here

1. [Build your first workflow](guides/getting-started.md) to install the package, run an event, write a handler, and try the HTTP server.
2. [Follow one event through the system](concepts.md) to understand channels, deliveries, sessions, and the runtime in context.
3. [Connect it to your project](guides/project-integration.md) when you're ready to call your own APIs and agent code.

## Build your integration

- [Receive events with channels](guides/channels.md): send events from project code, the CLI, an HTTP request, or an API poll.
- [Process events with clients](guides/clients.md): write handlers and choose retry, timeout, and concurrency behavior.
- [Keep context with sessions](guides/sessions-state.md): share state across related events, add notes, and mark completed work as ended.
- [Set up environments and sandboxes](guides/environments-sandboxes.md): provide reusable process resources and session-specific resources such as worktrees.
- [Test your integration](guides/testing.md): run events in memory and inspect exactly what happened.
- [Study a complete example](guides/github-opencode-example.md): poll GitHub reviews and send them to a coding agent, with one session and worktree per pull request.

## Run it day to day

- [Use the CLI](guides/cli.md): run the orchestrator, inspect events and sessions, retry failures, and remove old history.
- [Make handlers safe to retry](guides/failure-semantics.md): see which steps can repeat and when to tell a source system that you're finished.
- [Understand the package boundary](design-principles.md): see what the package handles and what stays in your application.

## Look up an API

- [API reference](api-reference.md): exports, signatures, options, defaults, return values, and startup and shutdown behavior for the root, runtime, and testing packages.
