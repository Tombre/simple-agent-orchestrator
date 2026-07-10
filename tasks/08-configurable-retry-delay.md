# Configurable Retry Delay

## Objective

Allow local retries to avoid repeatedly invoking a failing integration in an immediate tight loop.

## Why

Immediate retries are simple, but they can rapidly repeat an outage, rate-limit response, or temporarily invalid operation. A small optional delay can make retries more practical while preserving the existing lightweight delivery model.

## Goals

- Allow integrations to choose whether retries are immediate or delayed.
- Keep the default behavior straightforward and understandable.
- Ensure delayed work remains visible and survives normal runtime restarts when promised.
- Preserve retry precedence across handler, client, and global configuration.
- Define how one-shot drain mode treats work that is not yet eligible.

## Scope Boundaries

- Do not build a general scheduling system.
- Do not introduce workflow timers, cron orchestration, or distributed queues.
- Advanced retry policies should not become mandatory complexity for simple users.

## Completion Signals

- A persistently failing handler cannot accidentally create an uncontrolled retry loop when a delay is configured.
- Pending versus delayed work is operationally understandable.
- Existing immediate-retry use remains simple.
