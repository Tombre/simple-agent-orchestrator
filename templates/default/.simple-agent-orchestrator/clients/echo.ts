import { createClient, sessionKey } from "simple-agent-orchestrator";
import { manualChannel } from "../channels/manual.ts";

const messageCount = sessionKey<number>("example.messageCount");

export const echoClient = createClient("echo", (client) => {
  client.handle(manualChannel, async ({ event, session, logger }) => {
    const count = (session.getOptional(messageCount) ?? 0) + 1;
    session.set(messageCount, count);
    session.note("Handled manual event", { eventId: event.id, count });

    logger.info("Echo client handled event", {
      sessionKey: session.key,
      input: typeof event.input === "string" ? event.input : JSON.stringify(event.input),
      count,
    });
  });
});
