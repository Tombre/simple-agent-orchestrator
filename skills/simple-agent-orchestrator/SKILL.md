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
   - debug: inspect config, sessions, events, deliveries, and retries.
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

4. **Use durable identity deliberately.** Every dispatched event should have a stable `id`; add `dedupeKey` when the source id is not the desired processing identity; add `sessionKey` for the durable work unit. Prefer `defineKey` for structured session keys. Done when duplicate suppression and session routing are both explainable from the code.

5. **Make handlers first-event safe.** Any channel event may be the first event for a session. Use `session.ensure(...)` for persistent external identifiers and environment sandboxes for resources that need cleanup. Done when no handler assumes another handler already initialized session state.

6. **Keep source acknowledgement after success.** If a source item must be marked handled, reacted to, labelled, or checkpointed, do it in route/client `onSuccess` or after the handler succeeds, not during polling before durable dispatch. Done when failed deliveries remain retryable.

7. **Validate with the CLI.** Prefer these checks after edits:

   ```bash
   npx simple-agent-orchestrator doctor
   npx simple-agent-orchestrator print-config
   npx simple-agent-orchestrator dispatch manual --id smoke-1 --session smoke --input "Smoke test"
   npx simple-agent-orchestrator sessions list
   npx simple-agent-orchestrator events list
   ```

   Also run the project’s TypeScript/test commands when available. Done when config loads and the changed route can be smoke-tested or the remaining blocker is named.

## References

Read [`references/API-CHEATSHEET.md`](references/API-CHEATSHEET.md) when writing imports or API calls.

Read [`references/TEMPLATES.md`](references/TEMPLATES.md) when creating files from scratch.

Read [`references/ROUTING-CHECKLIST.md`](references/ROUTING-CHECKLIST.md) when reviewing or debugging an integration.
