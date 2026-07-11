# Simple Agent Orchestrator

Simple Agent Orchestrator is a dependency-light Node.js 20+ TypeScript library and CLI for routing events into durable, retryable agent sessions inside an existing project.

## Five-minute start

Run this from an existing npm project with a valid `package.json`:

```bash
npm install -D simple-agent-orchestrator
npx simple-agent-orchestrator init
npx simple-agent-orchestrator doctor
npx simple-agent-orchestrator dispatch manual --id first-event --session demo --input "Hello"
npx simple-agent-orchestrator events list
npx simple-agent-orchestrator sessions list
```

`init` discovers the nearest parent package unless `--root` is supplied. It creates only `.simple-agent-orchestrator/`; it does not edit the host `package.json`. Re-running requires `--force`, which overwrites known template files but preserves unknown files.

The generated project is deliberately small:

```text
.simple-agent-orchestrator/
  .gitignore
  package.json
  tsconfig.json
  orchestrator.ts
  channels/manual.ts
  clients/example.ts
```

The example client only logs event and session identifiers. Replace it with project-owned agent code, then run the long-lived runtime:

```bash
npx simple-agent-orchestrator start
```

Ordinary `start` runs pollers, workers, and an HTTP listener on `127.0.0.1:3000`. Use `--no-http` to disable HTTP or `--drain` to poll once, process currently eligible work, and exit.

## Mental model

- A **channel** receives normalized events or polls a source.
- An **event** is durably ingested and deduplicated by `channelId + dedupeKey`.
- Each matching client handler gets an independent **delivery** with retries.
- A **session** preserves state and notes for related events sharing a `sessionKey`.
- A client **environment** owns process-local resources and an optional session sandbox.
- The one-process **runtime** coordinates persistence, workers, polls, lifecycle, and optional HTTP.

Definitions returned by `createChannel`, `createClient`, and `createEnvironment` are inspectable and readonly-typed, but they are not frozen. Builder callbacks configure mutable definitions. A runtime snapshots registrations when `init()` first runs; changes after that do not affect that runtime. Live runtime reconfiguration is unsupported.

## Critical warnings

- Processing is retryable, not exactly once. Handlers, hooks, sandbox operations, and external effects can repeat. Use stable external idempotency keys or reconciliation.
- The default JSON store supports one active mutating runtime or offline operation per state file. Stop `start` before CLI `dispatch`, `sessions end`, `events retry`, or `state prune --apply`.
- JSON state, event content, session state, notes, errors, and ordinary project/default logs are plaintext and are not automatically redacted. Do not persist or log credentials or sensitive source content without an explicit policy.
- Built-in operational HTTP summaries omit event bodies, session state, notes, and errors. That does not constrain project middleware, custom routes, handlers, or logging. HTTP has no built-in authentication, provider signature verification, CORS, rate limiting, or TLS.
- `POST /webhooks/:channelId` confirms durable ingestion, not successful processing. Add authentication and source verification before exposure.
- Handler timeouts and shutdown are cooperative. Project code must pass `signal` to cancellation-aware operations.

## Common tasks

- [Documentation index](docs/index.md)
- [Getting started](docs/guides/getting-started.md)
- [Project integration](docs/guides/project-integration.md)
- [Channels and dispatch](docs/guides/channels.md)
- [Clients, retries, and timeouts](docs/guides/clients.md)
- [Sessions and state](docs/guides/sessions-state.md)
- [Environments and sandboxes](docs/guides/environments-sandboxes.md)
- [Testing](docs/guides/testing.md)
- [CLI](docs/guides/cli.md)
- [Failure semantics and idempotency](docs/guides/failure-semantics.md)
- [API reference](docs/api-reference.md)
- [Design principles](docs/design-principles.md)

The package is ESM-only and requires Node.js 20 or newer. It ships public package subpaths `.`, `./runtime`, and `./testing`.

## License

MIT
