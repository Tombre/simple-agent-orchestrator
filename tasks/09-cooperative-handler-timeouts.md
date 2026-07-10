# Cooperative Handler Timeouts

## Objective

Give integrations an optional way to stop waiting indefinitely for handlers or lifecycle hooks that support cancellation.

## Why

Agent calls, subprocesses, and network operations can hang. The runtime already provides an abort signal, but a local execution may still need a bounded waiting policy so one delivery does not block progress forever.

## Goals

- Allow an optional execution deadline without changing the normal handler API shape unnecessarily.
- Communicate timeout cancellation through the existing cooperative abort model.
- Record timeout failures clearly and apply ordinary retry rules.
- Define how runtime shutdown and per-attempt deadlines interact.
- Keep integrations responsible for passing cancellation to their own tools and APIs.

## Scope Boundaries

- JavaScript work that ignores cancellation cannot be forcefully terminated safely.
- Do not add process isolation solely to enforce hard timeouts.
- Do not imply that a timed-out external operation had no side effects.

## Completion Signals

- Cooperative handlers can be bounded and retried after a timeout.
- Timeout errors are distinguishable from ordinary handler failures.
- Documentation does not promise forced cancellation.
