import { describe, expect, it } from "vitest";
import { createChannel, createClient, sessionKey } from "../src/index.js";
import { createTestRuntime } from "../src/testing/index.js";

describe("runtime", () => {
  it("dedupes events and persists session state", async () => {
    const channel = createChannel("test");
    const countKey = sessionKey<number>("count");

    const client = createClient("client", (builder) => {
      builder.handle(channel, async ({ session }) => {
        session.set(countKey, (session.getOptional(countKey) ?? 0) + 1);
      });
    });

    const test = await createTestRuntime({ channels: [channel], clients: [client] });
    try {
      await test.dispatch("test", { id: "1", sessionKey: "session-a", input: "hello" });
      await test.dispatch("test", { id: "1", sessionKey: "session-a", input: "duplicate" });

      const session = await test.sessions.get("session-a");
      expect(session?.state.count).toBe(1);
    } finally {
      await test.stop();
    }
  });
});
