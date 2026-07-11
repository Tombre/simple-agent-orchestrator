import { describe, expect, it } from "vitest";
import { createChannel, createClient } from "../src/index.js";
import { createRuntime, deferred, waitFor } from "./helpers.js";

describe("runtime concurrency", () => {
  it("atomically limits retained capacity when several workers claim new sessions", async () => {
    const channel = createChannel("capacity");
    const bothStarted = deferred();
    const release = deferred();
    const started: string[] = [];
    const client = createClient("agent", (builder) => {
      builder.capacity({ maxActiveSessions: 2 });
      builder.concurrency({ workers: 4 });
      builder.handle(channel, async ({ event }) => {
        started.push(event.id);
        if (started.length === 2) bothStarted.resolve();
        await release.promise;
      });
    });
    const runtime = await createRuntime({ channels: [channel], clients: [client] });
    for (const id of ["one", "two", "three", "four"]) {
      await runtime.dispatch("capacity", { id, sessionKey: id });
    }

    await runtime.start({ prettyStartupLog: false });
    await bothStarted.promise;
    expect(await runtime.listCapacityReservations()).toHaveLength(2);
    release.resolve();
    await waitFor(async () => {
      const deliveries = (await runtime.listEvents()).flatMap(({ deliveries }) => deliveries);
      expect(deliveries.filter(({ status }) => status === "processed")).toHaveLength(2);
    });

    expect(started).toEqual(["one", "two"]);
    const deliveries = (await runtime.listEvents()).flatMap(({ deliveries }) => deliveries);
    expect(deliveries.filter(({ status, attempts }) => status === "pending" && attempts === 0)).toHaveLength(2);
    await runtime.stop();
  });

  it("merges unrelated mutations from concurrent deliveries in one session", async () => {
    const channel = createChannel("concurrent");
    const bothStarted = deferred();
    const release = deferred();
    let started = 0;
    const client = createClient("client", (builder) => {
      builder.concurrency({ workers: 2 });
      builder.handle(channel, async ({ event, session }) => {
        session.set(event.id, true);
        started += 1;
        if (started === 2) bothStarted.resolve();
        await release.promise;
      });
    });
    const runtime = await createRuntime({ channels: [channel], clients: [client] });
    await runtime.dispatch("concurrent", { id: "first", sessionKey: "shared" });
    await runtime.dispatch("concurrent", { id: "second", sessionKey: "shared" });

    await runtime.start({ prettyStartupLog: false });
    await bothStarted.promise;
    release.resolve();
    await waitFor(async () => {
      const events = await runtime.listEvents();
      expect(events.flatMap(({ deliveries }) => deliveries).every(({ status }) => status === "processed")).toBe(true);
    });
    await runtime.stop();

    expect(await runtime.getSession("shared")).toMatchObject({ state: { first: true, second: true } });
  });

  it("does not let an in-flight handler resurrect an administratively ended session", async () => {
    const channel = createChannel("concurrent");
    const started = deferred();
    const release = deferred();
    const client = createClient("client", (builder) => {
      builder.handle(channel, async ({ session }) => {
        session.set("handled", true);
        started.resolve();
        await release.promise;
      });
    });
    const runtime = await createRuntime({ channels: [channel], clients: [client] });
    await runtime.dispatch("concurrent", { id: "event", sessionKey: "shared" });

    await runtime.start({ prettyStartupLog: false });
    await started.promise;
    expect(await runtime.endSession("shared", "operator")).toBe(true);
    release.resolve();
    await waitFor(async () => {
      const deliveries = (await runtime.listEvents())[0]!.deliveries;
      expect(deliveries[0]?.status).toBe("processed");
    });
    await runtime.stop();

    expect(await runtime.getSession("shared")).toMatchObject({
      status: "ended",
      endReason: "operator",
      state: { handled: true },
    });
  });
});
