# CLI guide

The CLI is strict: unknown commands and flags, extra positionals, duplicate flags, missing values, and missing required options exit nonzero. `-h` and `--help` print command-specific usage. Boolean flags may be bare or use `=true`/`=false`; other values are rejected.

`--root <path>` and `--config <path>` are accepted only by commands that show them in help.

## Setup and runtime

```bash
npx simple-agent-orchestrator init [--root <path>] [--force]
npx simple-agent-orchestrator start [--root <path>] [--config <path>] [--drain] [--no-http]
```

`init` discovers the nearest parent package when `--root` is omitted. It requires an existing valid object-valued `package.json`, writes only `.simple-agent-orchestrator`, and never edits the host manifest. Without `--force`, an existing destination is an error. Force overwrites known template files and preserves unknown files.

Ordinary `start` runs HTTP, polls, and workers. `--no-http` disables the listener. `--drain` polls once, drains currently eligible work without HTTP or waiting for delayed retries, and exits.

## Inspection

These commands are read-only after any required first-run store initialization and remain available while `start` owns the JSON store:

```bash
npx simple-agent-orchestrator doctor
npx simple-agent-orchestrator print-config
npx simple-agent-orchestrator state validate
npx simple-agent-orchestrator sessions list [--json] [--limit <count>]
npx simple-agent-orchestrator sessions show <id-or-key>
npx simple-agent-orchestrator events list [--json] [--limit <count>]
npx simple-agent-orchestrator events show <internal-event-id>
```

`--limit` must be a positive integer. Without it, CLI lists are not truncated. `--json` prints complete stored list records rather than a console table. `sessions show` includes notes. `events list --json` and `events show` return each stored event together with its delivery records, including attempts, status, errors, and delayed eligibility. `events show` expects the internal ID returned by dispatch or shown in `events list`, not the source event ID.

Missing sessions, events, or deliveries exit nonzero. Empty lists succeed and print `No sessions found.`, `No events found.`, or `[]` with `--json`.

`doctor` loads config and validates state and registrations without running hooks, polls, handlers, or HTTP. `state validate` does not rewrite a valid historical snapshot. `print-config` prints a resolved summary, not arbitrary config values or secrets.

## Dispatch

```bash
npx simple-agent-orchestrator dispatch <channel> \
  --id <source-id> \
  [--session <session-key>] \
  [--input <text>] \
  [--type <type>] \
  [--payload-json <json>] \
  [--meta-json <json>]
```

`--id` is required. Invalid JSON and unknown channels fail. The command acquires offline ownership, durably dispatches, drains eligible work, prints the queued/duplicate result, and exits. Delayed pending work remains for a later drain or ordinary runtime.

## Sessions and retries

```bash
npx simple-agent-orchestrator sessions end <id-or-key> [--reason <reason>]
npx simple-agent-orchestrator events retry <delivery-id>
```

Both are offline mutations. Ending a missing or already-ended session fails and does not run sandbox cleanup. Retry accepts only an existing failed delivery, grants one immediately eligible attempt, drains, and fails for pending, processing, or processed deliveries.

## Retention

```bash
npx simple-agent-orchestrator state prune --before <timestamp> [--drop-dedupe]
npx simple-agent-orchestrator state prune --before <timestamp> --apply [--drop-dedupe]
```

The default is a read-only preview. Apply requires offline ownership and recomputes the plan. It removes only eligible processed deliveries and safely unreferenced ended sessions/notes. Events remain as dedupe history unless `--drop-dedupe` is explicit. Back up persistent state before applying.

## Ownership and plaintext

With the default JSON store, `dispatch`, `sessions end`, `events retry`, and `state prune --apply` fail before writing while another runtime owns the state. Inspection and prune preview remain available.

The JSON state file and CLI inspection output can contain event input, payload, metadata, session state, notes, and delivery errors in plaintext. Built-in HTTP operational summaries are separately bounded and omit those fields; project routes, middleware, handlers, and logs are not automatically sanitized.
