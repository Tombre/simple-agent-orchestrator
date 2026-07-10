# Runtime Lifecycle Guards

## Objective

Make runtime startup and shutdown behavior explicit, predictable, and safe under repeated or failed lifecycle calls.

## Why

The runtime owns an abort signal, pollers, workers, mounted environments, and in-flight work. Duplicate starts, restart attempts after stopping, or partial startup failures can otherwise create leaked resources or confusing behavior. Guarding the lifecycle improves reliability without expanding product scope.

## Goals

- Define the valid lifecycle of one runtime instance.
- Reject duplicate, conflicting, or invalid lifecycle operations with clear errors.
- Unwind resources when startup fails partway through.
- Keep shutdown idempotent and preserve reverse-order environment cleanup.
- Ensure one-shot drain behavior remains self-contained.

## Scope Boundaries

- A stopped runtime does not need to become restartable if one-shot instances are simpler.
- Shutdown remains cooperative for user handlers and hooks.
- This task does not add process supervision or automatic daemon restarts.

## Completion Signals

- Invalid lifecycle calls cannot create duplicate workers or pollers.
- Partial startup does not leave mounted resources behind.
- Lifecycle expectations are documented and covered by behavioral tests.
