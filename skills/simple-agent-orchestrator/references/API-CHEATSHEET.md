# Simple Agent Orchestrator API cheatsheet

Use these imports from `simple-agent-orchestrator` unless the project has local wrappers.

## Config

```ts
import { defineConfig } from "simple-agent-orchestrator";

export default defineConfig(({ project }) => ({
  name: String(project.packageJson.name ?? "agent-orchestrator"),
  clients: [codingClient],
  timeout: "10m",
  http: {
    hostname: "127.0.0.1",
    port: 3000,
    middleware({ app }) {
      app.use("*", projectAuthenticationMiddleware);
    },
    routes({ app, dispatch }) {
      app.post("/source", async (context) => {
        const result = await dispatch("source", await verifiedEvent(context.req.raw));
        return result.status === "queued"
          ? context.json(result, 202)
          : context.json(result, 200);
      });
    },
  },
}));
```

The config lives at `.simple-agent-orchestrator/orchestrator.ts`. In this example, `codingClient` handles the channel whose ID is `source`. `projectAuthenticationMiddleware` and `verifiedEvent` are project-provided functions.

Configured clients register the exact channel definitions passed to their handlers. Use `channels` for additional definitions, including channels with no configured handler. Explicit channels are registered first, followed by handler channels in client and handler order; distinct definitions with the same channel ID are invalid.

Builders configure mutable channel/client/environment definitions immediately. Definitions are inspectable and readonly-typed but not frozen. Runtime `init()` snapshots registrations; later mutations do not affect that runtime. Live reconfiguration is unsupported.

Normal `start()` binds HTTP by default; `SAO_HTTP_PORT` overrides config, and `start({ http: false })` or CLI `--no-http` disables it. Middleware runs before built-ins and routes afterward. Built-ins are `GET /health`, `POST /webhooks/:channelId`, `GET /api/v1/status`, `GET /api/v1/events?limit=N`, and `GET /api/v1/sessions?limit=N`; their namespaces are reserved. Hooks receive the Hono `app`, `project`, `logger`, runtime `signal`, and durable `dispatch`. The server has no built-in authentication, signature checks, CORS, rate limiting, or TLS.

The webhook accepts a normalized JSON object up to 1 MiB. It requires non-empty `id` and permits `type`, `dedupeKey`, `sessionKey`, JSON-safe `input`/`payload`, object `meta`, and string `occurredAt`. It returns `202 queued` after durable ingestion or `200 duplicate` with the original internal event ID. Operational lists default to 25, max at 100, and omit event bodies, session state, notes, deliveries, and errors. Add middleware before exposure; unauthenticated dispatch can trigger side effects and state growth.

The `project` helper exposes stable paths:

```ts
project.root;
project.orchestratorDir;
project.fromRoot("src/lib/github");
project.fromOrchestrator("prompts/review.md");
project.statePath("state.json");
```

## Channels

```ts
import { createChannel, createManualChannel } from "simple-agent-orchestrator";

export const manualChannel = createManualChannel("manual");

export const githubReviewsChannel = createChannel("github.reviews", (channel) => {
  channel.poll({
    id: "reviews",
    every: "60s",

    async fetch({ cursor, pollStartedAt }) {
      const since = cursor.get<string>("lastUpdatedAt");
      return fetchRecentReviewCandidates({ since, updatedBefore: pollStartedAt });
    },

    async map(review) {
      return {
        id: review.id,
        type: "github.review",
        dedupeKey: `github.review:${review.id}:${review.updatedAt}`,
        sessionKey: `github.pr:${review.repo}:${review.prNumber}`,
        input: review.toMarkdown(),
        payload: review,
        meta: {
          repo: review.repo,
          branch: review.branch,
          prNumber: review.prNumber,
        },
      };
    },

    async commit({ cursor, items }) {
      const latest = items.map((item) => item.updatedAt).sort().at(-1);
      if (latest) cursor.set("lastUpdatedAt", latest);
    },
  });
});
```

Use a stable `id` for any poll whose cursor must survive registration reordering. Unnamed polls use their registration index. Duplicate resolved identities fail configuration validation. Changing an ID selects another cursor key rather than migrating state; a never-used key starts empty, while a historical ID restores its existing cursor.

`pollStartedAt` is a required ISO timestamp captured immediately before `fetch` and shared unchanged with `fetch`, every `map`, and `commit`. A poll map can return one `DispatchEvent`, a readonly array of events, or `null`/`undefined`. Arrays are flattened and dispatched sequentially in order; `commit.events` contains the same flattened order. A failure keeps events already dispatched but rolls back cursor changes.

Event fields:

```ts
type DispatchEvent = {
  id: string;
  type?: string;
  dedupeKey?: string;
  sessionKey?: string;
  input?: unknown;
  payload?: unknown;
  meta?: Record<string, unknown>;
  occurredAt?: string | Date;
};
```

The HTTP representation is JSON-only: `occurredAt` must be a valid string, values may nest at most 100 levels, identifiers are limited to 512 characters, and `type` to 256.

Every channel definition has `dispatch(event)`. It requires exactly one initialized runtime bound to that exact object and throws with zero or multiple bindings. Explicit runtime dispatch avoids ambiguity:

```ts
await runtime.dispatch(manualChannel, { id: "one" });
await runtime.dispatch("manual", { id: "two" });
```

Object dispatch requires the registered object identity; string dispatch resolves the registered ID.

## Clients

```ts
import { createClient, HandlerTimeoutError } from "simple-agent-orchestrator";

export const codingClient = createClient("coding", (client) => {
  client.useEnvironment(opencodeEnvironment);
  client.concurrency({ workers: 2, perSession: true });
  client.retries({ attempts: 3, delay: "5s" });
  client.timeout("10m");

  client.handle(githubReviewsChannel, {
    id: "coding.githubReviews",
    timeout: "2m",

    async handle({ event, session, environment, project, logger, signal }) {
      // Route event to persistent resource.
    },

    async onSuccess({ event }) {
      // Mark the source handled with a stable idempotency key.
    },
  });
});
```

Retry `attempts` and fixed `delay` resolve independently from handler options, client defaults, global config, then built-ins (`3` and `0`). Numbers are milliseconds; strings accept `ms`, `s`, `m`, and `h`. Positive fractions round up to one millisecond; the maximum is `2_147_483_647` ms (about 24.9 days). Delayed retries stay durably pending with `nextAttemptAt`. Normal workers wait for eligibility, while drains return without waiting; manual retry and interrupted-attempt recovery are immediate.

Timeout resolves from handler `timeout`, the `client.timeout(...)` value captured at registration, global config `timeout`, then `0` (disabled). An explicit zero disables inheritance. It cooperatively aborts sandbox creation, `handle`, `onSuccess`, and sandbox cleanup with `HandlerTimeoutError`, then applies ordinary retries. Pass `signal` through to project APIs. Work that ignores cancellation is still awaited, and external side effects may repeat. Runtime shutdown wins if it aborts first.

Retained capacity is disabled by default. `client.capacity({ maxActiveSessions: 5 })` reserves one durable slot per client and active session before the handler starts. New sessions stay pending without consuming an attempt when full; existing reserved sessions continue. Reservations survive handler return, failures, shutdown, and restart. A successful `capacity.release()` releases the current client's slot while `session.end()` releases all client slots for that session. Neither action stops external work.

Set `session: "existing-only"` on an object handler for completion work that must target an already-active session. Dispatch binds its exact session ID. Missing sessions are durably `ignored` with `session-missing`; sessions that end or disappear before a later claim are `ignored` with `session-ended`, without rebinding a replacement or running another phase. Work ignored before its first claim consumes no attempt. An ignored retry keeps prior attempt metadata and staged but uncommitted effects. Ignored work creates no session, capacity reservation, or sandbox. There is no `onIgnored`.

Handler context:

```ts
type HandlerContext = {
  event: OrchestratorEvent;
  session: Session;
  environment: EnvironmentInstance;
  client: ClientDefinition;
  project: ProjectContext;
  logger: Logger;
  attempt: number;
  signal: AbortSignal;
  capacity: { readonly reserved: boolean; release(): void };
  sandbox: {
    get<T extends JsonValue>(definition: ResourceSandboxDefinition<T>): Readonly<T>;
    getOptional<T extends JsonValue>(definition: ResourceSandboxDefinition<T>): Readonly<T> | undefined;
  };
};
```

Sandbox access uses configured definition identity, not an ID or structural match. `get` requires an active resource. `getOptional` returns `undefined` when there is no active resource, including a migrated active record without one. An `existing-only` handler does not create or reconcile before handling. If it explicitly ends the session, the later cleanup phase may reconcile uncertain saved state.

Exhaustion context provides an optional `ReadonlySession` with only `id`, `key`, `status`, `get`, `getOptional`, and `has`. Exhaustion records are independent historical work and remain valid if their source delivery is manually retried to another status.

Use `error instanceof HandlerTimeoutError` in `onFailure` to distinguish a deadline. The timeout error exposes `timeoutMs`; a timeout failure hook receives the already-aborted attempt signal.

## Sessions

```ts
import { sessionKey } from "simple-agent-orchestrator";

const agentSessionId = sessionKey<string>("opencode.sessionId");

const id = await session.ensure(agentSessionId, async () => {
  const agentSession = await createAgentSession(serverUrl, {
    idempotencyKey: `agent-session:${session.id}`,
  });
  return agentSession.id;
});

session.set("github.prNumber", event.meta.prNumber);
session.note("Sent review to agent", { reviewId: event.payload.id });
session.end({ reason: "github.pr.merged" });
```

Use `session.ensure` when retries should reuse a persisted value. Its external factory can repeat if creation succeeds before local persistence, so use provider idempotency or reconciliation. Use `createSandbox` when a JSON-safe typed resource also needs cleanup. Sandbox records are keyed by session, client, and environment and eagerly save the resource, checkpoints, and cleanup-step progress. Optional sandbox `reconcile` returns `active`, `cleaned`, or `unknown` before uncertain lifecycle work continues.

Ordinary handler/hook state, notes, `session.end()`, and capacity-release intent are staged on the delivery after handling and acknowledgement, then committed only after cleanup and final persistence. A retry resumes the saved next phase and reconstructs the session from staged effects. Ensured values and state mutations made during sandbox creation remain eager. Processing is retryable, not exactly once.

## Environments and sandboxes

```ts
import { createEnvironment, createSandbox, envKey } from "simple-agent-orchestrator";

export const opencodeServerUrl = envKey<string>("opencode.serverUrl");

export const worktreeSandbox = createSandbox<{ id: string; path: string }>({
  async create({ event, session, project, signal, publishResource }) {
    const branch = event.meta?.branch;
    if (typeof branch !== "string" || branch.trim() === "") {
      throw new Error("Expected event.meta.branch");
    }

    const worktree = await ensureActiveWorktree({
      resourceKey: `worktree:${session.id}`,
      rootDirectory: project.root,
      branch,
      signal,
    });
    await publishResource({ id: worktree.id, path: worktree.path });
  },

  async reconcile({ resource, session, signal, publishResource }) {
    if (resource && await worktreeExists(resource.id)) return "active";
    const recovered = await findWorktreeForSession(session.id, { signal });
    if (!recovered) return "unknown";
    await publishResource({ id: recovered.id, path: recovered.path });
    return "active";
  },

  async prepare({ resource, signal }) {
    if (!resource) throw new Error("Expected an active worktree resource");
    return ensureWorktreeReady(resource, { signal });
  },

  async cleanup({ cleanup }) {
    await cleanup.step("remove-worktree", { retry: "idempotent" }, async ({ resource }) => {
      await closeWorktreeIdempotently(resource.id);
    });
  },
});

export const opencodeEnvironment = createEnvironment("opencode", (environment) => {
  let shutdown: (() => Promise<void>) | undefined;

  environment.onMount(async ({ environment, project }) => {
    const server = await startPersistentOpencodeServer({ cwd: project.root });
    environment.set(opencodeServerUrl, server.url);
    shutdown = () => server.shutdown();
  });

  environment.onUnmount(async () => {
    await shutdown?.();
    shutdown = undefined;
  });

  environment.useSandbox(worktreeSandbox);
});
```

All worktree and OpenCode functions above are project APIs. `createSandbox`, `publishResource`, environment registration, and cleanup steps are package APIs. `create` may return the resource instead of publishing it; eager publish preserves identity if later creation code fails. Reconciliation receives `resource?`, `currentStatus`, and `currentCheckpoint`; it must publish a resource before returning `active` when none is stored. Optional `prepare` runs before handling for active sandboxes, including existing-only deliveries, and may durably refresh the resource. It can repeat after interruption and must be retry-safe.

Every outside typed-cleanup effect belongs inside a stable, non-empty step ID because cleanup re-enters directly from `cleaning`. A step chooses exactly `{ retry: "idempotent" }` or `{ reconcile }`; step reconciliation reports `completed`, `incomplete`, or `unknown`. Saved status is `running`, `completed`, `failed`, or `unknown`. Completed steps skip, unknown blocks, dependent steps run sequentially, and independent steps may use `Promise.allSettled` if the cleanup hook propagates failures. This is sandbox cleanup, not a workflow engine or exactly-once execution.

Runtime instances are one-shot. Call `start()` once, or use sequential direct `drain()` calls followed by `stop()`; do not overlap drains or try to restart a stopped runtime. Startup and each drain automatically requeue deliveries left `processing` by an interrupted attempt, preserving the consumed attempt and warning that external effects may repeat. HTTP starts only during ordinary `start()`, after environment mounts and before pollers/workers. `start({ drain: true })`, direct drains, offline work, inspection, and test-harness initialization do not open it. Failed startup and one-shot start clean up automatically. Shutdown closes HTTP and settles accepted requests and dispatches before releasing ownership. Environments unmount in reverse mount order, hooks unmount in reverse registration order, and cleanup continues after failures. Make cleanup hooks retry-safe because a later `stop()` retries unresolved cleanup.

## Key helpers

```ts
import { defineKey, sessionKey, envKey } from "simple-agent-orchestrator";

const githubPr = defineKey("github.pr", {
  parts: ["owner", "repo", "number"] as const,
});

const sessionKeyValue = githubPr({ owner: "acme", repo: "api", number: 42 });
```

## Stores

```ts
import { fileStore, memoryStore } from "simple-agent-orchestrator";

export default defineConfig(({ project }) => ({
  store: fileStore(project.statePath("state.json")),
  channels: [],
  clients: [],
}));
```

Use `memoryStore()` in tests. `fileStore()`/`jsonFileStore()` validates snapshots before runtime work and writes. State version 8 is current; valid versions 1 through 7 migrate in memory. Version 8 adds optional sandbox `resource` and `cleanupSteps`; older records receive empty steps and no resource, so typed definitions reconcile active legacy sandboxes before use or cleanup. Earlier delivery-phase, exhaustion, sandbox, and legacy-flag migration rules remain. The next successful write persists version 8; invalid or unsupported files are not replaced. Run `state validate` for a read-only compatibility check. Durable values must be JSON-safe and at most 100 levels deep. Custom adapters can use the exported `validateAndMigrateState` and must return a valid current `OrchestratorState` from `read()`.

Use `runtime.previewStatePrune({ before })` to inspect conservative retention and `runtime.runOffline(({ pruneState }) => pruneState({ before }))` to apply it. The CLI equivalents are `state prune --before <timestamp>` and the same command with `--apply`. Processed and ignored deliveries and safely unreferenced ended sessions/notes are eligible; retained exhaustion work protects its source delivery, event, and optional session, while cursors, unfinished sandbox records, and legacy active flags are preserved. Events remain as dedupe history unless `dropDedupe: true`/`--drop-dedupe` is explicit, which allows old source identities to dispatch again.

The JSON store rejects a second active runtime or offline operation for the same state file and reclaims ownership left by a dead PID. Atomic first-run initialization and runtime ownership require a local filesystem with atomic hard-link support and fail explicitly when unavailable. CLI `dispatch`, `sessions end`, `sessions complete`, `capacity release`, `events retry`, and `state prune --apply` acquire ownership and fail before writing while `start` is active; inspection commands, including `capacity list`, and retention preview remain available. Direct library mutations require an explicit `runtime.runOffline(...)` scope. Custom stores can opt into the same enforcement with `runtimeLockPath`; omitting it is appropriate only for process-isolated state or a store that independently rejects additional active runtimes, not coordinated multi-runtime execution through the snapshot `Store` API.

## Runtime creation and offline work

```ts
import { createRuntime, OrchestratorRuntime } from "simple-agent-orchestrator/runtime";

const runtime = await createRuntime(config, { root: process.cwd() });
// createRuntime defaults an omitted store to project.statePath("state.json").

const lowLevel = new OrchestratorRuntime({ project, config });
await lowLevel.init();
// Direct construction is low-level and defaults an omitted store to memory.
```

`config` may be an object or sync/async `({ project }) => config` factory. `createRuntime` options accept `project`, `cwd`, or `root`. It constructs but does not start or initialize the runtime.

```ts
await runtime.runOffline(async ({
  dispatch,
  drain,
  endSession,
  completeSession,
  releaseCapacity,
  retryDelivery,
  pruneState,
}) => {
  await dispatch(manualChannel, { id: "offline-1" });
  await drain();
});
```

The context is valid only during the callback. `runOffline` requires an unused one-shot runtime, owns persistent state for the complete scope, and always shuts down. `drain` processes eligible work and recovers interruptions; mutation-only scopes do not recover unless they drain.

## Managed Node processes

```ts
import {
  adoptManagedProcess,
  createPosixProcessGroupLocator,
  getAvailableLoopbackPort,
  isLoopbackHttpUrl,
  publishReadyRecord,
  readReadyRecord,
  spawnManagedProcess,
} from "simple-agent-orchestrator/node";

const child = spawnManagedProcess(process.execPath, ["agent-server.mjs"], {
  cwd: project.root,
  stdio: ["ignore", logFileDescriptor, logFileDescriptor],
  termGraceMs: 5_000,
  ownsProcess: async (pid) => processRecordStillMatches(pid),
});

await child.waitUntilReady(() => agentClient.isReady(), { signal, timeoutMs: 30_000 });
await child.stop();

const adopted = adoptManagedProcess(saved.pid, {
  ownsProcess: (pid) => processRecordStillMatches(pid, saved.ownershipToken),
});
await adopted.stop(); // Promise<void>, no exit result
```

`processRecordStillMatches`, `agentClient`, `saved`, and the log file descriptor come from the project; they are not package APIs.

Spawn always uses detached mode, `unref()`, and `shell: false`. Stdio defaults to `ignore`; inherited streams and existing numeric file descriptors are allowed, while generated pipes, overlapped pipes, IPC, and caller-owned stream objects are not. Spawned POSIX stop uses the detached process group with direct-child fallback when the group does not exist; Windows uses the direct child. Its optional ownership check runs once before signaling.

Adoption requires a safe integer PID greater than 1 and mandatory `ownsProcess` identity verification. On POSIX it observes and signals group `-pid` only, with no positive-PID fallback; Windows uses the PID. It verifies ownership before TERM and again before KILL, waits at most five seconds after KILL, and rejects if the target remains alive. The first adopted stop call caches its promise and options; concurrent and later calls return it. Adopted stop has no exit result. `createPosixProcessGroupLocator` finds one group by exact command values and supplies a rescanning ownership check. `publishReadyRecord`/`readReadyRecord`, `getAvailableLoopbackPort`, and `isLoopbackHttpUrl` provide narrow process-boundary utilities without adding provider restart policy.

## Testing

```ts
import { createTestRuntime } from "simple-agent-orchestrator/testing";

const test = await createTestRuntime(config, { root: process.cwd() });
await test.dispatch(channel, event); // drains by default
await test.sessions.get("session-key");
await test.sessions.end("session-key", "test end"); // metadata only
await test.sessions.complete("exact-session-id", "test complete");
await test.sandboxes.list("exact-session-id");
await test.capacity.list();
await test.capacity.release("client-id", "session-key"); // drains by default
await test.events.list();
await test.deliveries.list();
await test.exhaustions.list();
await test.readState();
await test.stop();
```

Pass config as the first argument rather than nesting it in an options object. Defaults are isolated memory state, silent logging, and disabled HTTP; options may override store/logger/HTTP and select either `root` or `project`. `sessions.end` accepts an ID or key and does not clean sandboxes; `sessions.complete` requires an exact active ID and performs cleanup. `sandboxes.list(sessionId?)` returns stored sandbox resources and cleanup steps. Event helpers return `{ event, deliveries, exhaustions }` records; delivery and exhaustion helpers expose their stored records directly. `test.runtime` is the public low-level escape hatch.

## CLI reminders

The parser rejects unknown/duplicate flags, extra positionals, missing values, and missing required options. CLI dispatch requires `--id`. `sessions list`, `capacity list`, and `events list` accept `--json` and positive `--limit`; `capacity release <client-id> <session-id-or-key>` is offline and drains newly available work. `events show <internal-event-id>` returns the event with deliveries. Use the internal ID returned by dispatch or `events list`, not the source ID. Missing show/end/retry targets exit nonzero.

Persisted state and ordinary logs are plaintext. Built-in operational HTTP summaries omit body/state/error fields, but project middleware, routes, handlers, and logs are not automatically redacted.
