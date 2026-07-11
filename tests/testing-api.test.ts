import { describe, expect, it, vi } from "vitest";
import { createChannel, createClient } from "../src/index.js";
import { createProjectContext } from "../src/runtime/index.js";
import { createTestRuntime, memoryStore, type TestRuntimeOptions } from "../src/testing/index.js";

describe("testing API", () => {
  it("resolves sync and async config factories with the selected project", async () => {
    const project = await createProjectContext(process.cwd());
    const sync = vi.fn(({ project: context }) => {
      expect(context).toBe(project);
      return {};
    });
    const asyncFactory = vi.fn(async ({ project: context }) => {
      expect(context.root).toBe(project.root);
      return {};
    });

    const first = await createTestRuntime(sync, { project });
    const second = await createTestRuntime(asyncFactory, { root: project.root });

    expect(first.project).toBe(project);
    expect(second.project.root).toBe(project.root);
    await first.stop();
    await second.stop();
  });

  it("uses isolated defaults and only accepts store, logger, and HTTP overrides from test options", async () => {
    const configuredStore = memoryStore();
    const explicitStore = memoryStore();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const defaulted = await createTestRuntime({ store: configuredStore, http: { enabled: true } });
    const overridden = await createTestRuntime(
      { store: configuredStore, http: { enabled: false } },
      { store: explicitStore, logger, http: { enabled: true, port: 4321 } },
    );

    expect(defaulted.store).not.toBe(configuredStore);
    expect((await defaulted.runtime.printConfig()).http).toMatchObject({ enabled: false });
    expect(overridden.store).toBe(explicitStore);
    expect((await overridden.runtime.printConfig()).http).toMatchObject({ enabled: true, port: 4321 });
    await defaulted.stop();
    await overridden.stop();
  });

  it("supports controlled dispatch, inspection, and delivery retry", async () => {
    const channel = createChannel("testing");
    let shouldFail = true;
    const client = createClient("client", (builder) => {
      builder.retries({ attempts: 1 });
      builder.handle(channel, () => {
        if (shouldFail) throw new Error("not yet");
      });
    });
    const test = await createTestRuntime({ channels: [channel], clients: [client] });

    const dispatched = await test.dispatch(channel, { id: "event", sessionKey: "work" }, { drain: false });
    expect(await test.events.get(dispatched.eventId)).toMatchObject({
      event: { sourceId: "event" },
      deliveries: [{ status: "pending", attempts: 0 }],
    });
    expect((await test.deliveries.list())[0]).toMatchObject({ status: "pending", attempts: 0 });

    await test.drain();
    const failed = (await test.deliveries.list())[0]!;
    expect(await test.deliveries.get(failed.id)).toMatchObject({ status: "failed", attempts: 1 });

    shouldFail = false;
    expect(await test.deliveries.retry(failed.id, { drain: false })).toBe(true);
    expect(await test.deliveries.get(failed.id)).toMatchObject({ status: "pending" });
    await test.drain();
    expect(await test.deliveries.get(failed.id)).toMatchObject({ status: "processed", attempts: 2 });
    expect(await test.sessions.get("work")).toBeDefined();
    expect(await test.sessions.notes("work")).toEqual([]);
    expect((await test.readState()).events).toHaveLength(1);
    await test.stop();
  });

  it("rejects mutations but permits inspection after stop", async () => {
    const channel = createChannel("stopped");
    const test = await createTestRuntime({ channels: [channel] });
    await test.dispatch(channel, { id: "event" }, { drain: false });
    await test.stop();

    expect(await test.events.list()).toMatchObject([{ event: { sourceId: "event" }, deliveries: [] }]);
    expect(await test.readState()).toMatchObject({ deliveries: [] });
    await expect(test.dispatch(channel, { id: "later" })).rejects.toThrow("stopped");
    await expect(test.drain()).rejects.toThrow("stopped");
    await expect(test.deliveries.retry("missing")).rejects.toThrow("stopped");
  });

  it("rejects root and project together at runtime and in its option type", async () => {
    const project = await createProjectContext(process.cwd());
    // @ts-expect-error root and project are mutually exclusive
    const invalidOptions: TestRuntimeOptions = { root: project.root, project };

    await expect(createTestRuntime({}, invalidOptions)).rejects.toThrow("both root and project");
  });
});
