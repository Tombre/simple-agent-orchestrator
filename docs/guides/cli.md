# Use the CLI

The CLI takes you from an empty project to a running integration, and it gives you practical tools for checking and repairing work along the way. This walkthrough covers the normal flow: initialize, validate, run, inspect, retry, and clean up old history.

You can always ask for the exact syntax:

```bash
npx simple-agent-orchestrator --help
npx simple-agent-orchestrator events list --help
```

## Create the project files

From your project root, run:

```bash
npx simple-agent-orchestrator init [--root <path>] [--force]
```

`init` creates starter files under `.simple-agent-orchestrator/`. It requires an existing, valid `package.json` and never edits it. If you run with `--force`, the command replaces only the known template files; files you added yourself are left alone.

Next, check that the config and saved state can be loaded:

```bash
npx simple-agent-orchestrator doctor [--root <path>] [--config <path>]
npx simple-agent-orchestrator print-config [--root <path>] [--config <path>]
npx simple-agent-orchestrator state validate [--root <path>] [--config <path>]
```

- `doctor` loads the config, checks channel and client IDs, and checks the state file. It doesn't run hooks, polls, handlers, or sandboxes.
- `print-config` prints a resolved summary without dumping arbitrary config values.
- `state validate` confirms that this package version can read the saved state. It doesn't rewrite the file.

## Run your integration

For normal development and production-like use, start the long-running process:

```bash
npx simple-agent-orchestrator start [--root <path>] [--config <path>]
```

This mounts client environments, starts the HTTP server, runs polls, and processes deliveries until the process receives a shutdown signal. The startup log prints the actual HTTP address, including a different port if the requested one was busy.

If the process only needs polls and workers, turn off HTTP:

```bash
npx simple-agent-orchestrator start --no-http
```

For cron jobs, local checks, and CI, use a one-shot run:

```bash
npx simple-agent-orchestrator start --drain
```

`--drain` checks each poll once, processes work that can run now, cleans up, and exits. If a retry is scheduled for later, this command won't wait for its timer.

## Send a manual event

Use `dispatch` when a script, operator, or local test needs to send an event without the HTTP server:

```bash
npx simple-agent-orchestrator dispatch <channel> \
  --id <source-id> \
  [--session <session-key>] \
  [--input <text>] \
  [--type <type>] \
  [--payload-json <json>] \
  [--meta-json <json>] \
  [--root <path>] \
  [--config <path>]
```

For example:

```bash
npx simple-agent-orchestrator dispatch manual \
  --id review-123 \
  --session github:acme/api:pr:42 \
  --input "Address the latest review" \
  --meta-json '{"branch":"fix-login"}'
```

`--id` is required. The CLI also uses it to recognize a repeat of the same event because this command has no separate `--dedupe-key` flag. That check is scoped to the channel.

The command saves the event, processes work that can run now, and prints JSON like:

```json
{
  "status": "queued",
  "eventId": "internal-event-id"
}
```

A repeat prints `"status": "duplicate"` and the original internal event ID; it doesn't create another delivery. A newly queued event can still have no deliveries when no handler subscribes to that channel.

## Inspect sessions

List recent sessions, then show the one you care about:

```bash
npx simple-agent-orchestrator sessions list \
  [--json] [--limit <count>] [--root <path>] [--config <path>]

npx simple-agent-orchestrator sessions show <id-or-key> \
  [--root <path>] [--config <path>]
```

The default list is a compact table. `--json` prints complete records, and `--limit` must be a positive integer. `sessions show` includes saved state and notes.

Session keys are convenient until an ended session and a newer active session share the same key. In that case, lookup by key can select the older record, so use the session ID from `sessions list` when you need a specific one.

## Inspect events and deliveries

```bash
npx simple-agent-orchestrator events list \
  [--json] [--limit <count>] [--root <path>] [--config <path>]

npx simple-agent-orchestrator events show <internal-event-id> \
  [--root <path>] [--config <path>]
```

The table gives you both kinds of IDs:

- `sourceId` is the `--id` supplied by the source or operator.
- `eventId` is the orchestrator's internal ID and is what `events show` expects.
- `deliveryId` identifies one handler's work and is what `events retry` expects.

Each delivery shows its client, handler, status, attempt count, and the time a delayed retry can run. Exhaustion work appears with handler `onExhausted` and an `exhaustion:` status. Use `--json` or `events show` for complete delivery and exhaustion records.

## Inspect and release retained capacity

When a client uses `client.capacity(...)`, inspect the sessions currently holding its slots:

```bash
npx simple-agent-orchestrator capacity list \
  [--json] [--limit <count>] [--root <path>] [--config <path>]
```

Listing is read-only and can run beside `start`. To release a slot from the CLI, stop the long-running process first:

```bash
npx simple-agent-orchestrator capacity release <client-id> <session-id-or-key> \
  [--root <path>] [--config <path>]
```

Release keeps the session active, processes work that can now run, and prints `released`. It does not stop or cancel the external agent. For a live completion callback, dispatch an event with the original session key to a handler configured with `session: "existing-only"` that calls `capacity.release()` instead of trying to modify the JSON state from a second process.

## End a session or retry failed work

Stop the long-running `start` process before running commands that change the JSON state file:

```bash
npx simple-agent-orchestrator sessions end <id-or-key> \
  [--reason <reason>] [--root <path>] [--config <path>]

npx simple-agent-orchestrator sessions complete <session-id> \
  [--reason <reason>] [--root <path>] [--config <path>]

npx simple-agent-orchestrator events retry <delivery-or-exhaustion-id> \
  [--root <path>] [--config <path>]
```

`sessions end` records the end reason, which defaults to `manual`, and releases the session's retained capacity. It does not call sandbox cleanup or stop external agents. If ending a session must remove an external worktree, container, or agent, arrange that through a handler or your own maintenance process.

`sessions complete` requires the exact active session ID and rejects while pending or processing deliveries target that session or its key. It mounts the environments for recorded sandboxes, requires reconciliation for uncertain resources, and runs cleanup before ending the session or releasing capacity. A cleanup failure leaves the session active and can be retried after the integration can reconcile the resource. The default reason is `completed`.

`events retry` works for a delivery or exhaustion record whose status is `failed`. It grants that record one additional attempt, makes it runnable immediately, processes ready work, and prints `retried`. Pass the delivery or exhaustion record ID even though the command sits under `events`.

## Preview and prune old history

First ask for a JSON plan without deleting anything:

```bash
npx simple-agent-orchestrator state prune \
  --before 2026-01-01T00:00:00Z
```

Review the selected IDs and blocked sessions. Pruning can remove processed and ignored deliveries older than the cutoff. Retained exhaustion work keeps its source delivery, event, and optional session. Pruning removes old ended sessions, cleaned sandbox records, and notes only when no kept work refers to them and no unfinished sandbox record or legacy active flag remains. Poll cursors stay in place.

Back up the state file, stop the runtime, and apply the same cutoff:

```bash
npx simple-agent-orchestrator state prune \
  --before 2026-01-01T00:00:00Z \
  --apply
```

Events remain by default, even when their deliveries are removed. Keeping them means the same channel and event ID will still be recognized as a duplicate.

Add `--drop-dedupe` only if you intentionally want matching old events removed too:

```bash
npx simple-agent-orchestrator state prune \
  --before 2026-01-01T00:00:00Z \
  --drop-dedupe \
  --apply
```

After those event records are removed, sending the same channel and ID can run the handlers again. Treat that as a behavior change, not just space cleanup.

## Work safely with the JSON state file

The default local store allows one process at a time to make changes. This is a guard for one machine and one running orchestrator, not coordination between machines.

Read-only commands such as lists, shows, `capacity list`, validation, and prune previews can run while `start` is active. `dispatch`, `sessions end`, `sessions complete`, `capacity release`, `events retry`, and prune with `--apply` fail before writing until the running process stops.

The state file and CLI JSON output can contain event bodies, session state, notes, sandbox checkpoints, cursor values, and errors as plaintext. Keep them out of logs and support bundles unless the contents are safe to share.

The parser is intentionally strict. Unknown or repeated flags, missing values, extra arguments, invalid limits, missing records, and changes that don't apply all fail with an error instead of guessing what you meant.

## Next steps

- [Make handlers safe to retry](failure-semantics.md)
- [Test dispatch and retries in memory](testing.md)
- [Look up the runtime API](../api-reference.md#runtime-api)
