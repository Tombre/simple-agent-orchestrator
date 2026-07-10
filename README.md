# Simple Agent Orchestrator

Simple Agent Orchestrator is a small TypeScript framework for routing events from channels into durable agent sessions.

It is designed to be installed inside existing TypeScript projects. You add a project-local `.simple-agent-orchestrator` directory, define channels, clients, environments, and prompts there, and run the runtime from the project root:

```bash
npx simple-agent-orchestrator start
```

The framework gives you durable plumbing and gets out of your way:

- Channels discover or receive external events.
- Events are deduped and stored.
- Clients subscribe to channels and handle deliveries.
- Sessions preserve state across related events.
- Environments mount project resources and optional sandboxes.
- CLI commands let you inspect sessions, events, and failed deliveries.

## Install

```bash
npm install -D simple-agent-orchestrator
```

For a local checkout during development, install it by relative path instead:

```bash
npm install -D "file:../simple-agent-orchestrator"
```

The local install runs the package's `prepare` script to build `dist/`. Run
`npm install` in the local checkout first so its build dependencies are
available.

Then initialize your project:

```bash
npx simple-agent-orchestrator init
```

This creates:

```text
.simple-agent-orchestrator/
  orchestrator.ts
  channels/
    manual.ts
  clients/
    echo.ts
  environments/
  prompts/
  state/
  logs/
  tmp/
```

The state, log, and tmp directories are ignored by git by default.

## First run

Check the setup:

```bash
npx simple-agent-orchestrator doctor
npx simple-agent-orchestrator state validate
```

Send a manual event:

```bash
npx simple-agent-orchestrator dispatch manual \
  --id manual-1 \
  --session test-session \
  --input "Hello from a manual event"
```

List sessions:

```bash
npx simple-agent-orchestrator sessions list
```

Show a session:

```bash
npx simple-agent-orchestrator sessions show test-session
```

The `dispatch` command processes currently eligible work in a one-shot runtime and exits. A configured delayed retry remains durably pending for a later drain or long-running runtime. After this smoke test, start the long-running runtime for polls and project-owned dispatch integrations:

```bash
npx simple-agent-orchestrator start
```

The default JSON store supports one mutating orchestrator process. CLI `dispatch`, `sessions end`, and `events retry` are offline operations: they acquire the same ownership lock and fail before writing if `start` is active. Inspection commands, including `state validate`, remain available while the runtime is running.

## Project-local config

The runtime looks for:

```text
.simple-agent-orchestrator/orchestrator.ts
```

Example:

```ts
import { defineConfig, jsonFileStore } from "simple-agent-orchestrator";
import { githubReviewsChannel } from "./channels/github";
import { codingClient } from "./clients/coding";

export default defineConfig(({ project }) => ({
  name: String(project.packageJson.name ?? "local-project"),

  store: jsonFileStore(project.statePath("state.json")),

  channels: [githubReviewsChannel],

  clients: [codingClient],
}));
```

The config receives a project context so you can resolve paths relative to the repository root or the `.simple-agent-orchestrator` directory.

## Core example

```ts
import {
  createChannel,
  createClient,
  defineKey,
  sessionKey,
} from "simple-agent-orchestrator";

const githubPr = defineKey<{ owner: string; repo: string; number: number }>(
  "github.pr",
  { parts: ["owner", "repo", "number"] },
);

const agentSessionId = sessionKey<string>("opencode.sessionId");

export const githubReviewsChannel = createChannel(
  "github.reviews",
  (channel) => {
    channel.poll({
      every: "60s",

      async fetch() {
        return fetchRecentReviewCandidates();
      },

      async map(review) {
        return {
          id: review.id,
          dedupeKey: `github.review:${review.id}:${review.updatedAt}`,
          sessionKey: githubPr({
            owner: review.owner,
            repo: review.repo,
            number: review.prNumber,
          }),
          input: review.toMarkdown(),
          payload: review,
          meta: {
            branch: review.branch,
          },
        };
      },
    });
  },
);

export const codingClient = createClient("coding", (client) => {
  client.retries({ attempts: 3, delay: "5s" });
  client.timeout("10m");

  client.handle(githubReviewsChannel, async ({ event, session, signal }) => {
    const id = await session.ensure(agentSessionId, async () => {
      const created = await createAgentSession({
        idempotencyKey: `agent-session:${session.id}`,
        signal,
      });
      return created.id;
    });

    await sendToAgent(id, String(event.input), {
      idempotencyKey: `agent-message:${event.channelId}:${event.dedupeKey}`,
      signal,
    });
  });
});
```

## Important concepts

### Channel

A channel is an event source. It can poll, expose a manual dispatch target, or be wired to an external webhook/server in your project code.

### Event

An event is the durable unit of input. Events have a source `id`, optional `dedupeKey`, `sessionKey`, `input`, `payload`, and `meta`.

### Delivery

A delivery is a client/handler-specific attempt to process an event. One event can be delivered to multiple clients.

Delivery processing is retryable, not exactly once. Retries are immediate by default; a fixed `delay` can durably postpone automatic retries. An optional `timeout` cooperatively aborts a delivery attempt and applies the same retry rules. Integrations must pass the context `signal` to their own agents, subprocesses, and network APIs; JavaScript that ignores cancellation is still awaited and cannot be forcefully terminated. A later failure, timeout, or restart recovery can repeat handlers, hooks, and external effects even though event dispatch was deduped. See [Failure semantics and idempotency](docs/guides/failure-semantics.md).

### Client

A client subscribes to channels and handles deliveries. It is where you integrate with your actual agent, tool, or workflow code.

### Session

A session is durable state attached to a `sessionKey`. Related events reuse the same active session.

### Environment

An environment mounts shared resources for a client, such as local servers, API clients, credentials, or sandboxes.

## CLI

```bash
# Project setup and runtime
simple-agent-orchestrator init
simple-agent-orchestrator start
simple-agent-orchestrator dev

# Inspection (safe while start is active)
simple-agent-orchestrator doctor
simple-agent-orchestrator print-config
simple-agent-orchestrator state validate
simple-agent-orchestrator sessions list
simple-agent-orchestrator sessions show <id-or-key>
simple-agent-orchestrator events list

# Offline mutation (requires start to be stopped)
simple-agent-orchestrator dispatch <channel> --id <id> --session <sessionKey> --input <text>
simple-agent-orchestrator sessions end <id-or-key>
simple-agent-orchestrator events retry <delivery-id>
```

See [`docs/guides/cli.md`](docs/guides/cli.md) for details.

## Documentation

- [Getting started](docs/guides/getting-started.md)
- [Project integration](docs/guides/project-integration.md)
- [Channels](docs/guides/channels.md)
- [Clients and handlers](docs/guides/clients.md)
- [Failure semantics and idempotency](docs/guides/failure-semantics.md)
- [Sessions and state](docs/guides/sessions-state.md)
- [Environments and sandboxes](docs/guides/environments-sandboxes.md)
- [Testing](docs/guides/testing.md)
- [GitHub + persistent coding agent example](docs/guides/github-opencode-example.md)
- [CLI guide](docs/guides/cli.md)
- [API reference](docs/api-reference.md)
- [Design principles](docs/design-principles.md)

## Current implementation notes

This generated project is intentionally small and dependency-light. It ships with an in-memory store and a JSON-file store. The public store interface is small so that you can add a SQLite or Postgres adapter later without changing user code.

The JSON-file store strictly validates state before runtime work and writes. State version 3 is current; valid version 1 and 2 snapshots are upgraded deterministically in memory with immediate retry defaults and persisted as version 3 by the next successful write. Validation and inspection do not rewrite historical files. Malformed, structurally invalid, obsolete, and future versions fail with actionable errors and are not replaced. Run `state validate` for a read-only compatibility check.

The JSON-file store enforces one active runtime or offline operation per state file with a local PID lock and reclaims stale ownership after a process exits. Atomic first-run state initialization and runtime ownership require a local hard-link-capable filesystem and fail explicitly when the filesystem cannot provide atomic hard links. After acquiring ownership, startup and drain recover stale `processing` deliveries automatically. The CLI rejects offline mutations while `start` is active, but direct unscoped library writes remain unsafe. Multi-process worker coordination is not implemented.

The package is ESM-only and requires Node.js 20 or newer.

## Release verification

Before proposing a release, run the same package-level check used by CI:

```bash
npm run release:check
```

This builds the npm tarball, validates its release-facing files, installs it in a clean temporary consumer, checks all public package subpaths and declarations, initializes the packaged template, and exercises the installed CLI against persisted state. CI runs the test, typecheck, and build contract on Node.js 20, 22, 24, and 26, then runs the package-artifact check on Node.js 20 and 26 on Linux and Windows.

## License

MIT
