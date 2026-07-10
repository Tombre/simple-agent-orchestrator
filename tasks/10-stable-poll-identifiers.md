# Stable Poll Identifiers

## Objective

Allow polling cursor identity to remain stable when poll registrations are reorganized.

## Why

Poll cursors currently depend on channel ID and registration order. Reordering or inserting polls can associate persisted cursor state with a different poll. Optional stable identifiers would reduce accidental reinterpretation while retaining simple positional defaults for small configurations.

## Goals

- Let integrations opt into a durable identity for each poll.
- Preserve the current concise API when positional identity is sufficient.
- Detect ambiguous or duplicate poll identities.
- Document the compatibility implications of renaming or reordering polls.
- Keep existing persisted cursors understandable during adoption.

## Scope Boundaries

- Do not build a general scheduler registry.
- Do not require explicit identifiers for every simple one-poll channel unless justified.
- Do not infer migrations when two poll identities cannot be matched safely.

## Completion Signals

- A configured stable poll keeps its cursor when neighboring poll registrations move.
- Duplicate identities fail clearly.
- Existing positional behavior remains documented and supported.
