import { describe, expect, it } from "vitest";
import { createChannel, createClient, type OrchestratorEvent } from "../src/index.js";
import { createTestRuntime } from "../src/testing/index.js";

describe("runtime behavior", () => {
  it("preserves event fields, scopes dedupe by channel, and fans out to every client", async () => {
    const firstChannel = createChannel("first");
    const secondChannel = createChannel("second");
    const received: { client: string; event: OrchestratorEvent }[] = [];

    const firstClient = createClient("first-client", (client) => {
      client.handle(firstChannel, {
        id: "shared-handler-name",
        handle({ event }) {
          received.push({ client: "first", event });
        },
      });
    });
    const secondClient = createClient("second-client", (client) => {
      client.handle(firstChannel, {
        id: "shared-handler-name",
        handle({ event }) {
          received.push({ client: "second", event });
        },
      });
      client.handle(secondChannel, ({ event }) => {
        received.push({ client: "other-channel", event });
      });
    });

    const test = await createTestRuntime({
      config: { channels: [firstChannel, secondChannel], clients: [firstClient, secondClient] },
    });
    const occurredAt = new Date("2025-01-02T03:04:05.000Z");
    const event = {
      id: "source-1",
      type: "review",
      dedupeKey: "revision-7",
      sessionKey: "work-1",
      input: "review this",
      payload: { number: 7 },
      meta: { branch: "main" },
      occurredAt,
    };

    const first = await test.dispatch("first", event);
    const duplicate = await test.dispatch("first", event);
    const otherChannel = await test.dispatch("second", event);

    expect(first.status).toBe("queued");
    expect(duplicate).toEqual({ status: "duplicate", eventId: first.eventId });
    expect(otherChannel.status).toBe("queued");
    expect(received).toHaveLength(3);
    expect(received.filter(({ client }) => client !== "other-channel")).toHaveLength(2);
    expect(received[0]?.event).toMatchObject({
      id: "source-1",
      channelId: "first",
      type: "review",
      dedupeKey: "revision-7",
      sessionKey: "work-1",
      input: "review this",
      payload: { number: 7 },
      meta: { branch: "main" },
      occurredAt: occurredAt.toISOString(),
    });
  });

  it("uses the documented event identity defaults", async () => {
    const channel = createChannel("manual");
    let received: OrchestratorEvent | undefined;
    const client = createClient("client", (builder) => {
      builder.handle(channel, ({ event }) => {
        received = event;
      });
    });
    const test = await createTestRuntime({ config: { channels: [channel], clients: [client] } });

    await test.dispatch("manual", { id: "event-1" });

    expect(received).toMatchObject({ dedupeKey: "event-1", sessionKey: "manual:event-1" });
  });

  it("runs failure and success hooks in attempt order and clears the final error", async () => {
    const channel = createChannel("retry");
    const calls: string[] = [];
    const client = createClient("client", (builder) => {
      builder.handle(channel, {
        retries: { attempts: 2 },
        handle({ attempt }) {
          calls.push(`handle:${attempt}`);
          if (attempt === 1) throw new Error("transient");
        },
        onFailure({ attempt }) {
          calls.push(`failure:${attempt}`);
        },
        onSuccess({ attempt }) {
          calls.push(`success:${attempt}`);
        },
      });
    });
    const test = await createTestRuntime({ config: { channels: [channel], clients: [client] } });

    await test.dispatch("retry", { id: "event-1" });

    const deliveries = (await test.events.list())[0]!.deliveries;
    expect(calls).toEqual(["handle:1", "failure:1", "handle:2", "success:2"]);
    expect(deliveries[0]).toMatchObject({ status: "processed", attempts: 2, lastError: undefined });
  });

  it("uses global retry attempts when a client and handler do not override them", async () => {
    const channel = createChannel("retry");
    const client = createClient("client", (builder) => {
      builder.handle(channel, () => {
        throw new Error("permanent");
      });
    });
    const test = await createTestRuntime({
      config: { channels: [channel], clients: [client], retries: { attempts: 1 } },
    });

    await test.dispatch("retry", { id: "event-1" });

    const deliveries = (await test.events.list())[0]!.deliveries;
    expect(deliveries[0]).toMatchObject({ status: "failed", attempts: 1, maxAttempts: 1 });
  });

  it("applies handler, client, global, then built-in retry precedence", async () => {
    const channel = createChannel("retry");
    const clientDefault = createClient("client-default", (builder) => {
      builder.retries({ attempts: 2 });
      builder.handle(channel, { id: "client-default", handle() {} });
      builder.handle(channel, { id: "handler-override", retries: { attempts: 4 }, handle() {} });
    });
    const globalDefault = createClient("global-default", (builder) => {
      builder.handle(channel, { id: "global-default", handle() {} });
    });
    const test = await createTestRuntime({
      config: {
        channels: [channel],
        clients: [clientDefault, globalDefault],
        retries: { attempts: 5 },
      },
    });

    await test.dispatch("retry", { id: "event" });

    const deliveries = (await test.events.list())[0]!.deliveries;
    expect(Object.fromEntries(deliveries.map(({ handlerId, maxAttempts }) => [handlerId, maxAttempts]))).toEqual({
      "client-default": 2,
      "handler-override": 4,
      "global-default": 5,
    });
  });

  it("persists ensured values but rolls back ordinary state after a failed attempt", async () => {
    const channel = createChannel("retry");
    let factoryCalls = 0;
    const observations: unknown[] = [];
    const client = createClient("client", (builder) => {
      builder.handle(channel, {
        retries: { attempts: 2 },
        async handle({ attempt, session }) {
          const resource = await session.ensure("resource", () => {
            factoryCalls += 1;
            return "stable-id";
          });
          observations.push([attempt, resource, session.getOptional("ordinary")]);
          if (attempt === 1) {
            session.set("ordinary", "discard-me");
            throw new Error("retry");
          }
        },
      });
    });
    const test = await createTestRuntime({ config: { channels: [channel], clients: [client] } });

    await test.dispatch("retry", { id: "event", sessionKey: "work" });

    expect(factoryCalls).toBe(1);
    expect(observations).toEqual([
      [1, "stable-id", undefined],
      [2, "stable-id", undefined],
    ]);
    expect(await test.sessions.get("work")).toMatchObject({ state: { resource: "stable-id" } });
  });

  it("manually retries only failed deliveries and grants one new attempt", async () => {
    const channel = createChannel("retry");
    let shouldFail = true;
    const client = createClient("client", (builder) => {
      builder.retries({ attempts: 1 });
      builder.handle(channel, () => {
        if (shouldFail) throw new Error("not yet");
      });
    });
    const test = await createTestRuntime({ config: { channels: [channel], clients: [client] } });
    await test.dispatch("retry", { id: "failed-event" });
    const deliveries = (await test.events.list())[0]!.deliveries;
    const delivery = deliveries[0]!;

    shouldFail = false;
    expect(await test.runtime.retryDelivery(delivery.id)).toBe(true);
    await test.runtime.drain();
    const retriedDeliveries = (await test.events.list())[0]!.deliveries;
    expect(retriedDeliveries[0]).toMatchObject({ status: "processed", attempts: 2, maxAttempts: 2 });
    expect(await test.runtime.retryDelivery(delivery.id)).toBe(false);
  });

  it("retains ended session history and creates a new active session for the same key", async () => {
    const channel = createChannel("sessions");
    const client = createClient("client", (builder) => {
      builder.handle(channel, ({ event, session }) => {
        session.set("source", event.id);
        if (event.id === "first") session.end({ reason: "complete" });
      });
    });
    const test = await createTestRuntime({ config: { channels: [channel], clients: [client] } });

    await test.dispatch("sessions", { id: "first", sessionKey: "work" });
    await test.dispatch("sessions", { id: "second", sessionKey: "work" });

    const sessions = await test.sessions.list();
    expect(sessions).toHaveLength(2);
    expect(sessions.find(({ status }) => status === "ended")).toMatchObject({
      key: "work",
      endReason: "complete",
      state: { source: "first" },
    });
    expect(sessions.find(({ status }) => status === "active")).toMatchObject({
      key: "work",
      state: { source: "second" },
    });
  });

  it("persists session notes for later inspection", async () => {
    const channel = createChannel("notes");
    const client = createClient("client", (builder) => {
      builder.handle(channel, ({ session }) => {
        session.note("Handled review", { reviewId: 7 });
      });
    });
    const test = await createTestRuntime({ config: { channels: [channel], clients: [client] } });

    await test.dispatch("notes", { id: "event", sessionKey: "work" });

    expect(await test.sessions.notes("work")).toMatchObject([
      { message: "Handled review", data: { reviewId: 7 } },
    ]);
  });
});
