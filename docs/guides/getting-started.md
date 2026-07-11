# Build your first workflow

You're going to build a tiny message workflow inside an existing Node.js 20+ project. By the end, you'll have sent three messages through a handler, counted them in one shared session, inspected the results, and accepted one message over HTTP.

You don't need an AI provider for this walkthrough. The handler is intentionally simple so you can see what the orchestrator does before connecting your own agent.

## 1. Add the starter project

Run these commands from your project's root directory:

```bash
npm install -D simple-agent-orchestrator
npx simple-agent-orchestrator init
npx simple-agent-orchestrator doctor
```

The install makes the CLI and library available to this project. `init` then adds a small, self-contained integration under `.simple-agent-orchestrator/` without changing your root `package.json`:

```text
.simple-agent-orchestrator/
  .gitignore
  orchestrator.ts
  channels/manual.ts
  clients/example.ts
  package.json
  tsconfig.json
```

The important file is `orchestrator.ts`. It registers the generated example client:

```ts
// .simple-agent-orchestrator/orchestrator.ts
import { defineConfig } from "simple-agent-orchestrator";
import { exampleClient } from "./clients/example.ts";

export default defineConfig({
  clients: [exampleClient],
});
```

`doctor` loads that config and checks any existing saved data. A successful result means the project is ready to run; it doesn't call your handler or contact an outside service.

## 2. Send the first message

Use the CLI to send a message to the generated `manual` channel:

```bash
npx simple-agent-orchestrator dispatch manual \
  --id first-event \
  --session demo \
  --input "Hello from my first event"
```

Here, `first-event` identifies this source item, `demo` groups it with related messages, and `input` is the value your handler receives. The command saves the event, runs work that's ready, and exits. You should see the example handler log the event and session IDs, followed by the dispatch result.

Take a look at what the orchestrator recorded:

```bash
npx simple-agent-orchestrator events list
npx simple-agent-orchestrator sessions show demo
```

The event record shows `first-event` with a processed delivery. A delivery is the record of one handler processing one event. The `demo` session was created when that delivery ran, ready to hold context for future messages with the same session key.

## 3. Keep context between messages

Now replace the contents of `.simple-agent-orchestrator/clients/example.ts` with a handler that counts messages and leaves a note for each one:

```ts
import { createClient } from "simple-agent-orchestrator";
import { manualChannel } from "../channels/manual.ts";

export const exampleClient = createClient("example", (client) => {
  client.handle(manualChannel, async ({ event, session, logger }) => {
    const count = session.getOptional<number>("messageCount") ?? 0;

    session.set("messageCount", count + 1);
    session.note("Processed a message", { sourceId: event.id });

    logger.info("Processed message", {
      sourceId: event.id,
      sessionKey: session.key,
    });
  });
});
```

Send two more events to the same `demo` session, then inspect it:

```bash
npx simple-agent-orchestrator dispatch manual \
  --id second-event \
  --session demo \
  --input "Keep going"

npx simple-agent-orchestrator dispatch manual \
  --id third-event \
  --session demo \
  --input "One more message"

npx simple-agent-orchestrator sessions show demo
```

The session now contains `messageCount: 2` and two notes. The first event ran before you added the counter, so only the second and third events incremented it. Because both used the `demo` session key, the third event could read the count saved by the second.

This is the basic pattern you'll use with an agent: choose a session key for one conversation or piece of work, then read and update that session as new events arrive.

## 4. Leave the runtime running

So far, each `dispatch` command has opened the saved data, processed the event, and exited. In a real integration, you'll usually leave the runtime running so it can poll sources, accept HTTP requests, and process events as they arrive:

```bash
npx simple-agent-orchestrator start
```

The startup log tells you which HTTP address is listening. By default, it tries `127.0.0.1:3000`. Leave that process running, open another terminal, set `PORT` to the port in the log, and send it an event:

```bash
PORT=3000
curl -i -X POST "http://127.0.0.1:${PORT}/webhooks/manual" \
  -H 'Content-Type: application/json' \
  -d '{"id":"http-event","sessionKey":"demo","input":"Hello over HTTP"}'
```

A `202` response means, "I've saved this event and queued its handlers." It doesn't wait for the handler to finish, so inspect events or sessions when you need to confirm the result.

This request goes straight to the package's event route. The server doesn't authenticate callers or verify provider signatures. If you make it reachable beyond your machine or trusted network, add middleware that checks every request first; use TLS, rate limiting, and other protections appropriate to your deployment.

When you're finished, press `Ctrl+C` in the terminal running `start` and let it shut down. Stop that process before running CLI commands that change the default JSON state file, including `dispatch`, `sessions end`, `events retry`, and `state prune --apply`. Only one process may write that file at a time.

## What you just built

You have now used the complete path:

```text
manual channel -> event -> example client -> handler -> demo session
```

- The **channel** gives this source of messages the name `manual`.
- Each **event** is saved before dispatch reports that it was queued.
- The **client** subscribes your handler to the channel.
- A **delivery** tracks that handler's attempts for one event.
- The `demo` **session** keeps context across messages that use the same session key.
- The **runtime** runs the handler, records the result, and serves HTTP while `start` is active.

## Next steps

- [Follow one event through the core concepts](../concepts.md).
- [Connect a real event source](channels.md).
- [Configure handlers, retries, and concurrency](clients.md).
- [Test your integration](testing.md).
