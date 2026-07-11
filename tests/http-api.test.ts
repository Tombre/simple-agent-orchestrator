import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChannel,
  createClient,
  createEnvironment,
  memoryStore,
  type Logger,
  type OrchestratorState,
  type Store,
} from "../src/index.js";
import { createRuntime, deferred, waitFor } from "./helpers.js";

const runtimes: Array<Awaited<ReturnType<typeof createRuntime>>> = [];

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function occupy(port: number) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

function webhook(port: number, channelId: string, body: string, contentType = "application/json") {
  return fetch(`http://127.0.0.1:${port}/webhooks/${encodeURIComponent(channelId)}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

function deliveryCounts(pending = 0, processing = 0, processed = 0, failed = 0) {
  return { pending, processing, processed, failed };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.stop()));
});

describe("HTTP webhook and operational API", () => {
  it("durably dispatches normalized events, dedupes concurrent requests, and does not wait for handlers", async () => {
    const port = await availablePort();
    const handlerStarted = deferred();
    const releaseHandler = deferred();
    const channel = createChannel("normalized");
    const bulkChannel = createChannel("bulk");
    const client = createClient("client", (builder) => {
      builder.handle(channel, async () => {
        handlerStarted.resolve();
        await releaseHandler.promise;
      });
    });
    const runtime = await createRuntime({ channels: [channel, bulkChannel], clients: [client], http: { port } });
    runtimes.push(runtime);
    await runtime.start({ prettyStartupLog: false });

    const requestBody = JSON.stringify({
      id: "source-1",
      type: "example.created",
      dedupeKey: "dedupe-1",
      sessionKey: "session-1",
      input: "hello",
      payload: { count: 1 },
      meta: { tenant: "acme" },
      occurredAt: "2026-07-10T10:30:00Z",
    });
    const responses = await Promise.all([
      webhook(port, "normalized", requestBody),
      webhook(port, "normalized", requestBody),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json())) as Array<{
      status: "queued" | "duplicate";
      eventId: string;
    }>;
    const firstBody = bodies[0]!;
    expect(responses.map((response) => response.status).sort()).toEqual([200, 202]);
    expect(firstBody).toEqual(expect.objectContaining({ eventId: expect.any(String) }));
    expect(bodies[1]).toEqual(expect.objectContaining({ eventId: firstBody.eventId }));

    await handlerStarted.promise;
    const stored = (await runtime.listEvents())[0]!;
    const { event, deliveries } = stored;
    expect(event).toMatchObject({
      sourceId: "source-1",
      dedupeKey: "normalized:dedupe-1",
      sessionKey: "session-1",
      input: "hello",
      payload: { count: 1 },
      meta: { tenant: "acme" },
      occurredAt: "2026-07-10T10:30:00.000Z",
    });
    expect(deliveries).toHaveLength(1);

    const distinct = await Promise.all(Array.from({ length: 101 }, (_, index) => webhook(
      port,
      "bulk",
      JSON.stringify({ id: `bulk-${index}` }),
    )));
    expect(distinct.every((response) => response.status === 202)).toBe(true);
    expect(await runtime.listEvents()).toHaveLength(102);
    const defaultList = await fetch(`http://127.0.0.1:${port}/api/v1/events`).then(
      (response) => response.json() as Promise<{ events: unknown[]; hasMore: boolean }>,
    );
    expect(defaultList).toMatchObject({ hasMore: true });
    expect(defaultList.events).toHaveLength(25);
    const maximumList = await fetch(`http://127.0.0.1:${port}/api/v1/events?limit=100`).then(
      (response) => response.json() as Promise<{ events: unknown[]; hasMore: boolean }>,
    );
    expect(maximumList).toMatchObject({ hasMore: true });
    expect(maximumList.events).toHaveLength(100);

    releaseHandler.resolve();
    await waitFor(async () => {
      const normalized = (await runtime.listEvents()).find(({ event }) => event.sourceId === "source-1");
      expect(normalized?.deliveries[0]?.status).toBe("processed");
    });
  });

  it("returns stable safe errors for unsupported, malformed, invalid, oversized, unknown, and failed requests", async () => {
    const port = await availablePort();
    const logger: Logger = {
      debug() {},
      info() {},
      warn() {},
      error: vi.fn(),
    };
    const channel = createChannel("known");
    const runtime = await createRuntime({ channels: [channel], logger, http: { port } });
    runtimes.push(runtime);
    await runtime.start({ prettyStartupLog: false });

    const cases: Array<[Promise<Response>, number, string]> = [
      [fetch(`http://127.0.0.1:${port}/webhooks/known`, { method: "POST", body: "{}" }), 415, "unsupported_media_type"],
      [webhook(port, "known", "{"), 400, "invalid_request"],
      [webhook(port, "known", "[]"), 400, "invalid_request"],
      [webhook(port, "known", JSON.stringify({ id: "ok", extra: true })), 400, "invalid_request"],
      [webhook(port, "known", JSON.stringify({ id: " ".repeat(2) })), 400, "invalid_request"],
      [webhook(port, "known", JSON.stringify({ id: "x".repeat(513) })), 400, "invalid_request"],
      [webhook(port, "known", JSON.stringify({ id: "ok", meta: [] })), 400, "invalid_request"],
      [webhook(port, "known", JSON.stringify({ id: "ok", occurredAt: "not-a-date" })), 400, "invalid_request"],
      [webhook(port, "known", "{\"id\":\"ok\",\"input\":1e400}"), 400, "invalid_request"],
      [webhook(port, "missing", JSON.stringify({ id: "ok" })), 404, "unknown_channel"],
      [webhook(port, "known", JSON.stringify({ id: "large", input: "x".repeat(1024 * 1024) })), 413, "payload_too_large"],
    ];

    for (const [pending, status, code] of cases) {
      const response = await pending;
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: { code, message: expect.any(String) },
      });
    }
    expect(await runtime.listEvents()).toEqual([]);
    expect(logger.error).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: expect.anything() }));

    const reflected = "private-value-".repeat(100);
    const reflectedResponse = await webhook(port, "known", JSON.stringify({ id: "ok", [reflected]: true }));
    expect(reflectedResponse.status).toBe(400);
    expect(await reflectedResponse.text()).not.toContain(reflected);

    const tooDeep = { id: "deep", input: {} as Record<string, unknown> };
    let nested = tooDeep.input;
    for (let depth = 0; depth < 101; depth += 1) {
      nested.value = {};
      nested = nested.value as Record<string, unknown>;
    }
    const deepResponse = await webhook(port, "known", JSON.stringify(tooDeep));
    expect(deepResponse.status).toBe(400);
  });

  it("hides internal dispatch failures", async () => {
    const port = await availablePort();
    const initial = memoryStore();
    const store: Store = {
      name: "failing",
      init: () => initial.init(),
      read: () => initial.read(),
      async write() {
        throw new Error("secret /private/state.json persistence detail");
      },
    };
    const runtime = await createRuntime({ channels: [createChannel("known")], store, http: { port } });
    runtimes.push(runtime);
    await runtime.start({ prettyStartupLog: false });

    const response = await webhook(port, "known", JSON.stringify({ id: "sensitive-body" }));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: { code: "internal_error", message: "The request could not be completed." },
    });
    expect(text).not.toContain("secret");
    expect(text).not.toContain("sensitive-body");
  });

  it("returns bounded sanitized summaries and actual listener details from one snapshot", async () => {
    const requestedPort = await availablePort();
    const occupied = await occupy(requestedPort);
    const now = "2026-07-10T10:00:00.000Z";
    const state: OrchestratorState = {
      version: 4,
      events: ["a", "b", "c"].map((id) => ({
        id: `evt_${id}`,
        channelId: "summary",
        sourceId: `source-${id}`,
        dedupeKey: `summary:${id}`,
        sessionKey: `session-${id}`,
        type: "secret-type",
        input: "secret-input",
        payload: { secret: true },
        meta: { secret: true },
        receivedAt: now,
      })),
      deliveries: ["pending", "processing", "processed", "failed"].map((status, index) => ({
        id: `delivery-${index}`,
        eventId: index === 3 ? "evt_a" : `evt_${String.fromCharCode(97 + index)}`,
        channelId: "summary",
        clientId: "client",
        handlerId: "handler",
        status: status as "pending" | "processing" | "processed" | "failed",
        attempts: 1,
        maxAttempts: 3,
        retryDelayMs: 0,
        createdAt: now,
        updatedAt: now,
        lastError: "secret-error",
      })),
      sessions: ["a", "b", "c"].map((id) => ({
        id: `session_${id}`,
        key: `key-${id}`,
        status: id === "a" ? "ended" as const : "active" as const,
        state: { secret: true },
        createdAt: now,
        updatedAt: now,
        ...(id === "a" ? { endedAt: now, endReason: "secret-reason" } : {}),
      })),
      capacityReservations: [],
      notes: [{ id: "note", sessionId: "session_a", message: "secret-note", createdAt: now }],
      cursors: {},
    };
    const runtime = await createRuntime({ store: memoryStore(state), channels: [createChannel("summary")], http: { port: requestedPort } });
    runtimes.push(runtime);
    try {
      await runtime.start({ prettyStartupLog: false });
      const port = requestedPort + 1;

      const status = await fetch(`http://127.0.0.1:${port}/api/v1/status`).then((response) => response.json());
      expect(status).toEqual({
        uptimeMs: expect.any(Number),
        http: { hostname: "127.0.0.1", port },
        totals: {
          events: 3,
          sessions: 3,
          deliveries: deliveryCounts(2, 0, 1, 1),
        },
      });

      const eventResponse = await fetch(`http://127.0.0.1:${port}/api/v1/events?limit=2`);
      expect(eventResponse.status).toBe(200);
      const eventBody = await eventResponse.json() as {
        hasMore: boolean;
        events: Array<Record<string, unknown> & { id: string }>;
      };
      expect(eventBody.hasMore).toBe(true);
      expect(eventBody.events.map((event: { id: string }) => event.id)).toEqual(["evt_c", "evt_b"]);
      expect(eventBody.events[0]).toEqual({
        id: "evt_c",
        sourceId: "source-c",
        channelId: "summary",
        dedupeKey: "summary:c",
        sessionKey: "session-c",
        type: "secret-type",
        receivedAt: now,
        deliveries: deliveryCounts(0, 0, 1, 0),
      });
      expect(JSON.stringify(eventBody)).not.toContain("secret-input");
      expect(JSON.stringify(eventBody)).not.toContain("secret-error");

      const sessionBody = await fetch(`http://127.0.0.1:${port}/api/v1/sessions?limit=2`).then(
        (response) => response.json() as Promise<{
          hasMore: boolean;
          sessions: Array<Record<string, unknown> & { id: string }>;
        }>,
      );
      expect(sessionBody.hasMore).toBe(true);
      expect(sessionBody.sessions.map((session: { id: string }) => session.id)).toEqual(["session_c", "session_b"]);
      expect(JSON.stringify(sessionBody)).not.toContain("secret-note");
      expect(JSON.stringify(sessionBody)).not.toContain("secret-reason");
      expect(JSON.stringify(sessionBody)).not.toContain("secret\":true");

      for (const limit of ["0", "101", "1.5", "abc", "", "1&limit=2"]) {
        const response = await fetch(`http://127.0.0.1:${port}/api/v1/events?limit=${limit}`);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: { code: "invalid_limit", message: expect.any(String) },
        });
      }
      const defaultLimit = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`).then(
        (response) => response.json() as Promise<{ hasMore: boolean }>,
      );
      expect(defaultLimit.hasMore).toBe(false);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it("settles an accepted built-in webhook before shutdown cleanup", async () => {
    const port = await availablePort();
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const base = memoryStore();
    const store: Store = {
      name: "delayed",
      init: () => base.init(),
      read: () => base.read(),
      async write(state) {
        writeStarted.resolve();
        await releaseWrite.promise;
        await base.write(state);
      },
    };
    const runtime = await createRuntime({ channels: [createChannel("shutdown")], store, http: { port } });
    runtimes.push(runtime);
    await runtime.start({ prettyStartupLog: false });

    const request = webhook(port, "shutdown", JSON.stringify({ id: "accepted" }));
    await writeStarted.promise;
    const stopping = runtime.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);

    releaseWrite.resolve();
    expect((await request).status).toBe(202);
    await stopping;
    expect((await runtime.listEvents())[0]?.event.sourceId).toBe("accepted");
  });

  it("reports uptime from runtime startup rather than listener binding", async () => {
    const port = await availablePort();
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const environment = createEnvironment("slow-start", (builder) => {
      builder.onMount(() => {
        now = 1_500;
      });
    });
    const channel = createChannel("uptime");
    const client = createClient("uptime-client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, () => {});
    });
    const runtime = await createRuntime({ channels: [channel], clients: [client], http: { port } });
    runtimes.push(runtime);
    await runtime.start({ prettyStartupLog: false });

    const status = await fetch(`http://127.0.0.1:${port}/api/v1/status`).then(
      (response) => response.json() as Promise<{ uptimeMs: number }>,
    );
    expect(status.uptimeMs).toBe(500);
  });
});
