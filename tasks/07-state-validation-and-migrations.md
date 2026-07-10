# State Validation And Migrations

## Objective

Keep locally persisted orchestrator state understandable, compatible, and safe to load as the package evolves.

## Why

The JSON store is intentionally simple, but persisted state can outlive the package version that created it. Invalid data should fail clearly, and deliberate format changes should not silently reinterpret or discard existing sessions, events, deliveries, notes, cursors, or sandbox markers.

## Goals

- Validate the persisted state shape before the runtime operates on it.
- Distinguish malformed state from a missing state file.
- Establish a small, explicit policy for versioned state changes.
- Preserve durable identifiers and semantics across compatible upgrades.
- Consider a user-facing validation command for diagnosing state without running work.
- Report incompatibility with actionable errors rather than replacing data.

## Scope Boundaries

- Do not build a general database migration framework.
- Do not support arbitrary historical formats indefinitely.
- Do not silently coerce values when their intended meaning is ambiguous.

## Completion Signals

- Invalid or unsupported state is detected before processing begins.
- Supported state upgrades are deterministic and tested with persisted fixtures.
- State-related failures explain whether recovery, migration, or user intervention is required.
