# Simple Agent Orchestrator

Simple Agent Orchestrator helps you run event-driven AI agent code inside an existing Node.js project. You write the integration with your agent and source APIs; the orchestrator saves incoming events, retries failed handlers, and keeps context for related work.

## Try it in five minutes

From an existing Node.js 20+ project, install the package and create the starter files:

```bash
npm install -D simple-agent-orchestrator
npx simple-agent-orchestrator init
npx simple-agent-orchestrator doctor
```

Now send a sample event through the generated `manual` channel and inspect the result:

```bash
npx simple-agent-orchestrator dispatch manual --id first-event --session demo --input "Hello"
npx simple-agent-orchestrator events list
npx simple-agent-orchestrator sessions list
```

`init` finds the nearest Node.js project and adds `.simple-agent-orchestrator/` without editing your `package.json`. `doctor` checks that the generated config and saved data can be loaded. The `dispatch` command then runs the example handler, waits for work that's ready now, and exits.

Here's what was added:

```text
.simple-agent-orchestrator/
  .gitignore
  package.json
  tsconfig.json
  orchestrator.ts
  channels/manual.ts
  clients/example.ts
```

The example client only logs the event and session IDs. Replace that handler with your own agent code when you're ready. To leave the orchestrator running so it can poll sources, accept HTTP requests, and process new events, use:

```bash
npx simple-agent-orchestrator start
```

`start` tries to open an HTTP server at `127.0.0.1:3000` and logs the address it actually uses. Add `--no-http` if you don't need HTTP, or `--drain` to poll once, process work that's ready, and exit.

For a complete first run, including a useful handler and an HTTP request, follow [Build your first workflow](docs/guides/getting-started.md).

## How it fits together

- A **channel** represents one way events arrive, such as a GitHub poll or a project route.
- An **event** is one item from that source. It's saved before dispatch returns.
- A **client** subscribes a handler to a channel.
- A **delivery** records one handler's attempts to process one event, including retries.
- A **session** lets related events share state and notes, such as all comments on one pull request.
- A client's optional **capacity** limit keeps only a configured number of long-running external agent sessions active while new sessions wait.
- An **environment** gives a client process-local resources and can manage a session-specific sandbox, such as a worktree.
- The **runtime** runs all of this in one process and can also serve HTTP.

Set up channels, clients, and environments before initializing the runtime. It reads their setup once during `init()`, so code that changes them later won't reconfigure that runtime; create and start a new runtime instead.

## Where to go next

- [Documentation index](docs/index.md)
- [Build your first workflow](docs/guides/getting-started.md)
- [Follow one event through the core concepts](docs/concepts.md)
- [Receive events with channels](docs/guides/channels.md)
- [Process events with clients](docs/guides/clients.md)
- [Keep context with sessions](docs/guides/sessions-state.md)
- [Set up environments and sandboxes](docs/guides/environments-sandboxes.md)
- [Test your integration](docs/guides/testing.md)
- [Use the CLI](docs/guides/cli.md)
- [API reference](docs/api-reference.md)

## Before running it in production

- **Make outside actions safe to repeat.** A handler can run again after an error, timeout, or restart. The [retry guide](docs/guides/failure-semantics.md) shows how to avoid duplicate effects.
- **Secure HTTP in your application.** The package doesn't add authentication, provider signature checks, rate limiting, or TLS. See [project integration](docs/guides/project-integration.md#add-provider-specific-http-routes).
- **Treat files and logs as plaintext.** Event data, session state, notes, and errors may contain sensitive information. See [local saved data](docs/guides/project-integration.md#handle-local-saved-data-carefully).
- **Use one process per JSON state file.** The [CLI guide](docs/guides/cli.md#work-safely-with-the-json-state-file) explains which commands can run beside `start`.

The package requires Node.js 20 or newer and uses ESM. Most code imports from `simple-agent-orchestrator`; lower-level runtime and testing helpers are available from `simple-agent-orchestrator/runtime` and `simple-agent-orchestrator/testing`.

## License

MIT
