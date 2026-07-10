# CLI guide

## init

```bash
npx simple-agent-orchestrator init
```

Creates a project-local `.simple-agent-orchestrator` directory and adds helpful npm scripts to `package.json` when possible.

Use `--force` to overwrite template files.

## doctor

```bash
npx simple-agent-orchestrator doctor
```

Loads the project config, validates persisted state, and prints discovered runtime resources. It does not run polls, handlers, environment hooks, HTTP hooks, or a listener.

## state validate

```bash
npx simple-agent-orchestrator state validate
```

Loads the project and validates that the complete persisted snapshot is compatible. It is an inspection command and does not rewrite a valid historical file, so it remains available while `start` is active. A missing JSON state file is initialized as an empty current snapshot, consistent with `doctor` and other first-run commands. Invalid JSON, invalid shapes or references, obsolete versions, and future versions exit unsuccessfully with recovery guidance; the invalid file is not replaced.

## state prune

```bash
# Preview only
npx simple-agent-orchestrator state prune --before 2026-01-01T00:00:00Z

# Apply after backing up state and stopping start
npx simple-agent-orchestrator state prune --before 2026-01-01T00:00:00Z --apply
```

The default preview and apply select old processed deliveries plus ended sessions that have no retained deliveries or active sandbox marker; notes are removed only with their session. Pending, processing, and failed deliveries, operational sessions, cursors, and records without valid retention timestamps remain. Preview reports exact removal IDs, blocked ended sessions, and otherwise-eligible events protected as dedupe records, and does not write, so it is available while `start` is active. Apply acquires offline ownership and recomputes the plan before writing.

Events are retained by default because they suppress duplicate dispatch. Add `--drop-dedupe` to preview or apply removal of old events with no retained delivery. After those events are removed, dispatching the same source dedupe identities can create new work. Back up persistent state and inspect the preview before applying this irreversible history loss.

## start

```bash
npx simple-agent-orchestrator start
```

Starts the project-level HTTP listener, pollers, and client workers. HTTP defaults to `127.0.0.1:3000`; `SAO_HTTP_PORT` overrides `http.port`, and occupied ports trigger up to nine sequential fallback attempts. Startup logs the actual URL. The listener provides `GET /health`, normalized `POST /webhooks/:channelId`, and bounded read-only `GET /api/v1/status`, `/api/v1/events`, and `/api/v1/sessions`. Status reports the actual fallback address.

When using `jsonFileStore`, a local ownership lock rejects a second runtime or offline mutation for the same state and reports the active PID and start time. Ownership is released on normal shutdown, and a lock left by a process that exited is reclaimed on the next operation.

`doctor`, `print-config`, `state validate`, `sessions list`, `sessions show`, `events list`, and a `state prune` preview only inspect runtime state and are safe while `start` is active. `dispatch`, `sessions end`, `events retry`, and `state prune --apply` are offline mutations: they fail before writing unless the long-running runtime is stopped. This does not make direct library writes or arbitrary JSON-store writers safe.

Options:

```bash
--root <path>
--config <path>
--drain
--no-http
```

`--drain` runs polls once, processes currently eligible pending deliveries, and exits. It does not wait for future delayed retries or start HTTP. `--no-http` disables HTTP for an otherwise normal `start`.

The webhook accepts at most 1 MiB of strict JSON and returns after durable ingestion, before processing. Operational lists default to 25, allow at most 100, and omit event bodies, state, notes, and errors. The HTTP server has no built-in authentication, signature verification, CORS, rate limiting, or TLS. A non-loopback bind warns because dispatch and custom routes may be remotely reachable; loopback binding is still not an authentication boundary. Unauthenticated dispatch can trigger external side effects and unbounded state growth.

## dev

```bash
npx simple-agent-orchestrator dev
```

Currently equivalent to `start` with more development-oriented messaging and supports `--no-http`. This is the right place to add watch/reload behavior later.

## dispatch

```bash
npx simple-agent-orchestrator dispatch manual \
  --id manual-1 \
  --session demo \
  --input "Hello"
```

This offline command acquires runtime ownership, dispatches the event, drains currently eligible matching deliveries in the same one-shot runtime, and exits. A configured delayed retry remains pending for a later drain or long-running runtime. If a long-running JSON-store runtime is active, it fails before dispatching.

Additional options:

```bash
--type <type>
--payload-json '{"x":1}'
--meta-json '{"branch":"main"}'
```

## sessions

```bash
npx simple-agent-orchestrator sessions list
npx simple-agent-orchestrator sessions show <id-or-key>
npx simple-agent-orchestrator sessions end <id-or-key> --reason manual
```

`list` and `show` are inspection commands available while `start` is active; `show` includes persisted session notes. `end` is an offline mutation that records the session as ended but does not invoke sandbox cleanup hooks.

## events

```bash
npx simple-agent-orchestrator events list
npx simple-agent-orchestrator events retry <delivery-id>
```

`list` is an inspection command available while `start` is active. Its attempts column shows consumed/maximum attempts, and `nextAttemptAt` distinguishes delayed pending work. `retry` is an offline mutation that grants one immediately eligible attempt to a failed delivery and drains the runtime once. The retry action itself does not requeue pending, processing, or processed deliveries; however, its drain automatically recovers any delivery left `processing` by an interrupted runtime. The complete handler attempt can run again, so external effects and source acknowledgement must use stable idempotency keys or reconciliation.

## print-config

```bash
npx simple-agent-orchestrator print-config
```

Prints the resolved config summary without secrets.
