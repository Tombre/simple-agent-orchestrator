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

Loads the project config and prints discovered runtime resources.

## start

```bash
npx simple-agent-orchestrator start
```

Starts pollers and client workers.

When using `jsonFileStore`, a local ownership lock rejects a second runtime or offline mutation for the same state and reports the active PID and start time. Ownership is released on normal shutdown, and a lock left by a process that exited is reclaimed on the next operation.

`doctor`, `print-config`, `sessions list`, `sessions show`, and `events list` only inspect runtime state and are safe while `start` is active. `dispatch`, `sessions end`, and `events retry` are offline mutations: they fail before writing unless the long-running runtime is stopped. This does not make direct library writes or arbitrary JSON-store writers safe.

Options:

```bash
--root <path>
--config <path>
--drain
```

`--drain` runs polls once, drains pending deliveries, and exits.

## dev

```bash
npx simple-agent-orchestrator dev
```

Currently equivalent to `start` with more development-oriented messaging. This is the right place to add watch/reload behavior later.

## dispatch

```bash
npx simple-agent-orchestrator dispatch manual \
  --id manual-1 \
  --session demo \
  --input "Hello"
```

This offline command acquires runtime ownership, dispatches the event, drains matching deliveries in the same one-shot runtime, and exits. If a long-running JSON-store runtime is active, it fails before dispatching.

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

`list` is an inspection command available while `start` is active. `retry` is an offline mutation that grants one additional attempt to a failed delivery and drains the runtime once. Pending, processing, and processed deliveries are not requeued. The complete handler attempt can run again, so external effects and source acknowledgement must use stable idempotency keys or reconciliation.

## print-config

```bash
npx simple-agent-orchestrator print-config
```

Prints the resolved config summary without secrets.
