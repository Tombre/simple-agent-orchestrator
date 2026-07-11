import { createClient } from "simple-agent-orchestrator";
import { manualChannel } from "../channels/manual.ts";

export const exampleClient = createClient("example", (client) => {
  client.handle(manualChannel, ({ event, session, logger }) => {
    logger.info("Example client handled event", {
      eventId: event.id,
      sessionId: session.id,
    });
  });
});
