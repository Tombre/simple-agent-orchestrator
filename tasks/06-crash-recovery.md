# Crash Recovery

## Objective

Ensure work that was interrupted by an unexpected process exit can be processed after the local orchestrator restarts.

## Why

A delivery can be left in `processing` if the process exits after claiming it. Without recovery, that delivery remains stranded even though the orchestrator is otherwise healthy. A reliable local runtime should recover from ordinary crashes without requiring users to edit persisted state manually.

## Goals

- Recognize deliveries that were interrupted by a previous runtime execution.
- Make interrupted work eligible for processing again without losing its history or attempt information.
- Preserve the expectation that handlers and external effects may run more than once after uncertain failures.
- Make recovery visible enough for users to understand why a delivery was retried.
- Consider whether an explicit operator-facing recovery action is useful in addition to automatic startup behavior.

## Scope Boundaries

- This is restart recovery for one local orchestrator, not distributed worker leasing.
- This does not provide exactly-once execution.
- This does not attempt to determine whether an external side effect completed before the crash.

## Completion Signals

- A delivery interrupted by process termination no longer remains permanently unprocessable.
- Recovery behavior is covered across restart and retry scenarios.
- Documentation clearly states the duplicate-side-effect risk.
