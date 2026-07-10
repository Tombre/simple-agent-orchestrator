# Webhook And Operational API

## Objective

Use the runtime-owned Hono server to provide normalized webhook dispatch and a minimal bounded, read-only operational API.

## Why

External services need a durable way to submit events and inspect basic orchestration progress without accessing the state file or depending on CLI-oriented output.

The API must remain small and must not expose arbitrary event payloads, session state, notes, stack traces, filesystem paths, or administrative mutations.

## Goals

- Add `POST /webhooks/:channelId`.
- Accept a normalized JSON-safe event with:
  - required non-empty string `id`
  - optional string `type`
  - optional string `dedupeKey`
  - optional string `sessionKey`
  - optional JSON-safe `input`
  - optional JSON-safe `payload`
  - optional JSON object `meta`
  - optional valid date string `occurredAt`
- Require `Content-Type: application/json`.
- Enforce a request-body limit, initially 1 MiB.
- Reject malformed JSON, arrays, primitive bodies, unknown fields, invalid dates, invalid field types, non-finite numbers, excessive nesting, and oversized identifiers.
- Dispatch through `runtime.dispatch()` so webhook dispatch uses existing deduplication, fan-out, persistence, and mutex behavior.
- Return `202` with `{ status: "queued", eventId }` after a new event is durably stored.
- Return `200` with `{ status: "duplicate", eventId }` for duplicate dispatch.
- Return structured errors without exposing internal error messages or stack traces:
  - `400` for malformed or invalid input
  - `404` for an unknown channel
  - `413` for an oversized body
  - `415` for an unsupported media type
  - `500` for internal persistence or runtime failures
- Document that acceptance means durable ingestion, not successful delivery processing.
- Add `GET /api/v1/status` with:
  - runtime uptime
  - actual HTTP hostname and port
  - event and session totals
  - delivery totals grouped by `pending`, `processing`, `processed`, and `failed`
- Add `GET /api/v1/events?limit=N`.
- Return event summaries containing identifiers, channel, session key, type, timestamps, and aggregate delivery-status counts.
- Exclude event input, payload, metadata, delivery errors, and individual delivery records.
- Add `GET /api/v1/sessions?limit=N`.
- Return session identifiers, keys, statuses, and lifecycle timestamps.
- Exclude session state and notes.
- Use a default limit of 25 and maximum of 100.
- Reject invalid limits rather than silently clamping them.
- Return stable descending ordering using timestamps plus identifiers as tie-breakers.
- Include `hasMore` without introducing cursor pagination in the first version.
- Build summaries from one snapshot in linear time rather than using the existing event-by-event delivery filtering.
- Register project middleware before all built-in routes so projects can add authentication, signature verification, logging, request IDs, and rate limiting.
- Do not log request bodies by default.
- Warn that unauthenticated dispatch can cause external side effects and unbounded state growth when the listener is exposed.

## Scope Boundaries

- Do not add provider-specific webhook payloads or signature schemes.
- Do not acknowledge source systems on behalf of project integrations.
- Do not wait for deliveries or handlers to complete before responding.
- Do not claim exactly-once processing.
- Do not add session-ending, retry, cancellation, pause, resume, or arbitrary state mutation endpoints.
- Do not expose raw state snapshots, event bodies, session state, notes, cursors, errors, environment values, lock metadata, or project paths.
- Do not add unbounded list responses.
- Do not add pagination cursors until real usage requires them.
- Do not add permissive CORS or built-in authentication.
- Do not represent this API as a hosted control plane or multi-process coordination layer.

## Completion Signals

- A normalized webhook request is durably dispatched before its success response.
- Concurrent duplicate requests create one event and return the original internal event ID.
- Concurrent distinct webhook requests do not lose state.
- Requests racing shutdown cannot write after runtime ownership is released.
- Invalid requests produce stable status codes and safe error bodies.
- Operational responses remain bounded and omit sensitive fields.
- Delivery-status summaries accurately reflect current durable state.
- No administrative mutation routes are exposed.
- Real ephemeral-port integration tests cover startup, webhook dispatch, processing, inspection, and shutdown.
- The package smoke test starts the installed CLI, dispatches through HTTP, inspects status, confirms processing, and stops cleanly.
- README, API reference, design principles, relevant guides, templates, CLI help, and the shipped skill agree on routes, security ownership, limits, and response semantics.
