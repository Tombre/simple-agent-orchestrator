---
name: simple-agent-orchestrator
description: Build, review, or modify Simple Agent Orchestrator integrations in TypeScript projects. Use when the user mentions .simple-agent-orchestrator, persistent agent sessions, routing channel events to agents, createChannel/createClient/createEnvironment, sessionKey/dedupeKey, or npx simple-agent-orchestrator.
license: MIT
compatibility: Node.js 20+, TypeScript, npm projects
metadata:
  version: "0.1.0"
---

Simple Agent Orchestrator is an embedded project runtime: events enter through **channels**, clients route them into durable **sessions**, sessions keep state for persistent agents, and **environments** provide shared resources and optional sandboxes.

## Procedure

1. **Find the project spine.** Work from the repository root. Check for `package.json`, `tsconfig.json`, and `.simple-agent-orchestrator/orchestrator.ts`. If the directory is missing and the task is setup, create it with `npx simple-agent-orchestrator init` or scaffold the same layout manually. Done when the project root and orchestrator config path are known.

2. **Choose the branch.** Use the smallest branch that fits the task:
   - setup: create `.simple-agent-orchestrator`, config, manual channel, and npm scripts.
   - channel: add or edit a source of events.
   - client: route a channel to a session and call project agent/tool code.
   - environment: mount shared runtime resources or create/cleanup sandboxes.
   - debug: inspect config, persisted-state compatibility, sessions, events, deliveries, and retries.
   - review: check routing identity, idempotency, cleanup, and validation.
   Done when the intended branch is explicit in the changes.

3. **Preserve the spine layout.** Keep orchestrator-specific code under:

   ```txt
   .simple-agent-orchestrator/
     orchestrator.ts
     channels/
     clients/
     environments/
     prompts/
     state/.gitignore
     logs/.gitignore
     tmp/.gitignore
   ```

   The orchestrator may import existing project code; avoid making application code import orchestrator definitions. Done when dependency direction is `.simple-agent-orchestrator -> project code`.

4. **Use durable identity deliberately.** Every dispatched event should have a stable `id`; add `dedupeKey` when the source id is not the desired processing identity; add `sessionKey` for the durable work unit. Prefer `defineKey` for structured session keys. Give each poll a stable `id` when its cursor must survive registration reordering; unnamed polls deliberately use their registration index. Changing a poll ID selects another cursor key, and reusing a historical ID restores that key's existing cursor. Done when duplicate suppression, session routing, and cursor ownership are explainable from the code.

5. **Make handlers first-event and retry safe.** Any channel event may be the first event for a session. Use `session.ensure(...)` for persistent external identifiers and environment sandboxes for resources that need cleanup, but make their external factories idempotent or reconciling because creation can repeat before local markers persist. Do not submit the first event as part of ensured resource creation and then depend on an attempt-local `createdNow` flag. Done when no handler assumes prior initialization and every retryable external operation has a stable identity.

6. **Keep source acknowledgement after handling.** If a source item must be marked handled, reacted to, or labelled, do it in a designated client `onSuccess`, not during polling or at the start of `handle`. Hooks are per delivery; there is no event-wide hook that waits for all fan-out deliveries. Make acknowledgement idempotent because a later cleanup or persistence failure can repeat it. Treat poll `commit` as an ingestion cursor checkpoint, not successful-processing acknowledgement. Done when acknowledgement ownership is explicit, failed deliveries remain retryable, and repeated acknowledgement is safe.

7. **Assume at-least-once external effects.** Event dedupe is not exactly-once processing. `handle`, `onSuccess`, `onFailure`, sandbox hooks, and external agent operations can repeat after uncertain failures. Startup and drain automatically retry deliveries interrupted in `processing`, without knowing whether their external effects completed. Use operation-specific idempotency keys derived from stable event/session identity, never from `attempt`; reconcile current external state when providers do not support keys. Done when every external effect is safe to retry or its residual risk is explicit.

   When a handler timeout is appropriate, configure it globally, with `client.timeout(...)`, or on the handler, and pass the context `signal` into agents, subprocesses, network requests, and sandbox operations. Timeout cancellation is cooperative: code that ignores the signal is still awaited, and provider-side effects may already have happened. Done when bounded operations honor cancellation without being treated as exactly once.

8. **Validate with the CLI.** Prefer these checks after edits:

   ```bash
    npx simple-agent-orchestrator doctor
    npx simple-agent-orchestrator state validate
   npx simple-agent-orchestrator print-config
   npx simple-agent-orchestrator dispatch manual --id smoke-1 --session smoke --input "Smoke test"
   npx simple-agent-orchestrator sessions list
   npx simple-agent-orchestrator events list
   ```

   Run the `dispatch` smoke test only after stopping a long-running JSON-store runtime; it is an offline command and will fail before writing while `start` is active. Inspection commands such as `doctor`, `state validate`, `print-config`, `sessions list`, and `events list` remain safe while `start` is active. `state validate` reports malformed, incompatible, or unsupported persisted state without replacing it. Also run the project’s TypeScript/test commands when available. Done when config and state validate and the changed route can be smoke-tested or the remaining blocker is named.

## References

Read [`references/API-CHEATSHEET.md`](references/API-CHEATSHEET.md) when writing imports or API calls.

Read [`references/TEMPLATES.md`](references/TEMPLATES.md) when creating files from scratch.

Read [`references/ROUTING-CHECKLIST.md`](references/ROUTING-CHECKLIST.md) when reviewing or debugging an integration.
