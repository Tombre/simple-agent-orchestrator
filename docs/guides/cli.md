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

`show` includes persisted session notes. `end` records the session as ended but does not invoke sandbox cleanup hooks.

## events

```bash
npx simple-agent-orchestrator events list
npx simple-agent-orchestrator events retry <delivery-id>
```

`retry` grants one additional attempt to a failed delivery and drains the runtime once. Pending, processing, and processed deliveries are not requeued.

## print-config

```bash
npx simple-agent-orchestrator print-config
```

Prints the resolved config summary without secrets.
