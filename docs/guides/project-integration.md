# Project integration

The framework is designed to be embedded inside existing TypeScript repositories.

## Directory model

Recommended structure:

```text
my-project/
  package.json
  tsconfig.json
  src/
  .simple-agent-orchestrator/
    orchestrator.ts
    channels/
    clients/
    package.json
    tsconfig.json
    .gitignore
```

The orchestrator directory can import code from your project:

```ts
import { fetchRecentReviewCandidates } from "../../src/lib/github/reviews.ts";
```

The app should generally not import from `.simple-agent-orchestrator`. Keep the dependency direction as:

```text
.simple-agent-orchestrator -> project code
project code              -> does not need orchestrator config
```

## Config discovery

`simple-agent-orchestrator start` discovers config in this order:

1. `--config <path>` if provided.
2. `.simple-agent-orchestrator/orchestrator.ts` under the detected project root.
3. A package.json pointer:

```json
{
  "simpleAgentOrchestrator": {
    "config": ".simple-agent-orchestrator/orchestrator.ts"
  }
}
```

You can also run with an explicit root:

```bash
npx simple-agent-orchestrator start --root packages/api
```

`init` has a narrower contract than general runtime discovery. Without `--root`, it finds the nearest `package.json` above the current directory. The selected root must already contain a regular, valid, object-valued `package.json`. Initialization writes only known files under `.simple-agent-orchestrator` and does not edit the host manifest. `--force` replaces known template files while preserving files it does not own.

## Project context

`defineConfig` receives a `project` context:

```ts
export default defineConfig(({ project }) => ({
  store: jsonFileStore(project.statePath("state.json")),
}));
```

Available helpers:

```ts
project.root
project.orchestratorDir
project.packageJson
project.resolve("src")
project.fromRoot("src")
project.fromOrchestrator("prompts/review.md")
project.statePath("state.json")
project.cachePath("scratch")
```

Use these helpers instead of long relative path chains.

## HTTP integration

Ordinary `start` owns one project-level Hono server alongside polling and workers:

```ts
export default defineConfig({
  http: {
    hostname: "127.0.0.1",
    port: 3000,
    middleware({ app }) {
      app.use("*", projectAuthenticationMiddleware);
    },
    routes({ app, dispatch }) {
      app.post("/source", async (context) => {
        const event = await parseAndVerifySourceRequest(context.req.raw);
        const result = await dispatch("source", event);
        return result.status === "queued"
          ? context.json(result, 202)
          : context.json(result, 200);
      });
    },
  },
});
```

Middleware is registered before built-ins; custom routes are registered afterward. Hooks also receive `project`, `logger`, and the runtime `signal`. Built-ins are `GET /health`, normalized `POST /webhooks/:channelId`, and bounded read-only `GET /api/v1/status`, `/api/v1/events`, and `/api/v1/sessions`; their namespaces are reserved. Middleware that inspects a body needed by a later handler should read `context.req.raw.clone()`. Provider-specific parsing, authentication, signatures, source acknowledgement, CORS, rate limiting, TLS, and public exposure policy remain project responsibilities.

The normalized webhook requires `application/json`, limits encoded bodies to 1 MiB, rejects unknown or non-JSON-safe fields, and durably dispatches before returning `202 queued` or `200 duplicate`. It does not wait for delivery processing. Built-in operational lists default to 25 and allow at most 100; they omit event bodies and metadata, session state and notes, delivery errors, and individual deliveries. This is a contract of those built-in routes, not of project middleware, custom routes, handlers, or loggers. Add security middleware before exposure because unauthenticated ingress can trigger external effects and unbounded state growth. HTTP belongs at project/runtime scope rather than in a client environment, which may be mounted once per client.

## Definition and runtime boundary

`createChannel`, `createClient`, and `createEnvironment` run their builder callbacks immediately. Builders configure mutable definition data; the returned definitions expose that data through readonly TypeScript types for inspection and composition, but the objects and arrays are not frozen.

The runtime snapshots channels, polls, clients, handlers, retry settings, and HTTP/config collections when `runtime.init()` first succeeds. Changes made before initialization are observed. Changes made to config arrays or definitions after initialization do not reconfigure that runtime. Live add/remove/reload behavior is unsupported; create a fresh runtime for changed definitions.

## TypeScript loading

The runtime loads `.ts`, `.mts`, and `.cts` config files through `tsx`. It does not type-check config at runtime; use your editor or `tsc` for type checking.

The init command creates `.simple-agent-orchestrator/tsconfig.json` so your editor can type-check orchestrator files in the context of your project.

## Runtime state

The default runtime store writes mutable state under:

```text
.simple-agent-orchestrator/state/state.json
```

The state directory is git-ignored by default.

State and ordinary logging are plaintext and are not automatically redacted. Event input/payload/meta, session state, notes, cursor values, and stored errors may be sensitive. The generated example client logs identifiers only, but project code controls its own logs and must avoid secrets or sensitive content.

You can change the store in `orchestrator.ts`:

```ts
export default defineConfig(({ project }) => ({
  store: jsonFileStore(project.statePath("state.json")),
}));
```

The store interface is intentionally small so you can add a database-backed adapter later.

JSON state version 3 is current. The store validates the full snapshot before any runtime work and before replacing the file. Valid version 1 and 2 snapshots are migrated deterministically in memory with immediate retry defaults and persisted as version 3 by the next successful write. Inspection, including `state validate`, does not rewrite them. Older, future, malformed, structurally invalid, or internally inconsistent snapshots fail with the state path and recovery guidance instead of being coerced or replaced. Back up the file before manual recovery, and use an intermediate package version when a state version falls below the documented minimum.

State, event payloads, metadata, notes, and cursors must contain only JSON-safe values with at most 100 nested levels. The normalized webhook enforces that constraint before dispatch. The state validator rejects values that JSON would silently drop or reinterpret, including `undefined`, non-finite numbers, and non-plain objects in durable value positions. Custom stores should return a valid current `OrchestratorState`; `validateAndMigrateState` is exported for adapters that need the package validator.

`jsonFileStore` also creates sibling `.runtime-lock` ownership records while `start()`, `drain()`, or `runOffline()` is active. A second runtime or offline operation for the same state fails early with the owning PID and start time; a lock left by a process that has exited is reclaimed automatically. The active lock is released by `stop()`, including automatic shutdown after `start({ drain: true })` and `runOffline()`; abrupt acquisition-stage exits may leave harmless `.candidate` sidecars, and generation-qualified recovery records remain after crash recovery to make concurrent takeover safe.

Atomic first-run state initialization and ownership records use hard links and require a local hard-link-capable filesystem. Unsupported filesystems fail initialization or startup explicitly instead of risking state replacement or silently disabling enforcement.

This enforces the supported one-active-runtime model, but it does not make the JSON store safe for arbitrary concurrent writers. Once ownership is acquired, startup and drain requeue deliveries left `processing` by an interrupted owner before workers claim work. CLI `dispatch`, `sessions end`, `events retry`, and `state prune --apply` acquire ownership for their complete offline operation and fail before writing while a runtime is active. A retention preview remains read-only. Direct library mutations remain unsafe unless the caller scopes them with `runtime.runOffline(...)`.

Long-running projects can explicitly preview and apply conservative history pruning with `state prune --before <timestamp>`. It never changes cursors or operational delivery records, and it keeps events as dedupe history unless `--drop-dedupe` is explicitly requested. Back up the JSON file before apply; retention is destructive and there is no archival or automatic background policy.
