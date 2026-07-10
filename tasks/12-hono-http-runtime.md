# Hono HTTP Runtime

## Objective

Add a small Hono HTTP server to the normal long-running orchestrator lifecycle so projects can receive requests and extend the server without constructing a separate process.

## Why

Webhook ingress must run in the same process as polling, workers, the runtime mutex, and JSON-store ownership. A separate HTTP process cannot safely mutate the default JSON store while the worker runtime owns it.

Client environments are also the wrong lifecycle scope because they are client-specific and may be mounted more than once. HTTP ingress is a project/runtime-level resource.

## Goals

- Add `hono` and `@hono/node-server` as regular runtime dependencies.
- Start HTTP by default during ordinary `runtime.start()` and the CLI `start` and `dev` commands.
- Do not start HTTP during `start({ drain: true })`, direct `drain()`, `runOffline()`, `doctor`, `print-config`, inspection commands, or test-harness initialization.
- Add an `http` configuration section with:
  - `enabled?: boolean`
  - `hostname?: string`
  - `port?: number`
  - a middleware registration hook called before built-in routes
  - a custom-route registration hook called after built-in routes
- Provide middleware and route hooks with the Hono app, project context, logger, abort signal, and a runtime-backed dispatch function.
- Reserve `/health`, `/webhooks/*`, and `/api/v1/*` for built-in behavior.
- Default to `127.0.0.1:3000`.
- Resolve the port from `SAO_HTTP_PORT`, then `config.http.port`, then `3000`.
- Validate configured ports as base-10 integers from 1 through 65535.
- Attempt the requested port directly. On `EADDRINUSE` only, try subsequent ports without performing a separate availability probe.
- Bound fallback attempts and never wrap beyond port 65535.
- Log the final bound URL and clearly report when the selected port differs from the requested port.
- Add `--no-http` to `start` and `dev`, plus an equivalent runtime start option for embedded callers.
- Bind only after store ownership, state validation, interrupted-delivery recovery, and environment mounting succeed.
- Bind before starting pollers and workers so listener failure cannot allow orchestration side effects before startup rejects.
- Treat route setup and listener binding failures as startup failures and perform complete rollback.
- During shutdown, stop accepting HTTP requests before waiting for workers or releasing store ownership.
- Wait for accepted dispatch requests to settle before ownership release.
- Close idle connections and aggregate HTTP-close failures with environment and ownership cleanup failures.
- Keep repeated and concurrent `stop()` behavior deterministic and retry only unresolved cleanup work.
- Add a minimal `GET /health` response that confirms the combined runtime and listener have started.
- Warn when binding to a non-loopback hostname because no authentication is provided.

## Scope Boundaries

- Do not add a second process or HTTP-only runtime.
- Do not introduce a generic plugin or service framework.
- Do not start provider-specific webhook adapters.
- Do not provide authentication, authorization, signature verification, CORS, rate limiting, TLS termination, or exposure policy.
- Do not start HTTP while loading or inspecting configuration.
- Do not silently fall back for listen errors other than `EADDRINUSE`.
- Do not use port probing that introduces a time-of-check/time-of-use race.
- Do not imply that loopback binding is an authentication boundary.
- Custom middleware and routes remain trusted project configuration code.

## Completion Signals

- Normal startup binds an HTTP listener and reports its actual URL.
- Configuration, environment, and CLI disablement have deterministic precedence.
- Occupied ports cause bounded sequential fallback.
- Startup failures leave no listener, mounted environment, or JSON-store lock behind.
- Shutdown rejects new HTTP work before releasing store ownership.
- Middleware can protect built-in routes and custom routes can be added without replacing reserved routes.
- Existing non-HTTP runtime behavior remains unchanged when HTTP is disabled.
- Lifecycle, configuration, CLI, package, and clean-consumer tests pass.
- Documentation, templates, public exports, and the shipped skill describe the same lifecycle and configuration.
