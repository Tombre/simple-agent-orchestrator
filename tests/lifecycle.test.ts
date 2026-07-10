import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createChannel,
  createClient,
  createEnvironment,
  cursorKey,
  jsonFileStore,
  type Logger,
  memoryStore,
  type Store,
} from "../src/index.js";
import { createTestRuntime } from "../src/testing/index.js";
import { emptyState } from "../src/stores/store.js";
import { createRuntime, deferred, waitFor } from "./helpers.js";

type OwnerMessage = { type: "ready"; pid: number } | { type: "error"; message: string };

function failNextOwnershipRelease(runtime: Awaited<ReturnType<typeof createRuntime>>): () => number {
  const internal = runtime as unknown as {
    ownership: { release(): Promise<void> };
  };
  const acquiredOwnership = internal.ownership;
  let releases = 0;
  internal.ownership = {
    async release() {
      releases += 1;
      if (releases === 1) throw new Error("transient release failure");
      await acquiredOwnership.release();
    },
  };
  return () => releases;
}

function launchOwner(statePath: string, root: string): { child: ChildProcess; stderr: string[] } {
  const stderr: string[] = [];
  const child = fork(fileURLToPath(new URL("./fixtures/runtime-owner.ts", import.meta.url)), [statePath, root], {
    execArgv: ["--import", "tsx"],
    silent: true,
  });
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
  return { child, stderr };
}

function waitForOwnerMessage(owner: { child: ChildProcess; stderr: string[] }, timeoutMs = 5_000): Promise<OwnerMessage> {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for owner process: ${owner.stderr.join("")}`));
    }, timeoutMs);
    const onMessage = (message: OwnerMessage) => {
      cleanup();
      resolveMessage(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Owner process exited with code ${String(code)}: ${owner.stderr.join("")}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      owner.child.off("message", onMessage);
      owner.child.off("error", onError);
      owner.child.off("exit", onExit);
    };
    owner.child.once("message", onMessage);
    owner.child.once("error", onError);
    owner.child.once("exit", onExit);
  });
}

async function waitForChildExit(owner: { child: ChildProcess; stderr: string[] }, timeoutMs = 5_000): Promise<void> {
  if (owner.child.exitCode !== null || owner.child.signalCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for owner process exit: ${owner.stderr.join("")}`));
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolveExit();
    };
    const cleanup = () => {
      clearTimeout(timer);
      owner.child.off("exit", onExit);
    };
    owner.child.once("exit", onExit);
  });
}

describe("resource lifecycle", () => {
  it("rejects a second active runtime for the same JSON state and releases ownership on stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-ownership-"));
    const statePath = join(root, "state.json");
    const first = await createRuntime({ store: jsonFileStore(statePath) });
    const second = await createRuntime({ store: jsonFileStore(statePath) });

    await first.start({ prettyStartupLog: false });
    await expect(second.start({ prettyStartupLog: false })).rejects.toThrow(
      new RegExp(`another active orchestrator runtime.*PID ${process.pid}.*stop it`, "i"),
    );

    await first.stop();
    const replacement = await createRuntime({ store: jsonFileStore(statePath) });
    await replacement.start({ prettyStartupLog: false });
    await replacement.stop();
  });

  it("enforces ownership across processes and serializes stale-lock recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-ownership-process-"));
    const statePath = join(root, "state.json");
    const children: { child: ChildProcess; stderr: string[] }[] = [];
    const launch = () => {
      const child = launchOwner(statePath, root);
      children.push(child);
      return child;
    };

    try {
      const owner = launch();
      const ownerMessage = await waitForOwnerMessage(owner);
      expect(ownerMessage).toMatchObject({ type: "ready", pid: owner.child.pid });

      const contender = launch();
      const contenderMessage = await waitForOwnerMessage(contender);
      expect(contenderMessage).toMatchObject({ type: "error" });
      if (contenderMessage.type === "error") {
        expect(contenderMessage.message).toMatch(new RegExp(`PID ${String(owner.child.pid)}.*started.*Stop it`, "i"));
      }
      await waitForChildExit(contender);

      owner.child.kill("SIGKILL");
      await waitForChildExit(owner);

      const staleLock = await readFile(`${statePath}.runtime-lock`, "utf8");
      const staleGeneration = createHash("sha256").update(staleLock).digest("hex").slice(0, 24);
      await writeFile(
        `${statePath}.runtime-lock.recovery.${staleGeneration}`,
        JSON.stringify({ pid: 2_147_483_647, startedAt: "2025-01-01T00:00:00.000Z", token: "dead-recovery" }),
        "utf8",
      );

      const replacements = [launch(), launch()];
      const replacementMessages = await Promise.all(replacements.map((replacement) => waitForOwnerMessage(replacement)));
      expect(replacementMessages.filter(({ type }) => type === "ready")).toHaveLength(1);
      expect(replacementMessages.filter(({ type }) => type === "error")).toHaveLength(1);

      const winnerIndex = replacementMessages.findIndex(({ type }) => type === "ready");
      const loserIndex = winnerIndex === 0 ? 1 : 0;
      await waitForChildExit(replacements[loserIndex]!);
      replacements[winnerIndex]!.child.send("stop");
      await waitForChildExit(replacements[winnerIndex]!);
      await expect(readFile(`${statePath}.runtime-lock`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      for (const child of children) {
        if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill("SIGKILL");
      }
      await Promise.all(children.map((child) => waitForChildExit(child).catch(() => undefined)));
    }
  });

  it("recovers JSON state ownership left by a dead runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-ownership-"));
    const statePath = join(root, "state.json");
    const lockPath = `${statePath}.runtime-lock`;
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 2_147_483_647, startedAt: "2025-01-01T00:00:00.000Z", token: "stale" }),
      "utf8",
    );
    const orphanCandidate = `${lockPath}.2147483647.stale.candidate`;
    await writeFile(orphanCandidate, "orphan", "utf8");
    const runtime = await createRuntime({ store: jsonFileStore(statePath) });

    await runtime.start({ prettyStartupLog: false });
    await runtime.stop();

    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(orphanCandidate, "utf8")).toBe("orphan");
  });

  it("recovers a delivery interrupted after its durable claim on JSON-store restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-crash-recovery-"));
    const statePath = join(root, "state.json");
    const backing = jsonFileStore(statePath);
    let interruptClaim = true;
    const interruptedStore: Store = {
      name: "interrupted-json-claim",
      runtimeLockPath: backing.runtimeLockPath!,
      init: () => backing.init(),
      read: () => backing.read(),
      async write(state) {
        await backing.write(state);
        if (interruptClaim && state.deliveries.some(({ status }) => status === "processing")) {
          interruptClaim = false;
          throw new Error("process exited after claim persistence");
        }
      },
    };
    const channel = createChannel("recovery");
    const attempts: number[] = [];
    const client = createClient("client", (builder) => {
      builder.retries({ attempts: 1, delay: "1h" });
      builder.handle(channel, ({ attempt }) => {
        attempts.push(attempt);
      });
    });
    const interruptedRuntime = await createRuntime({ channels: [channel], clients: [client], store: interruptedStore });
    await interruptedRuntime.dispatch("recovery", { id: "event" });

    await expect(interruptedRuntime.drain()).rejects.toThrow("process exited after claim persistence");
    expect((await backing.read()).deliveries[0]).toMatchObject({
      status: "processing",
      attempts: 1,
      maxAttempts: 1,
      retryDelayMs: 3_600_000,
    });
    await interruptedRuntime.stop();

    const warnings: { message: string; data?: Record<string, unknown> | undefined }[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn(message, data) {
        warnings.push({ message, data });
      },
      error() {},
    };
    const replacement = await createRuntime({ channels: [channel], clients: [client], store: backing, logger });
    await replacement.start({ prettyStartupLog: false });
    await waitFor(async () => {
      expect((await replacement.listEvents())[0]!.deliveries[0]?.status).toBe("processed");
    });
    await replacement.stop();

    expect(attempts).toEqual([2]);
    const recoveredDelivery = (await replacement.listEvents())[0]!.deliveries[0]!;
    expect(recoveredDelivery).toMatchObject({
      status: "processed",
      attempts: 2,
      maxAttempts: 2,
      retryDelayMs: 3_600_000,
    });
    expect(recoveredDelivery).not.toHaveProperty("nextAttemptAt");
    expect(recoveredDelivery.lastError).toBeUndefined();
    expect(warnings).toEqual([
      {
        message: "Recovered interrupted deliveries",
        data: {
          count: 1,
          deliveries: [{ id: expect.any(String), interruptedAttempt: 1 }],
        },
      },
    ]);
  });

  it("repeats uncertain handler work and continues ordinary retries after recovery", async () => {
    const backing = memoryStore();
    let failAttemptCompletion = true;
    const interruptedStore: Store = {
      name: "interrupted-attempt",
      init: () => backing.init(),
      read: () => backing.read(),
      async write(state) {
        const delivery = state.deliveries[0];
        if (
          failAttemptCompletion &&
          delivery?.attempts === 1 &&
          (delivery.status === "processed" || delivery.status === "pending" || delivery.status === "failed")
        ) {
          throw new Error("process exited before attempt completion persistence");
        }
        await backing.write(state);
      },
    };
    const channel = createChannel("recovery");
    const effects: { attempt: number; key: string }[] = [];
    const client = createClient("client", (builder) => {
      builder.retries({ attempts: 3 });
      builder.handle(channel, ({ attempt, event, session }) => {
        effects.push({ attempt, key: `effect:${event.channelId}:${event.dedupeKey}` });
        session.set("committedAttempt", attempt);
        if (attempt === 2) throw new Error("ordinary retry after recovery");
      });
    });
    const interruptedRuntime = await createRuntime({ channels: [channel], clients: [client], store: interruptedStore });
    await interruptedRuntime.dispatch("recovery", { id: "event", sessionKey: "work" });

    await expect(interruptedRuntime.drain()).rejects.toThrow("process exited before attempt completion persistence");
    expect((await backing.read()).deliveries[0]).toMatchObject({ status: "processing", attempts: 1, maxAttempts: 3 });
    failAttemptCompletion = false;

    await interruptedRuntime.drain();
    await interruptedRuntime.stop();

    expect(effects).toEqual([
      { attempt: 1, key: "effect:recovery:event" },
      { attempt: 2, key: "effect:recovery:event" },
      { attempt: 3, key: "effect:recovery:event" },
    ]);
    expect(await interruptedRuntime.getSession("work")).toMatchObject({ state: { committedAttempt: 3 } });
    expect((await interruptedRuntime.listEvents())[0]!.deliveries[0]).toMatchObject({
      status: "processed",
      attempts: 3,
      maxAttempts: 3,
    });
  });

  it("preserves delayed retry eligibility across runtime restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-retry-delay-"));
    const statePath = join(root, "state.json");
    const channel = createChannel("retry");
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
    const first = await createRuntime({ channels: [channel], clients: [client], store: jsonFileStore(statePath) });
    await first.dispatch("retry", { id: "event" });
    await first.drain();
    await first.stop();

    const delayed = (await jsonFileStore(statePath).read()).deliveries[0]!;
    expect(delayed).toMatchObject({ status: "pending", attempts: 1, retryDelayMs: 3_600_000 });
    expect(Date.parse(delayed.nextAttemptAt!)).toBeGreaterThan(Date.now());

    const secondStore = jsonFileStore(statePath);
    const second = await createRuntime({ channels: [channel], clients: [client], store: secondStore });
    await second.drain();
    expect(attempts).toEqual([1]);

    const dueState = await secondStore.read();
    dueState.deliveries[0]!.nextAttemptAt = new Date(0).toISOString();
    await secondStore.write(dueState);
    await second.drain();
    await second.stop();

    expect(attempts).toEqual([1, 2]);
    const processed = (await jsonFileStore(statePath).read()).deliveries[0]!;
    expect(processed).toMatchObject({
      status: "processed",
      attempts: 2,
    });
    expect(processed).not.toHaveProperty("nextAttemptAt");
  });

  it("recovers through an offline drain and exposes the interrupted attempt while processing", async () => {
    const store = memoryStore();
    const channel = createChannel("recovery");
    let observedLastError: string | undefined;
    let runtime: Awaited<ReturnType<typeof createRuntime>>;
    const client = createClient("client", (builder) => {
      builder.handle(channel, async () => {
        observedLastError = (await runtime.listEvents())[0]!.deliveries[0]!.lastError;
      });
    });
    runtime = await createRuntime({ channels: [channel], clients: [client], store });
    await runtime.dispatch("recovery", { id: "event" });
    const interruptedState = await store.read();
    interruptedState.deliveries[0]!.status = "processing";
    interruptedState.deliveries[0]!.attempts = 1;
    await store.write(interruptedState);

    await runtime.runOffline(async ({ drain }) => drain());

    expect(observedLastError).toBe(
      "Interrupted during attempt 1; recovered before processing resumed. Handler and external effects may run again.",
    );
    expect((await runtime.listEvents())[0]!.deliveries[0]).toMatchObject({ status: "processed", attempts: 2 });
  });

  it("retries recovery persistence on a later drain", async () => {
    const backing = memoryStore();
    let failRecoveryWrite = true;
    const store: Store = {
      name: "recovery-write-failure",
      init: () => backing.init(),
      read: () => backing.read(),
      async write(state) {
        const delivery = state.deliveries[0];
        if (failRecoveryWrite && delivery?.status === "pending" && delivery.lastError?.startsWith("Interrupted during")) {
          failRecoveryWrite = false;
          throw new Error("recovery write failed");
        }
        await backing.write(state);
      },
    };
    const channel = createChannel("recovery");
    const attempts: number[] = [];
    const client = createClient("client", (builder) => {
      builder.handle(channel, ({ attempt }) => {
        attempts.push(attempt);
      });
    });
    const runtime = await createRuntime({ channels: [channel], clients: [client], store });
    await runtime.dispatch("recovery", { id: "event" });
    const interruptedState = await backing.read();
    interruptedState.deliveries[0]!.status = "processing";
    interruptedState.deliveries[0]!.attempts = 1;
    await backing.write(interruptedState);

    await expect(runtime.drain()).rejects.toThrow("recovery write failed");
    expect((await backing.read()).deliveries[0]).toMatchObject({ status: "processing", attempts: 1 });

    await runtime.drain();
    await runtime.stop();

    expect(attempts).toEqual([2]);
    expect((await runtime.listEvents())[0]!.deliveries[0]).toMatchObject({ status: "processed", attempts: 2 });
  });

  it("releases per-session serialization when a durable claim write rejects", async () => {
    const backing = memoryStore();
    let interruptClaim = true;
    const store: Store = {
      name: "interrupted-per-session-claim",
      init: () => backing.init(),
      read: () => backing.read(),
      async write(state) {
        await backing.write(state);
        if (interruptClaim && state.deliveries.some(({ status }) => status === "processing")) {
          interruptClaim = false;
          throw new Error("process exited after claim persistence");
        }
      },
    };
    const channel = createChannel("recovery");
    const attempts: number[] = [];
    const client = createClient("client", (builder) => {
      builder.concurrency({ perSession: true });
      builder.handle(channel, ({ attempt }) => {
        attempts.push(attempt);
      });
    });
    const runtime = await createRuntime({ channels: [channel], clients: [client], store });
    await runtime.dispatch("recovery", { id: "event", sessionKey: "work" });

    await expect(runtime.drain()).rejects.toThrow("process exited after claim persistence");
    expect((await backing.read()).deliveries[0]).toMatchObject({ status: "processing", attempts: 1 });

    await runtime.drain();
    await runtime.stop();

    expect(attempts).toEqual([2]);
    expect((await runtime.listEvents())[0]!.deliveries[0]).toMatchObject({ status: "processed", attempts: 2 });
  });

  it("ignores orphan ownership sidecars when no active lock exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-ownership-"));
    const statePath = join(root, "state.json");
    const lockPath = `${statePath}.runtime-lock`;
    await writeFile(`${lockPath}.123.orphan.candidate`, "orphan", "utf8");
    await writeFile(
      `${lockPath}.recovery.orphan`,
      JSON.stringify({ pid: 2_147_483_647, startedAt: "2025-01-01T00:00:00.000Z", token: "orphan" }),
      "utf8",
    );
    const runtime = await createRuntime({ store: jsonFileStore(statePath) });

    await runtime.start({ prettyStartupLog: false });
    await runtime.stop();

    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers malformed JSON state ownership records", async () => {
    const invalidRecords = [
      "incomplete",
      "null",
      JSON.stringify({ pid: 0, startedAt: "2025-01-01T00:00:00.000Z", token: "invalid" }),
      JSON.stringify({ pid: -1, startedAt: "2025-01-01T00:00:00.000Z", token: "invalid" }),
      JSON.stringify({ pid: 1.5, startedAt: "2025-01-01T00:00:00.000Z", token: "invalid" }),
      JSON.stringify({ pid: 0x80000000, startedAt: "2025-01-01T00:00:00.000Z", token: "invalid" }),
    ];

    for (const record of invalidRecords) {
      const root = await mkdtemp(join(tmpdir(), "sao-ownership-"));
      const statePath = join(root, "state.json");
      const lockPath = `${statePath}.runtime-lock`;
      await writeFile(lockPath, record, "utf8");
      const runtime = await createRuntime({ store: jsonFileStore(statePath) });

      await runtime.start({ drain: true, prettyStartupLog: false });

      await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("holds JSON state ownership after a direct drain until stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-ownership-"));
    const statePath = join(root, "state.json");
    const first = await createRuntime({ store: jsonFileStore(statePath) });
    const second = await createRuntime({ store: jsonFileStore(statePath) });

    await first.drain();
    await expect(second.drain()).rejects.toThrow(/another active orchestrator runtime/i);
    await first.stop();

    const replacement = await createRuntime({ store: jsonFileStore(statePath) });
    await replacement.drain();
    await replacement.stop();
  });

  it("releases JSON state ownership after an offline operation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-ownership-"));
    const statePath = join(root, "state.json");
    const runtime = await createRuntime({ store: jsonFileStore(statePath) });

    await expect(
      runtime.runOffline(async () => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");

    const replacement = await createRuntime({ store: jsonFileStore(statePath) });
    await replacement.start({ prettyStartupLog: false });
    await replacement.stop();
  });

  it("does not release ownership early for overlapping offline operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-ownership-"));
    const statePath = join(root, "state.json");
    const runtime = await createRuntime({ store: jsonFileStore(statePath) });
    const started = deferred();
    const release = deferred();
    const operation = runtime.runOffline(async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;

    await expect(runtime.runOffline(async () => undefined)).rejects.toThrow("already active");
    await expect(runtime.start({ prettyStartupLog: false })).rejects.toThrow("active offline operation");
    await expect(runtime.drain()).rejects.toThrow("active offline operation");
    await expect(runtime.stop()).rejects.toThrow("active offline operation");
    const contender = await createRuntime({ store: jsonFileStore(statePath) });
    await expect(contender.drain()).rejects.toThrow(/another active orchestrator runtime/i);

    release.resolve();
    await operation;
    await expect(runtime.runOffline(async () => undefined)).rejects.toThrow("unused one-shot runtime");
    const replacement = await createRuntime({ store: jsonFileStore(statePath) });
    await replacement.start({ prettyStartupLog: false });
    await replacement.stop();
  });

  it("rejects offline operations after a runtime lifecycle has claimed ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-ownership-"));
    const statePath = join(root, "state.json");
    const started = await createRuntime({ store: jsonFileStore(statePath) });
    await started.start({ prettyStartupLog: false });
    await expect(started.runOffline(async () => undefined)).rejects.toThrow("unused one-shot runtime");
    await started.stop();

    const drained = await createRuntime({ store: jsonFileStore(statePath) });
    await drained.drain();
    await expect(drained.runOffline(async () => undefined)).rejects.toThrow("unused one-shot runtime");
    await drained.stop();
  });

  it("preserves falsy offline operation errors and combines shutdown failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-ownership-"));
    const statePath = join(root, "state.json");
    const runtime = await createRuntime({ store: jsonFileStore(statePath) });

    const error = await runtime
      .runOffline(async () => {
        failNextOwnershipRelease(runtime);
        throw undefined;
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([undefined, new Error("transient release failure")]);
    await runtime.stop();
  });

  it("preserves falsy cleanup errors during startup shutdown", async () => {
    const environment = createEnvironment("failure", (builder) => {
      builder.onMount(() => {
        throw new Error("mount failed");
      });
      builder.onUnmount(() => {
        throw undefined;
      });
    });
    const client = createClient("client", (builder) => builder.useEnvironment(environment));
    const runtime = await createRuntime({ clients: [client] });

    const error = await runtime.start({ prettyStartupLog: false }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([new Error("mount failed"), undefined]);
  });

  it("rejects overlapping offline drains and permits sequential drains", async () => {
    const mountStarted = deferred();
    const releaseMount = deferred();
    let mounts = 0;
    const environment = createEnvironment("service", (builder) => {
      builder.onMount(async () => {
        mounts += 1;
        mountStarted.resolve();
        await releaseMount.promise;
      });
    });
    const client = createClient("client", (builder) => builder.useEnvironment(environment));
    const runtime = await createRuntime({ clients: [client] });

    await runtime.runOffline(async ({ drain }) => {
      const firstDrain = drain();
      await mountStarted.promise;
      await expect(drain()).rejects.toThrow("another drain is in progress");
      releaseMount.resolve();
      await firstDrain;
      await drain();
    });

    expect(mounts).toBe(1);
  });

  it("releases JSON state ownership when environment unmounting fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-ownership-"));
    const statePath = join(root, "state.json");
    const environment = createEnvironment("failure", (builder) => {
      builder.onUnmount(() => {
        throw new Error("unmount failed");
      });
    });
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
    });
    const runtime = await createRuntime({ clients: [client], store: jsonFileStore(statePath) });
    await runtime.start({ prettyStartupLog: false });

    await expect(runtime.stop()).rejects.toThrow("unmount failed");

    const replacement = await createRuntime({ store: jsonFileStore(statePath) });
    await replacement.start({ prettyStartupLog: false });
    await replacement.stop();
  });

  it("retries JSON state ownership release after a transient failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-ownership-"));
    const statePath = join(root, "state.json");
    const runtime = await createRuntime({ store: jsonFileStore(statePath) });
    await runtime.start({ prettyStartupLog: false });
    const releaseCount = failNextOwnershipRelease(runtime);

    await expect(runtime.stop()).rejects.toThrow("transient release failure");
    await runtime.stop();

    expect(releaseCount()).toBe(2);
    const replacement = await createRuntime({ store: jsonFileStore(statePath) });
    await replacement.start({ prettyStartupLog: false });
    await replacement.stop();
  });

  it("preserves startup and ownership release errors together", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-ownership-"));
    const statePath = join(root, "state.json");
    let runtime: Awaited<ReturnType<typeof createRuntime>>;
    const environment = createEnvironment("failure", (builder) => {
      builder.onMount(() => {
        failNextOwnershipRelease(runtime);
        throw new Error("mount failed");
      });
    });
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
    });
    runtime = await createRuntime({ clients: [client], store: jsonFileStore(statePath) });

    const error = await runtime.start({ prettyStartupLog: false }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map(String)).toEqual([
      "Error: mount failed",
      "Error: transient release failure",
    ]);
    await runtime.stop();

    const replacement = await createRuntime({ store: jsonFileStore(statePath) });
    await replacement.start({ prettyStartupLog: false });
    await replacement.stop();
  });

  it("preserves shutdown and ownership release errors together", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-ownership-"));
    const statePath = join(root, "state.json");
    const environment = createEnvironment("failure", (builder) => {
      builder.onUnmount(() => {
        throw new Error("unmount failed");
      });
    });
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
    });
    const runtime = await createRuntime({ clients: [client], store: jsonFileStore(statePath) });
    await runtime.start({ prettyStartupLog: false });
    failNextOwnershipRelease(runtime);

    const error = await runtime.stop().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map(String)).toEqual([
      "Error: unmount failed",
      "Error: transient release failure",
    ]);
    await expect(runtime.stop()).rejects.toThrow("unmount failed");

    const replacement = await createRuntime({ store: jsonFileStore(statePath) });
    await replacement.start({ prettyStartupLog: false });
    await replacement.stop();
  });

  it("releases JSON state ownership after startup failures", async () => {
    const assertReplacementStarts = async (statePath: string) => {
      const replacement = await createRuntime({ store: jsonFileStore(statePath) });
      await replacement.start({ prettyStartupLog: false });
      await replacement.stop();
    };

    const invalidRoot = await mkdtemp(join(tmpdir(), "sao-ownership-"));
    const invalidStatePath = join(invalidRoot, "state.json");
    const duplicate = createChannel("duplicate");
    const invalidRuntime = await createRuntime({
      channels: [duplicate, duplicate],
      store: jsonFileStore(invalidStatePath),
    });
    await expect(invalidRuntime.start({ prettyStartupLog: false })).rejects.toThrow("Duplicate channel id");
    await assertReplacementStarts(invalidStatePath);

    const mountRoot = await mkdtemp(join(tmpdir(), "sao-ownership-"));
    const mountStatePath = join(mountRoot, "state.json");
    const failingEnvironment = createEnvironment("failure", (builder) => {
      builder.onMount(() => {
        throw new Error("mount failed");
      });
    });
    const failingClient = createClient("client", (builder) => {
      builder.useEnvironment(failingEnvironment);
    });
    const mountRuntime = await createRuntime({
      clients: [failingClient],
      store: jsonFileStore(mountStatePath),
    });
    await expect(mountRuntime.start({ prettyStartupLog: false })).rejects.toThrow("mount failed");
    await assertReplacementStarts(mountStatePath);

    const initRoot = await mkdtemp(join(tmpdir(), "sao-ownership-"));
    const initStatePath = join(initRoot, "state.json");
    const backing = memoryStore();
    const failingStore: Store = {
      name: "failing-init",
      runtimeLockPath: `${initStatePath}.runtime-lock`,
      async init() {
        throw new Error("init failed");
      },
      read: () => backing.read(),
      write: (state) => backing.write(state),
    };
    const initRuntime = await createRuntime({ store: failingStore });
    await expect(initRuntime.start({ prettyStartupLog: false })).rejects.toThrow("init failed");
    await assertReplacementStarts(initStatePath);
  });

  it("rejects invalid persisted state before polling or mounting and releases ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-state-validation-"));
    const statePath = join(root, "state.json");
    const invalid = JSON.stringify({
      ...emptyState(),
      events: [{
        id: "event",
        channelId: "source",
        sourceId: "source",
        dedupeKey: "source:source",
        sessionKey: "session",
        receivedAt: "now",
      }],
      deliveries: [{
        id: "delivery",
        eventId: "event",
        channelId: "source",
        clientId: "client",
        handlerId: "source:0",
        status: "pending",
        attempts: 1,
        maxAttempts: 1,
        retryDelayMs: 0,
        createdAt: "now",
        updatedAt: "now",
      }],
    });
    await writeFile(statePath, invalid, "utf8");
    let polled = false;
    let mounted = false;
    const channel = createChannel("source", (builder) => {
      builder.poll({
        every: "1m",
        fetch() {
          polled = true;
          return [];
        },
      });
    });
    const environment = createEnvironment("service", (builder) => {
      builder.onMount(() => {
        mounted = true;
      });
    });
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
    });
    const runtime = await createRuntime({
      channels: [channel],
      clients: [client],
      store: jsonFileStore(statePath),
    });

    await expect(runtime.start({ drain: true, prettyStartupLog: false })).rejects.toThrow(
      "has no retry attempts remaining",
    );
    expect(polled).toBe(false);
    expect(mounted).toBe(false);
    expect(await readFile(statePath, "utf8")).toBe(invalid);

    await writeFile(statePath, JSON.stringify(emptyState()), "utf8");
    const replacement = await createRuntime({ store: jsonFileStore(statePath) });
    await replacement.start({ prettyStartupLog: false });
    await replacement.stop();
  });

  it("rejects duplicate and conflicting lifecycle operations", async () => {
    const mountStarted = deferred();
    const releaseMount = deferred();
    const environment = createEnvironment("service", (builder) => {
      builder.onMount(async () => {
        mountStarted.resolve();
        await releaseMount.promise;
      });
    });
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
    });
    const runtime = await createRuntime({ clients: [client] });

    const startup = runtime.start({ prettyStartupLog: false });
    await mountStarted.promise;
    await expect(runtime.start({ prettyStartupLog: false })).rejects.toThrow("runtime is starting");
    await expect(runtime.drain()).rejects.toThrow("start() has already claimed");
    await expect(runtime.stop()).rejects.toThrow("runtime is starting");

    releaseMount.resolve();
    await startup;
    await expect(runtime.start({ prettyStartupLog: false })).rejects.toThrow("start() has already been called");
    await expect(runtime.drain()).rejects.toThrow("start() has already claimed");
    await runtime.stop();
    await expect(runtime.start({ prettyStartupLog: false })).rejects.toThrow("runtime has been stopped");
    await expect(runtime.drain()).rejects.toThrow("runtime has been stopped");
  });

  it("unwinds mounted environments in reverse order when startup fails", async () => {
    const lifecycle: string[] = [];
    const createLifecycleClient = (id: string, fail = false) => {
      const environment = createEnvironment(`environment-${id}`, (builder) => {
        builder.onMount(() => {
          lifecycle.push(`mount:${id}`);
          if (fail) throw new Error("mount failed");
        });
        builder.onUnmount(({ signal }) => {
          lifecycle.push(`unmount:${id}:${String(signal.aborted)}`);
        });
      });
      return createClient(`client-${id}`, (builder) => {
        builder.useEnvironment(environment);
      });
    };
    const runtime = await createRuntime({
      clients: [createLifecycleClient("first"), createLifecycleClient("second"), createLifecycleClient("failure", true)],
    });

    await expect(runtime.start({ prettyStartupLog: false })).rejects.toThrow("mount failed");

    expect(lifecycle).toEqual([
      "mount:first",
      "mount:second",
      "mount:failure",
      "unmount:failure:false",
      "unmount:second:true",
      "unmount:first:true",
    ]);
    await expect(runtime.start({ prettyStartupLog: false })).rejects.toThrow("runtime has been stopped");
    await runtime.stop();
    expect(lifecycle).toHaveLength(6);
  });

  it("rejects invalid poll intervals before mounting startup resources", async () => {
    let mounts = 0;
    const channel = createChannel("poll", (builder) => {
      builder.poll({ every: "invalid", fetch: () => [] });
    });
    const environment = createEnvironment("service", (builder) => {
      builder.onMount(() => {
        mounts += 1;
      });
    });
    const client = createClient("client", (builder) => builder.useEnvironment(environment));
    const runtime = await createRuntime({ channels: [channel], clients: [client] });

    await expect(runtime.start({ prettyStartupLog: false })).rejects.toThrow("Invalid duration string");

    expect(mounts).toBe(0);
    await runtime.stop();
  });

  it("coordinates concurrent stops and continues reverse-order cleanup after failures", async () => {
    const unmountStarted = deferred();
    const releaseUnmount = deferred();
    const lifecycle: string[] = [];
    const firstEnvironment = createEnvironment("first", (builder) => {
      builder.onUnmount(() => {
        lifecycle.push("first");
      });
    });
    const secondEnvironment = createEnvironment("second", (builder) => {
      builder.onUnmount(async () => {
        lifecycle.push("second:early");
        unmountStarted.resolve();
        await releaseUnmount.promise;
      });
      builder.onUnmount(() => {
        lifecycle.push("second:late");
        throw new Error("unmount failed");
      });
    });
    const firstClient = createClient("first", (builder) => builder.useEnvironment(firstEnvironment));
    const secondClient = createClient("second", (builder) => builder.useEnvironment(secondEnvironment));
    const runtime = await createRuntime({ clients: [firstClient, secondClient] });
    await runtime.start({ prettyStartupLog: false });

    const firstStop = runtime.stop();
    await unmountStarted.promise;
    const secondStop = runtime.stop();
    releaseUnmount.resolve();

    const errors = await Promise.all([firstStop.catch((error: unknown) => error), secondStop.catch((error: unknown) => error)]);
    expect(errors[0]).toBe(errors[1]);
    expect(errors[0]).toEqual(new Error("unmount failed"));
    expect(lifecycle).toEqual(["second:late", "second:early", "first"]);
    await expect(runtime.stop()).rejects.toThrow("unmount failed");
    expect(lifecycle).toEqual(["second:late", "second:early", "first", "second:late"]);
  });

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

  it("rejects overlapping direct drains without mounting twice", async () => {
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
    await expect(runtime.drain()).rejects.toThrow("another drain is in progress");
    releaseMount.resolve();
    await firstDrain;
    await runtime.stop();

    expect(mounts).toBe(1);
    expect(unmounts).toBe(1);
  });
});
