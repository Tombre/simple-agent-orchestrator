# Failure Semantics And Idempotency

## Objective

Make the runtime's delivery guarantees and the integration author's responsibilities unambiguous.

## Why

Handlers, hooks, source acknowledgements, and external agent operations cannot be committed atomically with local delivery state. Retries or crash recovery may therefore repeat external effects. Clear semantics are more valuable than an unrealistic exactly-once promise and help integrations use the simple runtime safely.

## Goals

- Define processing as retryable and potentially repeated after uncertain failures.
- Explain which session changes persist on success, failure, and resource initialization.
- Explain how errors from handlers, success hooks, and failure hooks affect a delivery.
- Encourage stable external idempotency keys and retry-safe integration behavior.
- Keep source acknowledgement after successful handling.
- Ensure examples follow the documented rules.

## Scope Boundaries

- Do not claim exactly-once processing.
- Do not attempt distributed transactions with external systems.
- Do not prescribe one provider-specific idempotency mechanism.

## Completion Signals

- A user can predict what may run again after any supported failure path.
- Public examples avoid unsafe acknowledgement and duplicate first-event behavior.
- Behavioral tests and documentation agree on persistence and retry semantics.
