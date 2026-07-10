# State Retention

## Objective

Provide a simple response to unbounded local state-file growth if real usage demonstrates the need.

## Why

Events, deliveries, ended sessions, and notes are retained indefinitely. That is useful for inspection and keeps the initial design simple, but long-running projects may eventually accumulate more history than they need. Retention should be added only when this becomes an observed operational issue.

## Goals

- Define which historical records may be removed without affecting active work, deduplication, retries, or cursor continuity.
- Keep retention explicit and conservative.
- Preserve active sessions, pending work, and operationally relevant failure history.
- Allow users to understand what history will be lost before cleanup occurs.
- Prefer an operator-controlled policy before automatic complexity.

## Scope Boundaries

- Do not add archival infrastructure or a background compaction service by default.
- Do not remove dedupe history in a way that silently causes old events to run again.
- Do not optimize state size before measurement shows a practical problem.

## Completion Signals

- State growth can be reduced without corrupting active orchestration behavior.
- Retention effects on deduplication and history are explicit.
- Projects that do not need retention incur no additional operational burden.
