# Integrate with your project

The common path is simple: keep your existing API and agent code where it is, then add a thin layer under `.simple-agent-orchestrator/` that turns source events into calls to that code. Provider SDKs, prompts, authentication, and business rules stay in your project.

## Start with a thin integration layer

Suppose your project already has GitHub and agent helpers under `src/`. A typical layout looks like this:

```text
my-project/
  package.json
  src/
    github.ts
    agent.ts
  .simple-agent-orchestrator/
    orchestrator.ts
    channels/
    clients/
    environments/
    package.json
    tsconfig.json
```

Your channel or client can import those helpers directly:

```ts
import { fetchReviews } from "../../src/github.ts";
```

Keep that dependency direction: orchestrator files call application code, while application code doesn't need to know how this project's channels and clients are assembled.

## Register your clients

A channel describes where events come from. A client subscribes your handler to those events. Register the client in `.simple-agent-orchestrator/orchestrator.ts`:

```ts
import { defineConfig } from "simple-agent-orchestrator";
import { codingClient } from "./clients/coding.ts";

export default defineConfig({
  clients: [codingClient],
  retries: { attempts: 3, delay: "5s" },
  timeout: "10m",
});
```

This example gives handlers three attempts with five seconds between failed attempts, plus a ten-minute timeout. The runtime reads the channel, client, and environment setup once during `init()`. If code changes that setup afterward, create and start a new runtime for the changes to take effect.

For the next step, build the channel that receives or polls your source and a client handler that calls your existing agent. The [channels guide](channels.md) and [clients guide](clients.md) show both sides.

## Resolve project files reliably

Commands may be run from different directories, so avoid building important paths from `process.cwd()`. Use a config factory and the supplied `project` helpers instead. The factory may be synchronous or asynchronous:

```ts
import { defineConfig, jsonFileStore } from "simple-agent-orchestrator";

export default defineConfig(({ project }) => ({
  store: jsonFileStore(project.statePath("state.json")),
}));
```

The most useful helpers are `fromRoot(...)` for application files, `fromOrchestrator(...)` for integration files, and `statePath(...)` for saved orchestrator data. The full set is:

| Value | Resolves from |
| --- | --- |
| `project.root` | Project root |
| `project.orchestratorDir` | `.simple-agent-orchestrator/` |
| `project.packageJson` | Parsed project package metadata |
| `project.resolve(...)` | Project root |
| `project.fromRoot(...)` | Project root |
| `project.fromOrchestrator(...)` | Orchestrator directory |
| `project.statePath(...)` | Orchestrator state directory |
| `project.cachePath(...)` | Orchestrator temporary directory |

## Run it

Once your channel and client are connected, check the project and start it:

```bash
npx simple-agent-orchestrator doctor
npx simple-agent-orchestrator start
```

`doctor` checks config loading, identifiers, and saved data without running hooks, polls, handlers, or sandboxes. `start` launches polls and workers and, by default, the HTTP server. Use `--no-http` when this integration doesn't accept HTTP, or `--drain` to poll once, process work that's ready, and exit.

That is the main integration path. The remaining sections cover config discovery, custom HTTP endpoints, and local data rules you'll need as the project moves beyond the first run.

## Go further

The integration is working at this point. The next sections cover the options you'll need when the default config path, HTTP event route, or JSON store no longer fits your project.

### Choose a config explicitly

Commands first use `--config` when supplied. Otherwise they look for these files under `.simple-agent-orchestrator/`, in order:

```text
orchestrator.ts
orchestrator.mts
orchestrator.cts
orchestrator.js
orchestrator.mjs
orchestrator.cjs
```

You can also point to a config from `package.json`:

```json
{
  "simpleAgentOrchestrator": {
    "config": ".simple-agent-orchestrator/orchestrator.ts"
  }
}
```

Usually the default `orchestrator.ts` is all you need. Use `--root <path>` in a monorepo or when running a command outside the target package:

```bash
npx simple-agent-orchestrator start --root packages/api
```

TypeScript configs run through `tsx`, so loading one executes trusted project code just like any other project file. The loader doesn't type-check it; use your editor or `tsc` for that.

### Add provider-specific HTTP routes

`start` can run a Hono server alongside polls and handlers. Put authentication and shared request checks in `middleware`. Add a custom route when a provider sends its own payload shape and signature, as GitHub does:

```ts
export default defineConfig({
  http: {
    hostname: "127.0.0.1",
    port: 3000,

    middleware({ app }) {
      app.use("*", authenticateRequest);
    },

    routes({ app, dispatch }) {
      app.post("/github/webhook", async (context) => {
        const event = await verifyAndMapGitHubRequest(context.req.raw);
        const result = await dispatch("github.reviews", event);
        return context.json(result, result.status === "queued" ? 202 : 200);
      });
    },
  },
});
```

The example functions come from your project because only your application knows how these requests should be trusted and translated. The package doesn't verify provider signatures or add authorization, CORS, rate limiting, or TLS.

Middleware runs first, followed by the built-in routes and then your custom routes. These built-in paths are reserved:

- `GET /health`
- `POST /webhooks/:channelId`
- `GET /api/v1/status`
- `GET /api/v1/events`
- `GET /api/v1/sessions`

Use `POST /webhooks/:channelId` when trusted code has already checked the request and converted it to a `DispatchEvent`. Use a custom route when the runtime itself needs to verify and translate a provider's original payload.

### Handle local saved data carefully

The CLI and programmatic `createRuntime()` use this JSON file by default:

```text
.simple-agent-orchestrator/state/state.json
```

It can contain event bodies, session state, notes, poll positions, and delivery errors in plaintext. Avoid credentials and source data you don't need.

The JSON store prevents another `start()`, `drain()`, or `runOffline()` operation from owning the same file. Stop the running orchestrator before using commands such as `dispatch`, `sessions end`, `events retry`, or `state prune --apply`.

For programmatic one-off changes, use a fresh runtime and `runOffline()`. Calling mutation methods on a runtime that is only initialized does not acquire the file lock by itself.

Anything saved in the JSON store must be valid JSON. Use strings, finite numbers, booleans, nulls, arrays, and plain objects. Avoid class instances, circular references, `undefined`, and non-finite numbers.

For store types, validation, locking, and state versions, see the [stores reference](../api-reference.md#stores-and-state).

## Next steps

- [Receive events with channels](channels.md).
- [Manage process resources with environments](environments-sandboxes.md).
- [Use the CLI](cli.md).
