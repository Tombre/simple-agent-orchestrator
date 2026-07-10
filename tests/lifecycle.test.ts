import { describe, expect, it } from "vitest";
import { createChannel, createClient, createEnvironment, cursorKey, memoryStore, type Store } from "../src/index.js";
import { createTestRuntime } from "../src/testing/index.js";
import { createRuntime, deferred } from "./helpers.js";

describe("resource lifecycle", () => {
  it("persists a created sandbox across handler retries and cleans it after session end", async () => {
    const channel = createChannel("sandbox");
    let creates = 0;
    let cleanups = 0;
    const seenResources: string[] = [];
    const environment = createEnvironment("workspace", (builder) => {
      builder.useSandbox({
        create({ session }) {
          creates += 1;
          session.set("workspaceId", `workspace-${creates}`);
        },
        cleanup({ session }) {
          cleanups += 1;
          seenResources.push(session.get<string>("workspaceId"));
        },
      });
    });
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, {
        retries: { attempts: 2 },
        handle({ attempt, session }) {
          seenResources.push(session.get<string>("workspaceId"));
          if (attempt === 1) throw new Error("retry");
          session.end({ reason: "done" });
        },
      });
    });
    const test = await createTestRuntime({ config: { channels: [channel], clients: [client] } });

    await test.dispatch("sandbox", { id: "event", sessionKey: "work" });

    expect(creates).toBe(1);
    expect(cleanups).toBe(1);
    expect(seenResources).toEqual(["workspace-1", "workspace-1", "workspace-1"]);
  });

  it("retries sandbox creation failures before constructing a handler context", async () => {
    const channel = createChannel("sandbox");
    let creates = 0;
    let handles = 0;
    let failures = 0;
    const environment = createEnvironment("workspace", (builder) => {
      builder.useSandbox({
        create() {
          creates += 1;
          if (creates === 1) throw new Error("creation uncertain");
        },
      });
    });
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, {
        retries: { attempts: 2 },
        handle() {
          handles += 1;
        },
        onFailure() {
          failures += 1;
        },
      });
    });
    const test = await createTestRuntime({ config: { channels: [channel], clients: [client] } });

    await test.dispatch("sandbox", { id: "event", sessionKey: "work" });

    expect(creates).toBe(2);
    expect(handles).toBe(1);
    expect(failures).toBe(0);
    expect((await test.events.list())[0]!.deliveries[0]).toMatchObject({ status: "processed", attempts: 2 });
  });

  it("retries the whole attempt when sandbox cleanup fails", async () => {
    const channel = createChannel("sandbox");
    let creates = 0;
    let cleanups = 0;
    const calls: string[] = [];
    const environment = createEnvironment("workspace", (builder) => {
      builder.useSandbox({
        create() {
          creates += 1;
        },
        cleanup() {
          cleanups += 1;
          if (cleanups === 1) throw new Error("cleanup uncertain");
        },
      });
    });
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, {
        retries: { attempts: 2 },
        handle({ attempt, session }) {
          calls.push(`handle:${attempt}`);
          session.end({ reason: "done" });
        },
        onSuccess({ attempt }) {
          calls.push(`success:${attempt}`);
        },
        onFailure({ attempt, error }) {
          calls.push(`failure:${attempt}:${error instanceof Error ? error.message : String(error)}`);
        },
      });
    });
    const test = await createTestRuntime({ config: { channels: [channel], clients: [client] } });

    await test.dispatch("sandbox", { id: "event", sessionKey: "work" });

    expect(creates).toBe(1);
    expect(cleanups).toBe(2);
    expect(calls).toEqual([
      "handle:1",
      "success:1",
      "failure:1:cleanup uncertain",
      "handle:2",
      "success:2",
    ]);
    expect(await test.sessions.get("work")).toMatchObject({ status: "ended" });
  });

  it("unmounts environments before one-shot drain startup resolves", async () => {
    const channel = createChannel("drain");
    const lifecycle: string[] = [];
    const environment = createEnvironment("service", (builder) => {
      builder.onMount(() => {
        lifecycle.push("mount");
      });
      builder.onUnmount(() => {
        lifecycle.push("unmount");
      });
    });
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, () => {
        lifecycle.push("handle");
      });
    });
    const runtime = await createRuntime({ channels: [channel], clients: [client] });
    await runtime.dispatch("drain", { id: "event" });

    await runtime.start({ drain: true, prettyStartupLog: false });

    expect(lifecycle).toEqual(["mount", "handle", "unmount"]);
  });

  it("does not overlap executions of the same poll", async () => {
    const firstFetch = deferred<unknown[]>();
    const secondStarted = deferred();
    let fetches = 0;
    let active = 0;
    let maxActive = 0;
    const channel = createChannel("poll", (builder) => {
      builder.poll({
        every: 5,
        async fetch() {
          fetches += 1;
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            if (fetches === 1) return await firstFetch.promise;
            secondStarted.resolve();
            return [];
          } finally {
            active -= 1;
          }
        },
      });
    });
    const runtime = await createRuntime({ channels: [channel] });

    await runtime.start({ prettyStartupLog: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetches).toBe(1);
    firstFetch.resolve([]);
    await secondStarted.promise;
    await runtime.stop();
    expect(fetches).toBeGreaterThanOrEqual(2);
    expect(maxActive).toBe(1);
  });

  it("commits a cursor after durable dispatch and provides it to the next poll", async () => {
    const seenPages: (number | undefined)[] = [];
    const store = memoryStore();
    const page = cursorKey<number>("page");
    let dispatchedBeforeCommit = false;
    let firstRuntime: Awaited<ReturnType<typeof createRuntime>>;
    const channel = createChannel("poll", (builder) => {
      builder.poll({
        every: "1h",
        fetch({ cursor }) {
          seenPages.push(cursor.get(page));
          return [{ id: `event-${seenPages.length}` }];
        },
        map(item) {
          return item;
        },
        async commit({ cursor }) {
          dispatchedBeforeCommit = (await firstRuntime.listEvents()).length === 1;
          cursor.set(page, (cursor.get(page) ?? 0) + 1);
        },
      });
    });
    firstRuntime = await createRuntime({ channels: [channel], store });
    await firstRuntime.start({ drain: true, prettyStartupLog: false });

    const secondChannel = createChannel("poll", (builder) => {
      builder.poll({
        every: "1h",
        fetch({ cursor }) {
          seenPages.push(cursor.get(page));
          return [];
        },
      });
    });
    const secondRuntime = await createRuntime({ channels: [secondChannel], store });
    await secondRuntime.start({ drain: true, prettyStartupLog: false });

    expect(seenPages).toEqual([undefined, 1]);
    expect(dispatchedBeforeCommit).toBe(true);
  });

  it("does not persist cursor changes when commit fails", async () => {
    const store = memoryStore();
    const page = cursorKey<number>("page");
    const failingChannel = createChannel("poll", (builder) => {
      builder.poll({
        every: "1h",
        fetch: () => [{ id: "event" }],
        map: (item) => item,
        commit({ cursor }) {
          cursor.set(page, 1);
          throw new Error("commit failed");
        },
      });
    });
    const firstRuntime = await createRuntime({ channels: [failingChannel], store });
    await firstRuntime.start({ drain: true, prettyStartupLog: false });

    let nextPage: number | undefined;
    const nextChannel = createChannel("poll", (builder) => {
      builder.poll({
        every: "1h",
        fetch({ cursor }) {
          nextPage = cursor.get(page);
          return [];
        },
      });
    });
    const secondRuntime = await createRuntime({ channels: [nextChannel], store });
    await secondRuntime.start({ drain: true, prettyStartupLog: false });

    expect(nextPage).toBeUndefined();
    expect(await secondRuntime.listEvents()).toHaveLength(1);
  });

  it("safely redelivers a polled item after commit failure when its dedupe key is stable", async () => {
    const store = memoryStore();
    const page = cursorKey<number>("page");
    let commits = 0;
    const channel = createChannel("poll", (builder) => {
      builder.poll({
        every: "1h",
        fetch: () => [{ id: "event", revision: 1 }],
        map: (item) => ({ id: item.id, dedupeKey: `${item.id}:${item.revision}` }),
        commit({ cursor }) {
          commits += 1;
          cursor.set(page, 1);
          if (commits === 1) throw new Error("commit failed");
        },
      });
    });

    const firstRuntime = await createRuntime({ channels: [channel], store });
    await firstRuntime.start({ drain: true, prettyStartupLog: false });
    const secondRuntime = await createRuntime({ channels: [channel], store });
    await secondRuntime.start({ drain: true, prettyStartupLog: false });

    expect(commits).toBe(2);
    expect(await secondRuntime.listEvents()).toHaveLength(1);
    const state = await store.read();
    expect(state.cursors["poll:0"]).toEqual({ page: 1 });
  });

  it("does not commit ordinary handler state when final success persistence fails", async () => {
    const backing = memoryStore();
    let failProcessedWrite = true;
    const store: Store = {
      name: "failure-injection",
      init: () => backing.init(),
      read: () => backing.read(),
      async write(state) {
        if (failProcessedWrite && state.deliveries.some(({ status }) => status === "processed")) {
          failProcessedWrite = false;
          throw new Error("write failed");
        }
        await backing.write(state);
      },
    };
    const channel = createChannel("sandbox");
    let creates = 0;
    let cleanups = 0;
    const ordinaryBeforeWrite: unknown[] = [];
    const environment = createEnvironment("workspace", (builder) => {
      builder.useSandbox({
        create({ session }) {
          creates += 1;
          session.set("workspaceId", `workspace-${creates}`);
        },
        cleanup() {
          cleanups += 1;
        },
      });
    });
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.retries({ attempts: 2 });
      builder.handle(channel, ({ attempt, session }) => {
        ordinaryBeforeWrite.push(session.getOptional("ordinary"));
        session.set("ordinary", attempt);
        session.end({ reason: "done" });
      });
    });
    const runtime = await createRuntime({ channels: [channel], clients: [client], store });

    await runtime.dispatch("sandbox", { id: "event", sessionKey: "work" });
    await runtime.drain();

    expect(ordinaryBeforeWrite).toEqual([undefined, undefined]);
    expect(creates).toBe(2);
    expect(cleanups).toBe(2);
    expect(await runtime.getSession("work")).toMatchObject({
      status: "ended",
      state: { workspaceId: "workspace-2", ordinary: 2 },
    });
    expect((await runtime.listEvents())[0]!.deliveries[0]).toMatchObject({ status: "processed", attempts: 2 });
    await runtime.stop();
  });

  it("mounts one environment instance across concurrent drains", async () => {
    const mountStarted = deferred();
    const releaseMount = deferred();
    let mounts = 0;
    let unmounts = 0;
    const channel = createChannel("environment");
    const environment = createEnvironment("shared", (builder) => {
      builder.onMount(async () => {
        mounts += 1;
        mountStarted.resolve();
        await releaseMount.promise;
      });
      builder.onUnmount(() => {
        unmounts += 1;
      });
    });
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, () => {});
    });
    const runtime = await createRuntime({ channels: [channel], clients: [client] });
    await runtime.dispatch("environment", { id: "event" });

    const firstDrain = runtime.drain();
    await mountStarted.promise;
    const secondDrain = runtime.drain();
    releaseMount.resolve();
    await Promise.all([firstDrain, secondDrain]);
    await runtime.stop();

    expect(mounts).toBe(1);
    expect(unmounts).toBe(1);
  });
});
