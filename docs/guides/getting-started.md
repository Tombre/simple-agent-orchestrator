# Getting started

Simple Agent Orchestrator is meant to live inside an existing TypeScript project.

## 1. Install

```bash
npm install -D simple-agent-orchestrator
```

## 2. Initialize

```bash
npx simple-agent-orchestrator init
```

This creates `.simple-agent-orchestrator` at your project root.

## 3. Check the project

```bash
npx simple-agent-orchestrator doctor
```

`doctor` loads your config, initializes and validates the store, validates identifiers, and prints the discovered channels and clients. It does not run environment hooks, pollers, or handlers. Use `npx simple-agent-orchestrator state validate` when you only need a persisted-state compatibility check.

## 4. Dispatch a manual event

The default template includes a manual channel and an echo client.

```bash
npx simple-agent-orchestrator dispatch manual \
  --id first-event \
  --session demo \
  --input "Hello agent runtime"
```

The `dispatch` command loads the config, processes the event in a one-shot runtime, and exits. Then inspect the session:

```bash
npx simple-agent-orchestrator sessions show demo
```

You should see session state like:

```json
{
  "key": "demo",
  "status": "active",
  "state": {
    "example.messageCount": 1
  }
}
```

## 5. Start the runtime

After the manual smoke test, start the long-running runtime for polls and project-owned dispatch integrations:

```bash
npx simple-agent-orchestrator start
```

The runtime loads `.simple-agent-orchestrator/orchestrator.ts` from your project root and validates persisted state before polling, mounting environments, recovering deliveries, or invoking handlers. The default JSON store supports one mutating orchestrator process. CLI `dispatch`, `sessions end`, and `events retry` fail before writing while `start` is active; inspection commands such as `state validate`, `sessions show`, and `events list` remain available.

## 6. Replace the echo client

Edit:

```text
.simple-agent-orchestrator/clients/echo.ts
```

Replace the handler with your own agent integration:

```ts
client.timeout("10m");
client.handle(manualChannel, async ({ event, session, signal }) => {
  const agentSessionId = await session.ensure("agent.sessionId", async () => {
    const created = await createAgentSession({
      idempotencyKey: `agent-session:${session.id}`,
      signal,
    });
    return created.id;
  });

  await sendToAgent(agentSessionId, String(event.input), {
    idempotencyKey: `agent-message:${event.channelId}:${event.dedupeKey}`,
    signal,
  });
});
```

Both external operations use stable keys because a later failure or timeout can retry the handler, and both receive the cooperative cancellation signal. A timeout cannot force JavaScript or prove that an external side effect did not occur. Avoid submitting the first prompt during ensured session creation: an attempt-local `createdNow` flag cannot prevent duplicate first-event delivery after a retry.

## 7. Add real channels

Channels can poll existing project code:

```ts
import { createChannel } from "simple-agent-orchestrator";
import { fetchReviewCandidates } from "../../src/lib/github/reviews";

export const githubReviewsChannel = createChannel("github.reviews", (channel) => {
  channel.poll({
    every: "60s",
    fetch: () => fetchReviewCandidates(),
    map: (review) => ({
      id: review.id,
      sessionKey: `github:${review.repo}:pr:${review.prNumber}`,
      input: review.toMarkdown(),
      payload: review,
    }),
  });
});
```

Then add the channel and client to `orchestrator.ts`.
