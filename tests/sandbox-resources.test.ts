import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createChannel,
  createClient,
  createEnvironment,
  createSandbox,
  memoryStore,
  type HandlerContext,
  type JsonValue,
  type ResourceSandboxDefinition,
} from "../src/index.js";
import { createTestRuntime } from "../src/testing/index.js";
import { validateAndMigrateState } from "../src/stores/state-validation.js";
import { deferred } from "./helpers.js";

describe("typed sandbox resources", () => {
  it("provides currentStatus to legacy sandbox hooks", async () => {
    const channel = createChannel("legacy-status");
    const statuses: string[] = [];
    const environment = createEnvironment("workspace", (builder) => {
      builder.useSandbox({
        create({ currentStatus }) {
          statuses.push(currentStatus);
        },
        cleanup({ currentStatus }) {
          statuses.push(currentStatus);
        },
      });
    });
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, ({ session }) => session.end());
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    await test.dispatch(channel, { id: "event" });

    expect(statuses).toEqual(["creating", "cleaning"]);
    await test.stop();
  });

  it("publishes a returned resource to handlers and cleanup with lifecycle status", async () => {
    const channel = createChannel("typed-return");
    const seen: unknown[] = [];
    const sandbox = createSandbox({
      create({ currentStatus }) {
        seen.push(currentStatus);
        return { workspaceId: "ws-1" };
      },
      cleanup({ resource, currentStatus }) {
        seen.push(resource, currentStatus);
      },
    });
    const environment = createEnvironment("workspace", (builder) => builder.useSandbox(sandbox));
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, ({ sandbox: resources, session }) => {
        seen.push(resources.get(sandbox));
        session.end();
      });
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    await test.dispatch(channel, { id: "event", sessionKey: "work" });

    expect(seen).toEqual([
      "creating",
      { workspaceId: "ws-1" },
      { workspaceId: "ws-1" },
      "cleaning",
    ]);
    expect(await test.sandboxes.list()).toMatchObject([{
      status: "cleaned",
      resource: { workspaceId: "ws-1" },
    }]);
    await test.stop();
  });

  it("preserves eagerly published resources when create later fails", async () => {
    const channel = createChannel("typed-eager");
    let creates = 0;
    const seen: JsonValue[] = [];
    const sandbox = createSandbox<{ workspaceId: string }>({
      async create({ publishResource }) {
        creates += 1;
        await publishResource({ workspaceId: "ws-eager" });
        if (creates === 1) throw new Error("response lost");
      },
      reconcile({ resource, currentStatus }) {
        seen.push(resource ?? null, currentStatus);
        return "active" as const;
      },
    });
    const environment = createEnvironment("workspace", (builder) => builder.useSandbox(sandbox));
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, {
        retries: { attempts: 2 },
        handle({ sandbox: resources }) {
          seen.push(resources.get(sandbox));
        },
      });
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    await test.dispatch(channel, { id: "event" });

    expect(creates).toBe(1);
    expect(seen).toEqual([{ workspaceId: "ws-eager" }, "creating", { workspaceId: "ws-eager" }]);
    expect(await test.sandboxes.list()).toMatchObject([{ status: "active", resource: { workspaceId: "ws-eager" } }]);
    await test.stop();
  });

  it("allows reconciliation to publish the resource before reporting active", async () => {
    const channel = createChannel("typed-reconcile-publish");
    let creates = 0;
    const sandbox = createSandbox<{ workspaceId: string }>({
      create() {
        creates += 1;
        throw new Error("creation uncertain");
      },
      async reconcile({ publishResource }) {
        await publishResource({ workspaceId: "recovered" });
        return "active" as const;
      },
    });
    const environment = createEnvironment("workspace", (builder) => builder.useSandbox(sandbox));
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, {
        retries: { attempts: 2 },
        handle({ sandbox: resources }) {
          expect(resources.get(sandbox)).toEqual({ workspaceId: "recovered" });
        },
      });
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    await test.dispatch(channel, { id: "event" });

    expect(creates).toBe(1);
    expect((await test.deliveries.list())[0]).toMatchObject({ status: "processed", attempts: 2 });
    await test.stop();
  });

  it("durably prepares an active resource before each handler", async () => {
    const channel = createChannel("typed-prepare");
    const sandbox = createSandbox({
      create: () => ({ revision: 0 }),
      prepare: ({ resource }) => ({ revision: resource!.revision + 1 }),
    });
    const environment = createEnvironment("workspace", (builder) => builder.useSandbox(sandbox));
    const seen: number[] = [];
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, ({ sandbox: resources }) => {
        seen.push(resources.get(sandbox).revision);
      });
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    await test.dispatch(channel, { id: "first", sessionKey: "work" });
    await test.dispatch(channel, { id: "second", sessionKey: "work" });

    expect(seen).toEqual([1, 2]);
    expect(await test.sandboxes.list()).toMatchObject([{ resource: { revision: 2 } }]);
    await test.stop();
  });

  it("reuses an eagerly prepared resource after a runtime restart", async () => {
    const createChannelDefinition = createChannel("typed-prepare-create");
    const resumeChannel = createChannel("typed-prepare-resume");
    const seen: string[] = [];
    let interrupted = true;
    const sandbox = createSandbox<{ id: string }>({
      create: () => ({ id: "created" }),
      async prepare({ resource, publishResource }) {
        if (interrupted) {
          interrupted = false;
          await publishResource({ id: "replacement" });
          throw new Error("preparation interrupted");
        }
        return resource;
      },
    });
    const environment = createEnvironment("workspace", (builder) => builder.useSandbox(sandbox));
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(createChannelDefinition, { retries: { attempts: 1 }, handle: vi.fn() });
      builder.handle(resumeChannel, {
        session: "existing-only",
        handle({ sandbox: resources }) {
          seen.push(resources.get(sandbox).id);
        },
      });
    });
    const store = memoryStore();
    const config = { channels: [createChannelDefinition, resumeChannel], clients: [client] };
    const first = await createTestRuntime(config, { store });
    await first.dispatch(createChannelDefinition, { id: "first", sessionKey: "work" });
    expect(await first.sandboxes.list()).toMatchObject([{ resource: { id: "replacement" } }]);
    await first.stop();

    const restarted = await createTestRuntime(config, { store });
    await restarted.dispatch(resumeChannel, { id: "second", sessionKey: "work" });

    expect(seen).toEqual(["replacement"]);
    const sandboxes = await restarted.sandboxes.list();
    expect(sandboxes).toMatchObject([{ resource: { id: "replacement" } }]);
    expect(sandboxes[0]?.lastError).toBeUndefined();
    await restarted.stop();
  });

  it("blocks active resource-aware sandboxes without a published resource", async () => {
    const channel = createChannel("typed-missing");
    const sandbox = createSandbox<{ workspaceId: string }>({ create() {} });
    const environment = createEnvironment("workspace", (builder) => builder.useSandbox(sandbox));
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, { retries: { attempts: 1 }, handle: vi.fn() });
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    await test.dispatch(channel, { id: "event" });

    expect((await test.deliveries.list())[0]).toMatchObject({
      status: "failed",
      lastError: expect.stringContaining("no published resource"),
    });
    expect(await test.sandboxes.list()).toMatchObject([{ status: "creating" }]);
    await test.stop();
  });

  it("does not persist an active reconciliation disposition without a resource", async () => {
    const channel = createChannel("typed-reconcile-missing");
    const sandbox = createSandbox<{ workspaceId: string }>({
      create() {
        throw new Error("creation uncertain");
      },
      reconcile() {
        return "active";
      },
    });
    const environment = createEnvironment("workspace", (builder) => builder.useSandbox(sandbox));
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, { retries: { attempts: 2 }, handle: vi.fn() });
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    await test.dispatch(channel, { id: "event" });

    expect((await test.deliveries.list())[0]).toMatchObject({
      status: "failed",
      lastError: expect.stringContaining("no published resource"),
    });
    expect(await test.sandboxes.list()).toMatchObject([{ status: "creating" }]);
    await test.stop();
  });

  it("treats null as a present resource and rejects non-JSON resources", async () => {
    const channel = createChannel("typed-json");
    const nullSandbox = createSandbox<null>({ create: () => null });
    const invalidSandbox = createSandbox<JsonValue>({ create: () => Number.NaN });
    const nullEnvironment = createEnvironment("null", (builder) => builder.useSandbox(nullSandbox));
    const invalidEnvironment = createEnvironment("invalid", (builder) => builder.useSandbox(invalidSandbox));
    const nullClient = createClient("null-client", (builder) => {
      builder.useEnvironment(nullEnvironment);
      builder.handle(channel, ({ sandbox }) => expect(sandbox.get(nullSandbox)).toBeNull());
    });
    const invalidClient = createClient("invalid-client", (builder) => {
      builder.useEnvironment(invalidEnvironment);
      builder.handle(channel, { retries: { attempts: 1 }, handle: vi.fn() });
    });
    const test = await createTestRuntime({ channels: [channel], clients: [nullClient, invalidClient] });

    await test.dispatch(channel, { id: "event" });

    const deliveries = await test.deliveries.list();
    expect(deliveries.find(({ clientId }) => clientId === "null-client")).toMatchObject({ status: "processed" });
    expect(deliveries.find(({ clientId }) => clientId === "invalid-client")).toMatchObject({
      status: "failed",
      lastError: expect.stringContaining("JSON-safe"),
    });
    expect((await test.sandboxes.list()).find(({ clientId }) => clientId === "null-client")).toHaveProperty("resource", null);
    await test.stop();
  });

  it("retains the resource through failed cleanup and administrative completion", async () => {
    const channel = createChannel("typed-completion");
    let fail = true;
    const resources: unknown[] = [];
    const sandbox = createSandbox({
      create: () => ({ workspaceId: "ws-1" }),
      cleanup({ resource, cause }) {
        resources.push(resource, cause.type);
        if (fail) throw new Error("cleanup failed");
      },
    });
    const environment = createEnvironment("workspace", (builder) => builder.useSandbox(sandbox));
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.capacity({ maxActiveSessions: 1 });
      builder.handle(channel, () => {});
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });
    await test.dispatch(channel, { id: "event", sessionKey: "work" });
    const session = (await test.sessions.list())[0]!;

    await expect(test.sessions.complete(session.id)).rejects.toThrow("cleanup failed");
    expect(await test.sessions.get(session.id)).toMatchObject({ status: "active" });
    expect(await test.capacity.list()).toHaveLength(1);
    expect(await test.sandboxes.list()).toMatchObject([{
      status: "cleaning",
      resource: { workspaceId: "ws-1" },
    }]);

    fail = false;
    await expect(test.sessions.complete(session.id, "operator")).resolves.toBe(true);
    expect(resources).toEqual([
      { workspaceId: "ws-1" }, "completion",
      { workspaceId: "ws-1" }, "completion",
    ]);
    expect(await test.sessions.get(session.id)).toMatchObject({ status: "ended", endReason: "operator" });
    expect(await test.capacity.list()).toEqual([]);
    await test.stop();
  });

  it("resumes typed cleanup directly from the cleaning delivery phase", async () => {
    const channel = createChannel("typed-phase-resume");
    let cleanups = 0;
    let reconciles = 0;
    const sandbox = createSandbox({
      create: () => ({ id: "resource" }),
      cleanup() {
        cleanups += 1;
        if (cleanups === 1) throw new Error("retry cleanup");
      },
      reconcile() {
        reconciles += 1;
        return "unknown";
      },
    });
    const environment = createEnvironment("workspace", (builder) => builder.useSandbox(sandbox));
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, {
        retries: { attempts: 2 },
        handle({ session }) {
          session.end();
        },
      });
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    await test.dispatch(channel, { id: "event" });

    expect(cleanups).toBe(2);
    expect(reconciles).toBe(0);
    expect((await test.deliveries.list())[0]).toMatchObject({ status: "processed", attempts: 2 });
    await test.stop();
  });

  it("gives existing-only handlers prepared access without invoking creation or reconciliation", async () => {
    const createChannelDefinition = createChannel("typed-existing-only-create");
    const channel = createChannel("typed-existing-only");
    const other = createSandbox({ create: () => ({ wrong: true }) });
    const create = vi.fn(() => ({ workspaceId: "ws-1" }));
    const reconcile = vi.fn(() => "active" as const);
    const prepare = vi.fn(({ resource }) => resource);
    const sandbox = createSandbox({ create, prepare, reconcile });
    const environment = createEnvironment("workspace", (builder) => builder.useSandbox(sandbox));
    const observed: unknown[] = [];
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(createChannelDefinition, () => {});
      builder.handle(channel, {
        id: "existing",
        session: "existing-only",
        handle({ event, sandbox: resources }) {
          if (event.id !== "second") return;
          observed.push(resources.getOptional(sandbox));
          expect(() => resources.getOptional(other)).toThrow("not configured");
        },
      });
    });
    const test = await createTestRuntime({ channels: [createChannelDefinition, channel], clients: [client] });
    await test.dispatch(createChannelDefinition, { id: "first", sessionKey: "work" });
    create.mockClear();
    prepare.mockClear();
    reconcile.mockClear();

    await test.dispatch(channel, { id: "second", sessionKey: "work" });

    expect(observed).toEqual([{ workspaceId: "ws-1" }]);
    expect(create).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledOnce();
    await test.stop();
  });

  it("returns undefined for an existing-only handler without an active client sandbox", async () => {
    const channel = createChannel("typed-existing-only-empty");
    const create = vi.fn(() => ({ workspaceId: "unexpected" }));
    const reconcile = vi.fn(() => "active" as const);
    const sandbox = createSandbox({ create, reconcile });
    const environment = createEnvironment("workspace", (builder) => builder.useSandbox(sandbox));
    const observed: unknown[] = [];
    const creator = createClient("creator", (builder) => builder.handle(channel, () => {}));
    const observer = createClient("observer", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, {
        session: "existing-only",
        handle({ sandbox: resources }) {
          observed.push(resources.getOptional(sandbox));
        },
      });
    });
    const test = await createTestRuntime({ channels: [channel], clients: [creator, observer] });
    await test.dispatch(channel, { id: "first", sessionKey: "work" });

    await test.dispatch(channel, { id: "second", sessionKey: "work" });

    expect(observed).toEqual([undefined]);
    expect(create).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    await test.stop();
  });

  it("lets existing-only handlers inspect a migrated active sandbox without running hooks", async () => {
    const channel = createChannel("typed-existing-only-migrated");
    const create = vi.fn(() => ({ workspaceId: "legacy" }));
    const reconcile = vi.fn(() => "active" as const);
    const sandbox = createSandbox({ create, reconcile });
    const environment = createEnvironment("workspace", (builder) => builder.useSandbox(sandbox));
    const creator = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, () => {});
    });
    const initial = await createTestRuntime({ channels: [channel], clients: [creator] });
    await initial.dispatch(channel, { id: "first", sessionKey: "work" });
    const state = await initial.readState();
    await initial.stop();
    delete state.sandboxes[0]!.resource;
    create.mockClear();
    reconcile.mockClear();

    const observed: unknown[] = [];
    const observer = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, {
        session: "existing-only",
        handle({ sandbox: resources }) {
          observed.push(resources.getOptional(sandbox));
        },
      });
    });
    const restarted = await createTestRuntime(
      { channels: [channel], clients: [observer] },
      { store: memoryStore(state) },
    );

    await restarted.dispatch(channel, { id: "second", sessionKey: "work" });

    expect(observed).toEqual([undefined]);
    expect(create).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    await restarted.stop();
  });

  it("reconciles a version-7 active sandbox before exposing a typed resource", async () => {
    const channel = createChannel("typed-v7-delivery");
    const legacyEnvironment = createEnvironment("workspace", (builder) => {
      builder.useSandbox({ create() {} });
    });
    const legacyClient = createClient("client", (builder) => {
      builder.useEnvironment(legacyEnvironment);
      builder.handle(channel, () => {});
    });
    const original = await createTestRuntime({ channels: [channel], clients: [legacyClient] });
    await original.dispatch(channel, { id: "first", sessionKey: "work" });
    const historical = structuredClone(await original.readState()) as unknown as Record<string, unknown>;
    await original.stop();
    historical.version = 7;
    for (const record of historical.sandboxes as Array<Record<string, unknown>>) {
      delete record.cleanupSteps;
      delete record.resource;
    }

    const create = vi.fn();
    const reconcile = vi.fn(async ({ resource, publishResource }: {
      resource?: Readonly<{ workspaceId: string }> | undefined;
      publishResource(value: { workspaceId: string }): Promise<void>;
    }) => {
      expect(resource).toBeUndefined();
      await publishResource({ workspaceId: "recovered-v7" });
      return "active" as const;
    });
    const sandbox = createSandbox<{ workspaceId: string }>({ create, reconcile });
    const environment = createEnvironment("workspace", (builder) => builder.useSandbox(sandbox));
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, ({ event, sandbox: resources }) => {
        if (event.id === "second") expect(resources.get(sandbox)).toEqual({ workspaceId: "recovered-v7" });
      });
    });
    const restarted = await createTestRuntime(
      { channels: [channel], clients: [client] },
      { store: memoryStore(validateAndMigrateState(historical)) },
    );

    await restarted.dispatch(channel, { id: "second", sessionKey: "work" });

    expect(create).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(await restarted.sandboxes.list()).toMatchObject([{
      status: "active",
      resource: { workspaceId: "recovered-v7" },
    }]);
    await restarted.stop();
  });

  it("reconciles a version-7 active sandbox before administrative cleanup", async () => {
    const channel = createChannel("typed-v7-completion");
    const legacyEnvironment = createEnvironment("workspace", (builder) => {
      builder.useSandbox({ create() {} });
    });
    const legacyClient = createClient("client", (builder) => {
      builder.useEnvironment(legacyEnvironment);
      builder.handle(channel, () => {});
    });
    const original = await createTestRuntime({ channels: [channel], clients: [legacyClient] });
    await original.dispatch(channel, { id: "first", sessionKey: "work" });
    const sessionId = (await original.sessions.list())[0]!.id;
    const historical = structuredClone(await original.readState()) as unknown as Record<string, unknown>;
    await original.stop();
    historical.version = 7;
    for (const record of historical.sandboxes as Array<Record<string, unknown>>) {
      delete record.cleanupSteps;
      delete record.resource;
    }

    const cleanup = vi.fn();
    const sandbox = createSandbox<{ workspaceId: string }>({
      create: vi.fn(),
      async reconcile({ publishResource }) {
        await publishResource({ workspaceId: "recovered-v7" });
        return "active" as const;
      },
      cleanup({ resource }) {
        cleanup(resource);
      },
    });
    const environment = createEnvironment("workspace", (builder) => builder.useSandbox(sandbox));
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, () => {});
    });
    const restarted = await createTestRuntime(
      { channels: [channel], clients: [client] },
      { store: memoryStore(validateAndMigrateState(historical)) },
    );

    await expect(restarted.sessions.complete(sessionId, "operator")).resolves.toBe(true);

    expect(cleanup).toHaveBeenCalledWith({ workspaceId: "recovered-v7" });
    expect(await restarted.sessions.get(sessionId)).toMatchObject({ status: "ended", endReason: "operator" });
    await restarted.stop();
  });

  it("recreates in the same attempt when a resource-less active sandbox reconciles as cleaned", async () => {
    const channel = createChannel("typed-active-cleaned");
    const create = vi.fn(() => ({ workspaceId: "new" }));
    const reconcile = vi.fn(() => "cleaned" as const);
    const sandbox = createSandbox({
      create,
      reconcile,
    });
    const environment = createEnvironment("workspace", (builder) => builder.useSandbox(sandbox));
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, ({ event, sandbox: resources }) => {
        if (event.id === "second") expect(resources.get(sandbox)).toEqual({ workspaceId: "new" });
      });
    });
    const seed = await createTestRuntime({ channels: [channel], clients: [client] });
    await seed.dispatch(channel, { id: "first", sessionKey: "work" });
    const state = await seed.readState();
    await seed.stop();
    delete state.sandboxes[0]!.resource;
    create.mockClear();
    reconcile.mockClear();
    const restarted = await createTestRuntime(
      { channels: [channel], clients: [client] },
      { store: memoryStore(state) },
    );

    await restarted.dispatch(channel, { id: "second", sessionKey: "work" });

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect((await restarted.deliveries.list()).find(({ eventId }) => eventId !== state.deliveries[0]!.eventId)).toMatchObject({
      status: "processed",
      attempts: 1,
    });
    await restarted.stop();
  });

  it("infers the exact resource type through the public handler accessor", () => {
    const sandbox = createSandbox({
      create: () => ({ workspaceId: "ws-1", revision: 1 }),
    });
    expectTypeOf(sandbox).toMatchTypeOf<ResourceSandboxDefinition<{ workspaceId: string; revision: number }>>();

    const assertContext = (context: HandlerContext) => {
      expectTypeOf(context.sandbox.get(sandbox)).toEqualTypeOf<Readonly<{ workspaceId: string; revision: number }>>();
      expectTypeOf(context.sandbox.getOptional(sandbox)).toEqualTypeOf<
        Readonly<{ workspaceId: string; revision: number }> | undefined
      >();
    };
    expectTypeOf(assertContext).toBeFunction();

    createSandbox({
      create: () => ({ workspaceId: "ws-1" }),
      cleanup({ cleanup }) {
        return cleanup.step("readonly", { retry: "idempotent" }, ({ session }) => {
          // @ts-expect-error cleanup step sessions are intentionally readonly
          session.set("invalid", true);
        });
      },
    });
  });

  it("brands resource definitions across package module contexts", () => {
    const sandbox = createSandbox({ create: () => ({ id: "resource" }) });
    const brand = Symbol.for("simple-agent-orchestrator.resource-sandbox");

    expect((sandbox as unknown as Record<symbol, unknown>)[brand]).toBe(true);
    expect(Object.keys(sandbox)).toEqual(["create"]);
  });
});

describe("durable sandbox cleanup steps", () => {
  it("skips a completed step when later cleanup work makes the sandbox retry", async () => {
    const channel = createChannel("cleanup-completed-skip");
    let stepCalls = 0;
    let cleanupCalls = 0;
    const sandbox = createSandbox({
      create: () => ({ id: "resource" }),
      async cleanup({ cleanup }) {
        cleanupCalls += 1;
        await cleanup.step("remove", { retry: "idempotent" }, () => {
          stepCalls += 1;
        });
        if (cleanupCalls === 1) throw new Error("later cleanup failed");
      },
    });
    const environment = createEnvironment("workspace", (builder) => builder.useSandbox(sandbox));
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, { retries: { attempts: 2 }, handle({ session }) { session.end(); } });
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    await test.dispatch(channel, { id: "event" });

    expect(cleanupCalls).toBe(2);
    expect(stepCalls).toBe(1);
    expect(await test.sandboxes.list()).toMatchObject([{
      cleanupSteps: { remove: { status: "completed", attempts: 1 } },
    }]);
    await test.stop();
  });

  it("skips completed steps and supports independent all-settled cleanup", async () => {
    const channel = createChannel("cleanup-independent");
    const calls: string[] = [];
    const sandbox = createSandbox({
      create: () => ({ id: "resource" }),
      async cleanup({ cleanup }) {
        const results = await Promise.allSettled([
          cleanup.step("first", { retry: "idempotent" }, () => { calls.push("first"); }),
          cleanup.step("second", { retry: "idempotent" }, () => { calls.push("second"); }),
          cleanup.step("__proto__", { retry: "idempotent" }, () => { calls.push("__proto__"); }),
        ]);
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map(({ reason }) => reason));
      },
    });
    const environment = createEnvironment("workspace", (builder) => builder.useSandbox(sandbox));
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, ({ session }) => session.end());
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    await test.dispatch(channel, { id: "event" });

    expect(calls.sort()).toEqual(["__proto__", "first", "second"]);
    const records = await test.sandboxes.list();
    expect(records).toMatchObject([{
      cleanupSteps: {
        first: { status: "completed", attempts: 1 },
        second: { status: "completed", attempts: 1 },
      },
    }]);
    expect(Object.hasOwn(records[0]!.cleanupSteps, "__proto__")).toBe(true);
    expect(records[0]!.cleanupSteps["__proto__"]).toMatchObject({ status: "completed", attempts: 1 });
    await test.stop();
  });

  it("retries failed and restart-interrupted idempotent steps", async () => {
    const channel = createChannel("cleanup-idempotent-retry");
    let calls = 0;
    const sandbox = createSandbox({
      create: () => ({ id: "resource" }),
      async cleanup({ cleanup }) {
        await cleanup.step("remove", { retry: "idempotent" }, () => {
          calls += 1;
          if (calls === 1) throw new Error("transient");
        });
      },
    });
    const environment = createEnvironment("workspace", (builder) => builder.useSandbox(sandbox));
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, { retries: { attempts: 2 }, handle({ session }) { session.end(); } });
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    await test.dispatch(channel, { id: "event" });

    expect(calls).toBe(2);
    expect(await test.sandboxes.list()).toMatchObject([{
      cleanupSteps: { remove: { status: "completed", attempts: 2 } },
    }]);
    await test.stop();

    const state = await test.readState();
    const record = state.sandboxes[0]!;
    state.sessions[0]!.status = "active";
    state.sessions[0]!.endedAt = undefined;
    state.sessions[0]!.endReason = undefined;
    record.status = "cleaning";
    record.cleanupSteps.remove!.status = "running";
    record.cleanupSteps.remove!.completedAt = undefined;
    const restartStore = memoryStore(state);
    const restarted = await createTestRuntime({ channels: [channel], clients: [client] }, { store: restartStore });
    await restarted.sessions.complete(state.sessions[0]!.id);
    expect(calls).toBe(3);
    expect(await restarted.sandboxes.list()).toMatchObject([{
      cleanupSteps: { remove: { status: "completed", attempts: 3 } },
    }]);
    await restarted.stop();
  });

  it.each([
    ["completed", false, "completed"],
    ["incomplete", true, "completed"],
    ["unknown", false, "unknown"],
  ] as const)("reconciles persisted steps as %s", async (disposition, runs, finalStatus) => {
    const channel = createChannel(`cleanup-reconcile-${disposition}`);
    const operation = vi.fn();
    const sandbox = createSandbox({
      create: () => ({ id: "resource" }),
      async cleanup({ cleanup }) {
        await cleanup.step("external", { reconcile: () => disposition }, operation);
      },
    });
    const environment = createEnvironment("workspace", (builder) => builder.useSandbox(sandbox));
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, () => {});
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });
    await test.dispatch(channel, { id: "event", sessionKey: "work" });
    const state = await test.readState();
    const record = state.sandboxes[0]!;
    const timestamp = new Date().toISOString();
    record.status = "cleaning";
    record.cleanupSteps.external = {
      status: "failed",
      attempts: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: timestamp,
      lastError: "prior failure",
    };
    await test.stop();
    const store = memoryStore(state);
    const restarted = await createTestRuntime({ channels: [channel], clients: [client] }, { store });

    const completion = restarted.sessions.complete(state.sessions[0]!.id);
    if (disposition === "unknown") await expect(completion).rejects.toThrow("remained unknown");
    else await expect(completion).resolves.toBe(true);

    expect(operation).toHaveBeenCalledTimes(runs ? 1 : 0);
    expect(await restarted.sandboxes.list()).toMatchObject([{
      cleanupSteps: { external: { status: finalStatus, attempts: runs ? 2 : 1 } },
    }]);
    await restarted.stop();
  });

  it("does not start a later cleanup step after abort", async () => {
    const channel = createChannel("cleanup-abort");
    const firstStarted = deferred();
    const calls: string[] = [];
    const sandbox = createSandbox({
      create: () => ({ id: "resource" }),
      async cleanup({ cleanup, signal }) {
        await cleanup.step("first", { retry: "idempotent" }, async () => {
          calls.push("first");
          firstStarted.resolve();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        });
        await cleanup.step("second", { retry: "idempotent" }, () => { calls.push("second"); });
      },
    });
    const environment = createEnvironment("workspace", (builder) => builder.useSandbox(sandbox));
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, ({ session }) => session.end());
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });
    await test.runtime.dispatch(channel, { id: "event" });
    await test.runtime.start({ prettyStartupLog: false });
    await firstStarted.promise;

    await test.stop();

    expect(calls).toEqual(["first"]);
    expect(await test.sandboxes.list()).toMatchObject([{
      status: "cleaning",
      cleanupSteps: { first: { status: "completed" } },
    }]);
  });
});
