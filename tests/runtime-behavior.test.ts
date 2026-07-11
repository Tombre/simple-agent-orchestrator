import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChannel,
  createClient,
  HandlerTimeoutError,
  memoryStore,
  type OrchestratorEvent,
} from "../src/index.js";
import { createTestRuntime as createUntrackedTestRuntime, type TestRuntime } from "../src/testing/index.js";
import { MAX_RETRY_DELAY_MS } from "../src/utils/time.js";
import { deferred } from "./helpers.js";

const activeTestRuntimes = new Set<TestRuntime>();

async function createTestRuntime(
  ...args: Parameters<typeof createUntrackedTestRuntime>
): Promise<TestRuntime> {
  const test = await createUntrackedTestRuntime(...args);
  activeTestRuntimes.add(test);
  return test;
}

afterEach(async () => {
  const results = await Promise.allSettled([...activeTestRuntimes].map((test) => test.stop()));
  activeTestRuntimes.clear();
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, "Test runtime cleanup failed");
});

describe("runtime behavior", () => {
  it("retains client capacity after handlers return until the session capacity is released", async () => {
    const startChannel = createChannel("start");
    const completionChannel = createChannel("complete");
    const started: string[] = [];
    const completed: string[] = [];
    const client = createClient("agent", (builder) => {
      builder.capacity({ maxActiveSessions: 2 });
      builder.handle(startChannel, ({ event }) => {
        started.push(event.id);
      });
      builder.handle(completionChannel, ({ event, capacity }) => {
        completed.push(event.id);
        capacity.release();
      });
    });
    const test = await createTestRuntime({
      channels: [startChannel, completionChannel],
      clients: [client],
    });

    await test.dispatch("start", { id: "first", sessionKey: "session-1" });
    await test.dispatch("start", { id: "second", sessionKey: "session-2" });
    await test.dispatch("start", { id: "third", sessionKey: "session-3" });

    expect(started).toEqual(["first", "second"]);
    expect(await test.capacity.list()).toHaveLength(2);
    const thirdEvent = (await test.events.list()).find(({ event }) => event.sourceId === "third")!;
    expect(thirdEvent.deliveries[0]).toMatchObject({ status: "pending", attempts: 0 });

    await test.dispatch("complete", { id: "first-complete", sessionKey: "session-1" });

    expect(completed).toEqual(["first-complete"]);
    expect(started).toEqual(["first", "second", "third"]);
    expect(await test.capacity.list()).toHaveLength(2);
    expect((await test.sessions.get("session-1"))?.status).toBe("active");
    expect((await test.events.get(thirdEvent.event.id))?.deliveries[0]).toMatchObject({
      status: "processed",
      attempts: 1,
    });
  });

  it("retains capacity after a failed launch until an operator releases it", async () => {
    const channel = createChannel("launch");
    const started: string[] = [];
    const client = createClient("agent", (builder) => {
      builder.capacity({ maxActiveSessions: 1 });
      builder.handle(channel, {
        retries: { attempts: 1 },
        handle({ event }) {
          started.push(event.id);
          if (event.id === "uncertain") throw new Error("launch result unknown");
        },
      });
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    await test.dispatch("launch", { id: "uncertain", sessionKey: "first-session" });
    await test.dispatch("launch", { id: "queued", sessionKey: "second-session" });

    expect(started).toEqual(["uncertain"]);
    expect(await test.capacity.list()).toHaveLength(1);
    expect((await test.events.list()).find(({ event }) => event.sourceId === "queued")?.deliveries[0]).toMatchObject({
      status: "pending",
      attempts: 0,
    });

    expect(await test.capacity.release("agent", "first-session")).toBe(true);
    expect(started).toEqual(["uncertain", "queued"]);
    expect(await test.capacity.release("agent", "first-session")).toBe(false);
  });

  it("releases retained capacity when a session ends successfully", async () => {
    const channel = createChannel("end");
    const client = createClient("agent", (builder) => {
      builder.capacity({ maxActiveSessions: 1 });
      builder.handle(channel, ({ session }) => session.end());
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    await test.dispatch("end", { id: "event", sessionKey: "one-session" });

    expect((await test.sessions.get("one-session"))?.status).toBe("ended");
    expect(await test.capacity.list()).toEqual([]);
  });

  it("releases every client's reservation when a shared session is ended administratively", async () => {
    const channel = createChannel("shared-capacity");
    const first = createClient("first", (builder) => {
      builder.capacity({ maxActiveSessions: 1 });
      builder.handle(channel, () => {});
    });
    const second = createClient("second", (builder) => {
      builder.capacity({ maxActiveSessions: 1 });
      builder.handle(channel, () => {});
    });
    const test = await createTestRuntime({ channels: [channel], clients: [first, second] });
    await test.dispatch("shared-capacity", { id: "event", sessionKey: "shared-session" });
    expect(await test.capacity.list()).toHaveLength(2);

    expect(await test.runtime.endSession("shared-session", "operator")).toBe(true);

    expect(await test.capacity.list()).toEqual([]);
    expect(await test.sessions.get("shared-session")).toMatchObject({ status: "ended", endReason: "operator" });
  });

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
      channels: [firstChannel, secondChannel], clients: [firstClient, secondClient],
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
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

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
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    await test.dispatch("retry", { id: "event-1" });

    const deliveries = await test.deliveries.list();
    expect(calls).toEqual(["handle:1", "failure:1", "handle:2", "success:2"]);
    expect(deliveries[0]).toMatchObject({ status: "processed", attempts: 2, lastError: undefined });
  });

  it("cooperatively aborts timed-out attempts, rolls back ordinary changes, and retries", async () => {
    vi.useFakeTimers();
    try {
      const channel = createChannel("timeout");
      const starts = [deferred(), deferred()];
      const failures: unknown[] = [];
      const client = createClient("client", (builder) => {
        builder.handle(channel, {
          retries: { attempts: 2 },
          async handle({ attempt, session, signal }) {
            session.set("ordinary", attempt);
            session.note(`attempt ${attempt}`);
            await session.ensure("eager", () => "kept");
            starts[attempt - 1]!.resolve();
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          },
          onFailure({ error, signal }) {
            failures.push(error);
            expect(signal.aborted).toBe(true);
            expect(signal.reason).toBe(error);
          },
        });
      });
      const test = await createTestRuntime({ channels: [channel], clients: [client], timeout: "10ms" });

      const dispatch = test.dispatch("timeout", { id: "event", sessionKey: "work" });
      await starts[0]!.promise;
      await vi.advanceTimersByTimeAsync(10);
      await starts[1]!.promise;
      await vi.advanceTimersByTimeAsync(10);
      await dispatch;

      expect(failures).toHaveLength(2);
      expect(failures.every((error) => error instanceof HandlerTimeoutError)).toBe(true);
      expect(failures[0]).toMatchObject({ timeoutMs: 10 });
      expect(await test.sessions.get("work")).toMatchObject({ state: { eager: "kept" } });
      expect(await test.sessions.notes("work")).toEqual([]);
      expect((await test.deliveries.list())[0]).toMatchObject({
        status: "failed",
        attempts: 2,
      });
      expect((await test.deliveries.list())[0]!.lastError).toContain("HandlerTimeoutError");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves handler timeout from handler, client, global, then disabled defaults", () => {
    const channel = createChannel("timeout");
    const client = createClient("client", (builder) => {
      builder.handle(channel, { id: "built-in", handle() {} });
      builder.timeout("20ms");
      builder.handle(channel, { id: "client", handle() {} });
      builder.handle(channel, { id: "handler", timeout: "5ms", handle() {} });
      builder.handle(channel, { id: "disabled", timeout: 0, handle() {} });
    });

    expect(client.handlers.map(({ id, timeout }) => ({ id, timeout }))).toEqual([
      { id: "built-in", timeout: undefined },
      { id: "client", timeout: "20ms" },
      { id: "handler", timeout: "5ms" },
      { id: "disabled", timeout: 0 },
    ]);
  });

  it("clears the deadline after a successful attempt", async () => {
    vi.useFakeTimers();
    try {
      const channel = createChannel("timeout");
      let signal: AbortSignal | undefined;
      const client = createClient("client", (builder) => {
        builder.handle(channel, {
          timeout: "10ms",
          handle(context) {
            signal = context.signal;
          },
        });
      });
      const test = await createTestRuntime({ channels: [channel], clients: [client] });

      await test.dispatch("timeout", { id: "event" });
      await vi.advanceTimersByTimeAsync(100);

      expect(signal?.aborted).toBe(false);
      expect((await test.deliveries.list())[0]).toMatchObject({ status: "processed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a cooperative success hook and rolls back the attempt", async () => {
    vi.useFakeTimers();
    try {
      const channel = createChannel("timeout");
      const started = deferred();
      let failure: unknown;
      const client = createClient("client", (builder) => {
        builder.handle(channel, {
          timeout: "10ms",
          retries: { attempts: 1 },
          handle({ session }) {
            session.set("ordinary", true);
          },
          async onSuccess({ signal }) {
            started.resolve();
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          },
          onFailure({ error }) {
            failure = error;
          },
        });
      });
      const test = await createTestRuntime({ channels: [channel], clients: [client] });

      const dispatch = test.dispatch("timeout", { id: "event", sessionKey: "work" });
      await started.promise;
      await vi.advanceTimersByTimeAsync(10);
      await dispatch;

      expect(failure).toBeInstanceOf(HandlerTimeoutError);
      expect(await test.sessions.get("work")).toMatchObject({ state: {} });
      expect((await test.deliveries.list())[0]).toMatchObject({ status: "failed", attempts: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries after a success hook error and rolls back ordinary attempt changes", async () => {
    const channel = createChannel("retry");
    const calls: string[] = [];
    const operationKeys: string[] = [];
    const client = createClient("client", (builder) => {
      builder.handle(channel, {
        retries: { attempts: 2 },
        handle({ attempt, event, session }) {
          calls.push(`handle:${attempt}`);
          operationKeys.push(`agent-message:${event.channelId}:${event.dedupeKey}`);
          session.set("ordinary", attempt);
          session.note(`attempt ${attempt}`);
        },
        onSuccess({ attempt }) {
          calls.push(`success:${attempt}`);
          if (attempt === 1) throw new Error("acknowledgement uncertain");
        },
        onFailure({ attempt, error, session }) {
          calls.push(`failure:${attempt}:${error instanceof Error ? error.message : String(error)}`);
          session.set("failure-only", true);
          session.note("failure hook note");
          throw new Error("failure hook also failed");
        },
      });
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    await test.dispatch("retry", { id: "event", sessionKey: "work" });

    expect(calls).toEqual([
      "handle:1",
      "success:1",
      "failure:1:acknowledgement uncertain",
      "handle:2",
      "success:2",
    ]);
    expect(operationKeys).toEqual([
      "agent-message:retry:event",
      "agent-message:retry:event",
    ]);
    expect(await test.sessions.get("work")).toMatchObject({
      state: { ordinary: 2 },
    });
    expect(await test.sessions.notes("work")).toMatchObject([{ message: "attempt 2" }]);
    expect((await test.deliveries.list())[0]).toMatchObject({
      status: "processed",
      attempts: 2,
      lastError: undefined,
    });
  });

  it("keeps the original delivery error when the failure hook throws", async () => {
    const channel = createChannel("retry");
    const client = createClient("client", (builder) => {
      builder.handle(channel, {
        retries: { attempts: 1 },
        handle() {
          throw new Error("original failure");
        },
        onFailure() {
          throw new Error("secondary failure");
        },
      });
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    await test.dispatch("retry", { id: "event" });

    const delivery = (await test.deliveries.list())[0]!;
    expect(delivery.status).toBe("failed");
    expect(delivery.lastError).toContain("original failure");
    expect(delivery.lastError).not.toContain("secondary failure");
  });

  it("uses global retry attempts when a client and handler do not override them", async () => {
    const channel = createChannel("retry");
    const client = createClient("client", (builder) => {
      builder.handle(channel, () => {
        throw new Error("permanent");
      });
    });
    const test = await createTestRuntime({
      channels: [channel], clients: [client], retries: { attempts: 1 },
    });

    await test.dispatch("retry", { id: "event-1" });

    const deliveries = await test.deliveries.list();
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
      channels: [channel],
      clients: [clientDefault, globalDefault],
      retries: { attempts: 5 },
    });

    await test.dispatch("retry", { id: "event" });

    const deliveries = await test.deliveries.list();
    expect(Object.fromEntries(deliveries.map(({ handlerId, maxAttempts }) => [handlerId, maxAttempts]))).toEqual({
      "client-default": 2,
      "handler-override": 4,
      "global-default": 5,
    });
  });

  it("resolves retry attempts and delay independently across handler, client, and global defaults", async () => {
    const channel = createChannel("retry");
    const client = createClient("client", (builder) => {
      builder.retries({ attempts: 2, delay: "2s" });
      builder.handle(channel, { id: "client-default", handle() {} });
      builder.handle(channel, { id: "handler-delay", retries: { delay: "3s" }, handle() {} });
      builder.handle(channel, { id: "handler-attempts", retries: { attempts: 4 }, handle() {} });
    });
    const globalClient = createClient("global", (builder) => {
      builder.handle(channel, { id: "global-default", handle() {} });
    });
    const test = await createTestRuntime({
      channels: [channel],
      clients: [client, globalClient],
      retries: { attempts: 5, delay: "5s" },
    });

    await test.dispatch("retry", { id: "event" });

    const deliveries = await test.deliveries.list();
    expect(Object.fromEntries(deliveries.map(({ handlerId, maxAttempts, retryDelayMs }) => [
      handlerId,
      { maxAttempts, retryDelayMs },
    ]))).toEqual({
      "client-default": { maxAttempts: 2, retryDelayMs: 2_000 },
      "handler-delay": { maxAttempts: 2, retryDelayMs: 3_000 },
      "handler-attempts": { maxAttempts: 4, retryDelayMs: 2_000 },
      "global-default": { maxAttempts: 5, retryDelayMs: 5_000 },
    });
  });

  it("leaves future retries pending until a later drain observes their eligibility", async () => {
    const channel = createChannel("retry");
    const store = memoryStore();
    const attempts: number[] = [];
    const client = createClient("client", (builder) => {
      builder.handle(channel, {
        retries: { attempts: 2, delay: "1h" },
        handle({ attempt }) {
          attempts.push(attempt);
          if (attempt === 1) throw new Error("transient");
        },
      });
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] }, { store });

    await test.dispatch("retry", { id: "event" });

    const delayed = (await test.deliveries.list())[0]!;
    expect(attempts).toEqual([1]);
    expect(delayed).toMatchObject({ status: "pending", attempts: 1, retryDelayMs: 3_600_000 });
    expect(Date.parse(delayed.nextAttemptAt!)).toBeGreaterThan(Date.now());

    const state = await store.read();
    state.deliveries[0]!.nextAttemptAt = new Date(0).toISOString();
    await store.write(state);
    await test.drain();

    expect(attempts).toEqual([1, 2]);
    expect((await test.deliveries.list())[0]).toMatchObject({
      status: "processed",
      attempts: 2,
      nextAttemptAt: undefined,
    });
  });

  it("persists failure eligibility for the maximum supported retry delay", async () => {
    const channel = createChannel("retry");
    const client = createClient("client", (builder) => {
      builder.handle(channel, {
        retries: { attempts: 2, delay: `${MAX_RETRY_DELAY_MS}ms` },
        handle() {
          throw new Error("transient");
        },
      });
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    await test.dispatch("retry", { id: "event" });

    const delivery = (await test.deliveries.list())[0]!;
    expect(delivery).toMatchObject({
      status: "pending",
      attempts: 1,
      retryDelayMs: MAX_RETRY_DELAY_MS,
    });
    expect(Date.parse(delivery.nextAttemptAt!) - Date.parse(delivery.updatedAt)).toBe(MAX_RETRY_DELAY_MS);
  });

  it("rounds positive fractional retry delays up to one millisecond", async () => {
    const channel = createChannel("retry");
    const client = createClient("client", (builder) => {
      builder.handle(channel, { id: "number", retries: { delay: 0.1 }, handle() {} });
      builder.handle(channel, { id: "string", retries: { delay: "0.5ms" }, handle() {} });
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    await test.dispatch("retry", { id: "event" });

    expect((await test.deliveries.list()).map(({ retryDelayMs }) => retryDelayMs)).toEqual([1, 1]);
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
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    await test.dispatch("retry", { id: "event", sessionKey: "work" });

    expect(factoryCalls).toBe(1);
    expect(observations).toEqual([
      [1, "stable-id", undefined],
      [2, "stable-id", undefined],
    ]);
    expect(await test.sessions.get("work")).toMatchObject({ state: { resource: "stable-id" } });
  });

  it("keeps ensured values after terminal failure while discarding ordinary changes and notes", async () => {
    const channel = createChannel("retry");
    let factoryCalls = 0;
    const client = createClient("client", (builder) => {
      builder.handle(channel, {
        retries: { attempts: 1 },
        async handle({ session }) {
          await session.ensure("resource", () => {
            factoryCalls += 1;
            return "stable-id";
          });
          session.set("ordinary", "discard-me");
          session.note("discard me");
          session.end({ reason: "discard me" });
          throw new Error("terminal");
        },
      });
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    await test.dispatch("retry", { id: "event", sessionKey: "work" });

    expect(factoryCalls).toBe(1);
    expect(await test.sessions.get("work")).toMatchObject({
      status: "active",
      state: { resource: "stable-id" },
    });
    expect(await test.sessions.notes("work")).toEqual([]);
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
    const test = await createTestRuntime({ channels: [channel], clients: [client] });
    await test.dispatch("retry", { id: "failed-event" });
    const deliveries = await test.deliveries.list();
    const delivery = deliveries[0]!;

    shouldFail = false;
    expect(await test.deliveries.retry(delivery.id)).toBe(true);
    const retriedDeliveries = await test.deliveries.list();
    expect(retriedDeliveries[0]).toMatchObject({ status: "processed", attempts: 2, maxAttempts: 2 });
    expect(await test.deliveries.retry(delivery.id)).toBe(false);
  });

  it("retains ended session history and creates a new active session for the same key", async () => {
    const channel = createChannel("sessions");
    const client = createClient("client", (builder) => {
      builder.handle(channel, ({ event, session }) => {
        session.set("source", event.id);
        if (event.id === "first") session.end({ reason: "complete" });
      });
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

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
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    await test.dispatch("notes", { id: "event", sessionKey: "work" });

    expect(await test.sessions.notes("work")).toMatchObject([
      { message: "Handled review", data: { reviewId: 7 } },
    ]);
  });
});
