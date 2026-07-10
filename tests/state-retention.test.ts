import { describe, expect, it } from "vitest";
import { createClient } from "../src/core/client.js";
import { createManualChannel } from "../src/core/channel.js";
import type { OrchestratorState, StoredDelivery, StoredEvent, StoredSession } from "../src/core/types.js";
import { memoryStore } from "../src/stores/memory.js";
import { createRuntime } from "./helpers.js";

const old = "2020-01-01T00:00:00.000Z";
const recent = "2022-01-01T00:00:00.000Z";
const before = "2021-01-01T00:00:00.000Z";

function event(id: string, sourceId = id): StoredEvent {
  return {
    id,
    channelId: "manual",
    sourceId,
    dedupeKey: `manual:${sourceId}`,
    sessionKey: id,
    receivedAt: old,
  };
}

function session(id: string, status: StoredSession["status"], state: Record<string, unknown> = {}): StoredSession {
  return {
    id,
    key: id,
    status,
    state,
    createdAt: old,
    updatedAt: old,
    ...(status === "ended" ? { endedAt: old } : {}),
  };
}

function delivery(
  id: string,
  eventId: string,
  status: StoredDelivery["status"],
  sessionId: string,
): StoredDelivery {
  const attempts = status === "pending" ? 0 : 1;
  return {
    id,
    eventId,
    channelId: "manual",
    clientId: "worker",
    handlerId: "manual",
    status,
    attempts,
    maxAttempts: status === "pending" ? 2 : 1,
    retryDelayMs: 0,
    createdAt: old,
    updatedAt: old,
    sessionId,
    ...(status === "processed" ? { processedAt: id === "delivery-recent" ? recent : old } : {}),
  };
}

function fixtureState(): OrchestratorState {
  return {
    version: 3,
    sessions: [
      session("event-processed", "ended"),
      session("event-pending", "ended"),
      session("event-processing", "active"),
      session("event-failed", "ended"),
      session("event-recent", "ended"),
      session("sandbox", "ended", { "__sao.sandbox.local.created": true }),
      session("paused", "paused"),
      session("failed", "failed"),
      { ...session("missing-ended-at", "ended"), endedAt: undefined },
    ],
    events: [
      event("event-processed", "source-old"),
      event("event-pending"),
      event("event-processing"),
      event("event-failed"),
      event("event-recent"),
      event("event-orphan"),
    ],
    deliveries: [
      delivery("delivery-processed", "event-processed", "processed", "event-processed"),
      delivery("delivery-pending", "event-pending", "pending", "event-pending"),
      delivery("delivery-processing", "event-processing", "processing", "event-processing"),
      delivery("delivery-failed", "event-failed", "failed", "event-failed"),
      delivery("delivery-recent", "event-recent", "processed", "event-recent"),
    ],
    notes: [
      { id: "note-processed", sessionId: "event-processed", message: "old", createdAt: old },
      { id: "note-pending", sessionId: "event-pending", message: "needed", createdAt: old },
      { id: "note-sandbox", sessionId: "sandbox", message: "resource", createdAt: old },
    ],
    cursors: { "manual:poll": { position: "unchanged" } },
  };
}

async function retentionRuntime() {
  const manual = createManualChannel("manual");
  const worker = createClient("worker", (client) => {
    client.handle(manual, async () => {});
  });
  const store = memoryStore(fixtureState());
  const runtime = await createRuntime({ channels: [manual], clients: [worker], store });
  return { runtime, store };
}

describe("state retention", () => {
  it("previews and prunes only completed history that is safe to remove", async () => {
    const { runtime, store } = await retentionRuntime();
    const original = await store.read();

    const preview = await runtime.previewStatePrune({ before });

    expect(preview).toMatchObject({
      before,
      dropDedupe: false,
      deliveryIds: ["delivery-processed"],
      sessionIds: ["event-processed"],
      noteIds: ["note-processed"],
      eventIds: [],
      dedupeProtectedEventIds: ["event-processed", "event-orphan"],
    });
    expect(preview.blockedSessions).toEqual([
      { id: "event-pending", reason: "retained-delivery" },
      { id: "event-failed", reason: "retained-delivery" },
      { id: "event-recent", reason: "retained-delivery" },
      { id: "sandbox", reason: "active-sandbox" },
    ]);
    expect(await store.read()).toEqual(original);

    const applied = await runtime.pruneState({ before });
    expect(applied).toEqual(preview);

    const state = await store.read();
    expect(state.deliveries.map(({ id }) => id)).toEqual([
      "delivery-pending",
      "delivery-processing",
      "delivery-failed",
      "delivery-recent",
    ]);
    expect(state.sessions.map(({ id }) => id)).not.toContain("event-processed");
    expect(state.sessions.map(({ id }) => id)).toContain("sandbox");
    expect(state.sessions.map(({ id }) => id)).toEqual(expect.arrayContaining(["paused", "failed", "missing-ended-at"]));
    expect(state.notes.map(({ id }) => id)).toEqual(["note-pending", "note-sandbox"]);
    expect(state.events).toEqual(original.events);
    expect(state.cursors).toEqual(original.cursors);
  });

  it("removes dedupe records only by explicit opt-in and allows redispatch", async () => {
    const { runtime, store } = await retentionRuntime();
    await runtime.pruneState({ before });

    expect(await runtime.dispatch("manual", { id: "source-old" })).toMatchObject({ status: "duplicate" });

    const preview = await runtime.previewStatePrune({ before, dropDedupe: true });
    expect(preview.eventIds).toEqual(["event-processed", "event-orphan"]);
    expect(preview.dedupeProtectedEventIds).toEqual([]);
    await runtime.pruneState({ before, dropDedupe: true });

    expect((await store.read()).events.map(({ id }) => id)).not.toContain("event-processed");
    expect(await runtime.dispatch("manual", { id: "source-old" })).toMatchObject({ status: "queued" });
  });

  it("rejects invalid cutoffs instead of deleting history", async () => {
    const { runtime, store } = await retentionRuntime();
    const original = await store.read();

    await expect(runtime.pruneState({ before: "yesterday" })).rejects.toThrow("valid ISO 8601 timestamp");
    await expect(runtime.pruneState({ before: "2021-02-30T00:00:00Z" })).rejects.toThrow("valid ISO 8601 timestamp");
    expect(await store.read()).toEqual(original);
  });

  it("conservatively preserves records with invalid historical timestamps", async () => {
    const { runtime, store } = await retentionRuntime();
    const state = await store.read();
    state.deliveries.find(({ id }) => id === "delivery-processed")!.processedAt = "not-a-date";
    state.sessions.find(({ id }) => id === "event-processed")!.endedAt = "not-a-date";
    state.events.find(({ id }) => id === "event-orphan")!.receivedAt = "not-a-date";
    await store.write(state);

    const plan = await runtime.pruneState({ before, dropDedupe: true });

    expect(plan.deliveryIds).not.toContain("delivery-processed");
    expect(plan.sessionIds).not.toContain("event-processed");
    expect(plan.eventIds).not.toContain("event-orphan");
  });
});
