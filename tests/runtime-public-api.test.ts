import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChannel, createClient } from "../src/index.js";
import type { ChannelDefinition, ClientDefinition, PollDefinition } from "../src/index.js";
import type { OfflineOperationContext } from "../src/runtime/index.js";
import type { RegisteredHandler } from "../src/core/client.js";
import { createProjectContext, createRuntime as createPublicRuntime } from "../src/runtime/index.js";
import { emptyState, type Store } from "../src/stores/store.js";
import { createRuntime, deferred } from "./helpers.js";

describe("runtime public API", () => {
  it("routes channel dispatch only when exactly one initialized runtime is bound", async () => {
    const channel = createChannel("shared");
    await expect(channel.dispatch({ id: "unbound" })).rejects.toThrow(/not bound.*initialized/i);

    const first = await createRuntime({ channels: [channel] });
    const second = await createRuntime({ channels: [channel] });
    await first.init();
    expect(await channel.dispatch({ id: "first" })).toMatchObject({ status: "queued" });

    await second.init();
    await expect(channel.dispatch({ id: "ambiguous" })).rejects.toThrow(/multiple initialized/i);
    expect(await first.dispatch(channel, { id: "explicit-first" })).toMatchObject({ status: "queued" });
    expect(await second.dispatch(channel, { id: "explicit-second" })).toMatchObject({ status: "queued" });

    await first.stop();
    expect(await channel.dispatch({ id: "second" })).toMatchObject({ status: "queued" });
    expect((await second.listEvents()).map(({ event }) => event.sourceId)).toContain("second");

    await second.stop();
    await expect(channel.dispatch({ id: "detached" })).rejects.toThrow(/not bound.*initialized/i);
  });

  it("requires the exact registered channel object for object dispatch", async () => {
    const registered = createChannel("identity");
    const lookalike = createChannel("identity");
    const runtime = await createRuntime({ channels: [registered] });

    expect(await runtime.dispatch(registered, { id: "accepted" })).toMatchObject({ status: "queued" });
    await expect(runtime.dispatch(lookalike, { id: "rejected" })).rejects.toThrow("Unknown channel: identity");
    expect(await runtime.dispatch("identity", { id: "string" })).toMatchObject({ status: "queued" });
    await runtime.stop();
  });

  it("observes configuration composition before init and preserves client identity", async () => {
    const channels: ChannelDefinition[] = [];
    const clients: ClientDefinition[] = [];
    let contextClient: ClientDefinition | undefined;
    let composedHandlerRan = false;
    const runtime = await createRuntime({ channels, clients });
    const channel = createChannel("composed");
    const client = createClient("composed-client", (builder) => {
      builder.handle(channel, ({ client: received }) => {
        contextClient = received;
      });
    });

    (client.handlers as RegisteredHandler[]).push({
      ...client.handlers[0]!,
      id: "composed-handler",
      handle: () => {
        composedHandlerRan = true;
      },
    });
    channels.push(channel);
    clients.push(client);
    await runtime.init();
    await runtime.dispatch(channel, { id: "event" });
    await runtime.drain();

    expect(contextClient).toBe(client);
    expect(composedHandlerRan).toBe(true);
    await runtime.stop();
  });

  it("compiles registrations without freezing their inspectable definitions", async () => {
    const channel = createChannel("snapshot");
    let handled = 0;
    let lateHandled = 0;
    const client = createClient("worker", (builder) => {
      builder.handle(channel, () => {
        handled += 1;
      });
    });
    const runtime = await createRuntime({ channels: [channel], clients: [client] });
    await runtime.init();

    expect(Object.isFrozen(channel)).toBe(false);
    expect(Object.isFrozen(channel.polls)).toBe(false);
    (channel.polls as PollDefinition[]).push({ every: "invalid after init", fetch: () => [] });
    (client.handlers as RegisteredHandler[]).push({
      ...client.handlers[0]!,
      id: "late-handler",
      handle: () => {
        lateHandled += 1;
      },
    });

    await runtime.dispatch(channel, { id: "event" });
    await runtime.drain();
    expect(handled).toBe(1);
    expect(lateHandled).toBe(0);
    await runtime.stop();
  });

  it("initializes a custom store before every public runtime access path", async () => {
    let initialized = false;
    let initCalls = 0;
    let state = emptyState();
    const store: Store = {
      name: "strict-init",
      async init() {
        initialized = true;
        initCalls += 1;
      },
      async read() {
        if (!initialized) throw new Error("read before init");
        return structuredClone(state);
      },
      async write(next) {
        if (!initialized) throw new Error("write before init");
        state = structuredClone(next);
      },
    };
    const runtime = await createRuntime({ store });

    expect(await runtime.listSessions()).toEqual([]);
    expect(await runtime.getSession("missing")).toBeUndefined();
    expect(await runtime.listSessionNotes("missing")).toEqual([]);
    expect(await runtime.listEvents()).toEqual([]);
    expect(await runtime.endSession("missing")).toBe(false);
    expect(await runtime.retryDelivery("missing")).toBe(false);
    expect(initCalls).toBe(1);
    await runtime.stop();
  });

  it("creates runtimes from object, synchronous, and asynchronous project config", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-create-runtime-"));
    const objectRuntime = await createPublicRuntime({}, { root });
    const syncRuntime = await createPublicRuntime(({ project }) => ({ name: project.root }), { root });
    const asyncRuntime = await createPublicRuntime(async ({ project }) => ({ name: project.root }), { root });

    for (const runtime of [objectRuntime, syncRuntime, asyncRuntime]) {
      expect(runtime.project.root).toBe(root);
      expect((await runtime.printConfig()).store).toMatch(/^json-file:/);
      await runtime.stop();
    }
  });

  it("rejects conflicting project discovery options", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-create-runtime-"));
    const project = await createProjectContext(root);
    await expect(createPublicRuntime({}, {
      project,
      root,
    } as never)).rejects.toThrow("project together with root or cwd");
  });

  it("exposes scoped mutations through offline context and accepts synchronous callbacks", async () => {
    const channel = createChannel("offline");
    const client = createClient("worker", (builder) => {
      builder.handle(channel, ({ session }) => session.set("handled", true));
    });
    const runtime = await createRuntime({ channels: [channel], clients: [client] });

    const result = await runtime.runOffline((context) => {
      expect(Object.keys(context).sort()).toEqual([
        "dispatch",
        "drain",
        "endSession",
        "pruneState",
        "retryDelivery",
      ]);
      return context.dispatch(channel, { id: "event", sessionKey: "work" })
        .then(() => context.drain())
        .then(() => context.endSession("work"))
        .then(async (ended) => {
          expect(ended).toBe(true);
          expect(await context.retryDelivery("missing")).toBe(false);
          return context.pruneState({ before: new Date(Date.now() + 60_000), dropDedupe: true });
        });
    });

    expect(result.deliveryIds).toHaveLength(1);
    expect(result.sessionIds).toHaveLength(1);

    const syncRuntime = await createRuntime({});
    expect(await syncRuntime.runOffline(() => 42)).toBe(42);
  });

  it("does not invoke offline callbacks when config or store initialization fails and releases ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-offline-init-"));
    const invalidConfigLock = join(root, "invalid-config.lock");
    const first = createChannel("duplicate");
    const second = createChannel("duplicate");
    const invalidConfigStore: Store = {
      name: "invalid-config",
      runtimeLockPath: invalidConfigLock,
      async init() {},
      async read() {
        return emptyState();
      },
      async write() {},
    };
    let configCallbackInvoked = false;
    const invalidConfigRuntime = await createRuntime({
      channels: [first, second],
      store: invalidConfigStore,
    });

    await expect(invalidConfigRuntime.runOffline(() => {
      configCallbackInvoked = true;
    })).rejects.toThrow("Duplicate channel id");
    expect(configCallbackInvoked).toBe(false);
    await expect(readFile(invalidConfigLock, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const invalidStoreLock = join(root, "invalid-store.lock");
    const invalidStore: Store = {
      name: "invalid-store",
      runtimeLockPath: invalidStoreLock,
      async init() {
        throw new Error("store init failed");
      },
      async read() {
        return emptyState();
      },
      async write() {},
    };
    let storeCallbackInvoked = false;
    const invalidStoreRuntime = await createRuntime({ store: invalidStore });

    await expect(invalidStoreRuntime.runOffline(() => {
      storeCallbackInvoked = true;
    })).rejects.toThrow("store init failed");
    expect(storeCallbackInvoked).toBe(false);
    await expect(readFile(invalidStoreLock, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects retained offline context methods after the callback settles", async () => {
    const channel = createChannel("escaped");
    const runtime = await createRuntime({ channels: [channel] });
    let escaped: OfflineOperationContext | undefined;

    await runtime.runOffline((context) => {
      escaped = context;
    });

    const context = escaped!;
    await expect(context.dispatch(channel, { id: "late" })).rejects.toThrow("no longer active");
    await expect(context.drain()).rejects.toThrow("no longer active");
    await expect(context.endSession("missing")).rejects.toThrow("no longer active");
    await expect(context.retryDelivery("missing")).rejects.toThrow("no longer active");
    await expect(context.pruneState({ before: new Date() })).rejects.toThrow("no longer active");
  });

  it("waits for detached offline context operations before releasing the scope", async () => {
    const channel = createChannel("detached");
    const writeStarted = deferred();
    const releaseWrite = deferred();
    let state = emptyState();
    const store: Store = {
      name: "blocked-write",
      async init() {},
      async read() {
        return structuredClone(state);
      },
      async write(next) {
        writeStarted.resolve();
        await releaseWrite.promise;
        state = structuredClone(next);
      },
    };
    const runtime = await createRuntime({ channels: [channel], store });
    let settled = false;

    const offline = runtime.runOffline((context) => {
      void context.dispatch(channel, { id: "event" });
    }).finally(() => {
      settled = true;
    });

    await writeStarted.promise;
    expect(settled).toBe(false);
    releaseWrite.resolve();
    await offline;
    expect(state.events).toHaveLength(1);
  });

  it("rejects mutation methods after stop while preserving inspection", async () => {
    const channel = createChannel("stopped");
    const runtime = await createRuntime({ channels: [channel] });
    await runtime.dispatch(channel, { id: "before-stop" });
    await runtime.stop();

    expect(await runtime.listEvents()).toHaveLength(1);
    await expect(runtime.dispatch(channel, { id: "after-stop" })).rejects.toThrow("stopped");
    await expect(runtime.endSession("missing")).rejects.toThrow("stopped");
    await expect(runtime.retryDelivery("missing")).rejects.toThrow("stopped");
    await expect(runtime.pruneState({ before: new Date() })).rejects.toThrow("stopped");
  });

  it("waits for accepted direct mutations before shutdown completes", async () => {
    const channel = createChannel("shutdown-mutation");
    const writeStarted = deferred();
    const releaseWrite = deferred();
    let state = emptyState();
    const store: Store = {
      name: "shutdown-mutation",
      async init() {},
      async read() {
        return structuredClone(state);
      },
      async write(next) {
        writeStarted.resolve();
        await releaseWrite.promise;
        state = structuredClone(next);
      },
    };
    const runtime = await createRuntime({ channels: [channel], store });
    const dispatch = runtime.dispatch(channel, { id: "accepted" });
    await writeStarted.promise;
    let stopped = false;
    const stopping = runtime.stop().finally(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseWrite.resolve();
    await dispatch;
    await stopping;
    expect(state.events).toHaveLength(1);
  });

  it("rejects initialization when stop wins an initialization race", async () => {
    const initStarted = deferred();
    const releaseInit = deferred();
    const store: Store = {
      name: "blocked-init",
      async init() {
        initStarted.resolve();
        await releaseInit.promise;
      },
      async read() {
        return emptyState();
      },
      async write() {},
    };
    const runtime = await createRuntime({ store });
    const initialization = runtime.init();
    await initStarted.promise;
    const stopping = runtime.stop();
    releaseInit.resolve();

    await expect(initialization).rejects.toThrow("stopped during initialization");
    await stopping;
  });
});
