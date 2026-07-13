import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  adoptManagedProcess,
  createPosixProcessGroupLocator,
  getAvailableLoopbackPort,
  isLoopbackHttpUrl,
  publishReadyRecord,
  readReadyRecord,
  spawnManagedProcess,
} from "../src/node/index.js";
import { deferred, waitFor } from "./helpers.js";

const node = process.execPath;

describe("managed Node processes", () => {
  it("reports its PID, liveness, and natural exit", async () => {
    const processHandle = spawnManagedProcess(node, ["-e", "setTimeout(() => process.exit(7), 20)"]);

    expect(processHandle.pid).toBeGreaterThan(0);
    expect(processHandle.isAlive()).toBe(true);
    await expect(processHandle.exit).resolves.toEqual({
      pid: processHandle.pid,
      code: 7,
      signal: null,
    });
    expect(processHandle.isAlive()).toBe(false);
  });

  it("waits for async readiness and observes AbortSignal", async () => {
    const processHandle = spawnManagedProcess(node, ["-e", "setInterval(() => {}, 1_000)"]);
    let checks = 0;

    await processHandle.waitUntilReady(async () => {
      checks += 1;
      return checks === 2;
    }, { intervalMs: 5 });

    await expect(processHandle.waitUntilReady(
      () => new Promise<boolean>(() => {}),
      { timeoutMs: 5 },
    )).rejects.toThrow("did not become ready within 5ms");

    const controller = new AbortController();
    const reason = new Error("readiness cancelled");
    const waiting = processHandle.waitUntilReady(() => new Promise<boolean>(() => {}), {
      intervalMs: 5,
      signal: controller.signal,
    });
    controller.abort(reason);

    await expect(waiting).rejects.toBe(reason);
    await processHandle.stop({ termGraceMs: 50 });
  });

  it("validates lifecycle options before spawning", () => {
    expect(() => spawnManagedProcess(node, ["-e", "setInterval(() => {}, 1_000)"], {
      termGraceMs: -1,
    })).toThrow("termGraceMs");
  });

  it("passes configured stdio to the spawned process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sao-process-stdio-"));
    const outputPath = join(directory, "stdout");
    const output = await open(outputPath, "w");
    let processHandle: ReturnType<typeof spawnManagedProcess> | undefined;

    try {
      processHandle = spawnManagedProcess(node, ["-e", "process.stdout.write('visible')"], {
        stdio: ["ignore", output.fd, "ignore"],
      });
      await processHandle.exit;
      expect(await readFile(outputPath, "utf8")).toBe("visible");
    } finally {
      if (processHandle?.isAlive()) await processHandle.stop({ termGraceMs: 20 });
      await output.close();
    }
  });

  it("rejects stdio modes that create inaccessible pipes or IPC channels", () => {
    expect(() => spawnManagedProcess(node, [], { stdio: "pipe" as never })).toThrow("must not create pipes or IPC channels");
    expect(() => spawnManagedProcess(node, [], { stdio: "overlapped" as never })).toThrow("must not create pipes or IPC channels");
    expect(() => spawnManagedProcess(node, [], { stdio: ["ignore", "pipe", "ignore"] as never })).toThrow(
      "must not create pipes or IPC channels",
    );
    expect(() => spawnManagedProcess(node, [], { stdio: ["ignore", "inherit", "ipc"] as never })).toThrow(
      "must not create pipes or IPC channels",
    );
    expect(() => spawnManagedProcess(node, [], { stdio: [] as never })).toThrow(
      "must explicitly configure stdin, stdout, and stderr",
    );
    expect(() => spawnManagedProcess(node, [], { stdio: ["ignore"] as never })).toThrow(
      "must explicitly configure stdin, stdout, and stderr",
    );
  });

  it("gracefully stops once across concurrent and repeated calls", async () => {
    const processHandle = spawnManagedProcess(node, [
      "-e",
      "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000)",
    ]);
    await processHandle.waitUntilReady(() => processHandle.isAlive());

    const first = processHandle.stop({ termGraceMs: 100 });
    const second = processHandle.stop({ termGraceMs: 1 });
    expect(second).toBe(first);

    const exit = await first;
    expect(exit.code === 0 || exit.signal === "SIGTERM").toBe(true);
    await expect(processHandle.stop()).resolves.toEqual(exit);
  });

  it("kills a process that does not stop during its TERM grace period", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sao-process-ready-"));
    const readyPath = join(directory, "ready");
    const processHandle = spawnManagedProcess(node, [
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], 'ready'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)",
      readyPath,
    ]);
    await processHandle.waitUntilReady(async () => {
      try {
        return await readFile(readyPath, "utf8") === "ready";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });

    const startedAt = Date.now();
    const exit = await processHandle.stop({ termGraceMs: 30 });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
    expect(exit.signal).toBe("SIGKILL");
    expect(processHandle.isAlive()).toBe(false);
  });

  it("checks optional ownership before sending a signal", async () => {
    let checks = 0;
    const processHandle = spawnManagedProcess(node, ["-e", "setInterval(() => {}, 1_000)"], {
      ownsProcess: async (pid) => {
        expect(pid).toBe(processHandle.pid);
        checks += 1;
        return false;
      },
    });

    await expect(processHandle.stop()).rejects.toThrow("ownership check denied");
    expect(checks).toBe(1);
    expect(processHandle.isAlive()).toBe(true);
    process.kill(processHandle.pid, "SIGKILL");
    await processHandle.exit;
  });

  it.runIf(process.platform !== "win32")("stops the detached POSIX process group", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sao-process-group-"));
    const childPidPath = join(directory, "child.pid");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "writeFileSync(process.argv[1], String(child.pid));",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const processHandle = spawnManagedProcess(node, ["-e", script, childPidPath]);
    await waitFor(async () => {
      expect(Number(await readFile(childPidPath, "utf8"))).toBeGreaterThan(0);
    });
    const childPid = Number(await readFile(childPidPath, "utf8"));

    await processHandle.stop({ termGraceMs: 50 });

    await waitFor(() => {
      expect(isPidAlive(childPid)).toBe(false);
    });
  });

  it.runIf(process.platform !== "win32")("stops detached descendants after the group leader exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sao-process-orphan-"));
    const childPidPath = join(directory, "child.pid");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "writeFileSync(process.argv[1], String(child.pid));",
      "child.unref();",
    ].join(" ");
    const processHandle = spawnManagedProcess(node, ["-e", script, childPidPath]);
    await processHandle.exit;
    const childPid = Number(await readFile(childPidPath, "utf8"));
    expect(isPidAlive(childPid)).toBe(true);

    try {
      await processHandle.stop({ termGraceMs: 50 });
      await waitFor(() => {
        expect(isPidAlive(childPid)).toBe(false);
      });
    } finally {
      if (isPidAlive(childPid)) process.kill(childPid, "SIGKILL");
    }
  });

  it.runIf(process.platform !== "win32")("preserves authorized process-group ownership through escalation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sao-process-escalation-"));
    const childPidPath = join(directory, "child.pid");
    const childReadyPath = join(directory, "child.ready");
    let ownershipChecks = 0;
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', \"require('node:fs').writeFileSync(process.argv[1], 'ready'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\", process.argv[2]], { stdio: 'ignore' });",
      "writeFileSync(process.argv[1], String(child.pid));",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const processHandle = spawnManagedProcess(node, ["-e", script, childPidPath, childReadyPath], {
      ownsProcess: () => ++ownershipChecks === 1,
    });
    await waitFor(async () => {
      expect(Number(await readFile(childPidPath, "utf8"))).toBeGreaterThan(0);
      expect(await readFile(childReadyPath, "utf8")).toBe("ready");
    });
    const childPid = Number(await readFile(childPidPath, "utf8"));

    try {
      await processHandle.stop({ termGraceMs: 30 });
      expect(ownershipChecks).toBe(1);
      await waitFor(() => {
        expect(isPidAlive(childPid)).toBe(false);
      });
    } finally {
      if (isPidAlive(childPid)) process.kill(childPid, "SIGKILL");
      await processHandle.exit;
    }
  });

  it.runIf(process.platform !== "win32")("stops an adopted process group with TERM", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sao-adopt-term-"));
    const readyPath = join(directory, "ready");
    const termPath = join(directory, "term");
    const target = spawnTarget([
      "const { writeFileSync } = require('node:fs');",
      "writeFileSync(process.argv[1], 'ready');",
      "process.on('SIGTERM', () => { writeFileSync(process.argv[2], 'term'); process.exit(0); });",
      "setInterval(() => {}, 1000);",
    ].join(" "), [readyPath, termPath]);
    let ownershipChecks = 0;
    const adopted = adoptManagedProcess(target.pid, {
      ownsProcess: () => {
        ownershipChecks += 1;
        return true;
      },
    });

    try {
      await adopted.waitUntilReady(() => fileContains(readyPath, "ready"));
      await adopted.stop({ termGraceMs: 200 });

      expect(ownershipChecks).toBe(1);
      expect(await readFile(termPath, "utf8")).toBe("term");
      expect(adopted.isAlive()).toBe(false);
      await target.exit;
    } finally {
      await cleanupTarget(target);
    }
  });

  it.runIf(process.platform !== "win32")("escalates an adopted process group to KILL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sao-adopt-kill-"));
    const readyPath = join(directory, "ready");
    const termPath = join(directory, "term");
    const target = spawnTarget([
      "const { writeFileSync } = require('node:fs');",
      "writeFileSync(process.argv[1], 'ready');",
      "process.on('SIGTERM', () => writeFileSync(process.argv[2], 'term'));",
      "setInterval(() => {}, 1000);",
    ].join(" "), [readyPath, termPath]);
    let ownershipChecks = 0;
    const adopted = adoptManagedProcess(target.pid, { ownsProcess: () => {
      ownershipChecks += 1;
      return true;
    } });

    try {
      await adopted.waitUntilReady(() => fileContains(readyPath, "ready"));
      const startedAt = Date.now();
      await adopted.stop({ termGraceMs: 30 });

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
      expect(await readFile(termPath, "utf8")).toBe("term");
      expect((await target.exit).signal).toBe("SIGKILL");
      expect(adopted.isAlive()).toBe(false);
      expect(ownershipChecks).toBe(2);
    } finally {
      await cleanupTarget(target);
    }
  });

  it("denies adopted-process signaling when ownership verification fails", async () => {
    const target = spawnTarget("setInterval(() => {}, 1000)");
    let ownershipChecks = 0;
    const adopted = adoptManagedProcess(target.pid, {
      ownsProcess: async () => {
        ownershipChecks += 1;
        return false;
      },
    });

    try {
      await expect(adopted.stop()).rejects.toThrow("ownership check denied");
      expect(ownershipChecks).toBe(1);
      expect(adopted.isAlive()).toBe(true);
    } finally {
      await cleanupTarget(target);
    }
  });

  it.runIf(process.platform !== "win32")("rechecks adopted ownership before KILL escalation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sao-adopt-ownership-"));
    const readyPath = join(directory, "ready");
    const target = spawnTarget(
      "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)",
      [readyPath],
    );
    let ownershipChecks = 0;
    const adopted = adoptManagedProcess(target.pid, {
      ownsProcess: () => {
        ownershipChecks += 1;
        return ownershipChecks === 1;
      },
    });

    try {
      await waitFor(async () => expect(await readFile(readyPath, "utf8")).toBe("ready"));
      await expect(adopted.stop({ termGraceMs: 10 })).rejects.toThrow("ownership check denied");
      expect(ownershipChecks).toBe(2);
      expect(adopted.isAlive()).toBe(true);
    } finally {
      await cleanupTarget(target);
    }
  });

  it.runIf(process.platform !== "win32")("accepts target disappearance during KILL ownership verification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sao-adopt-kill-exit-"));
    const readyPath = join(directory, "ready");
    const target = spawnTarget(
      "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)",
      [readyPath],
    );
    let ownershipChecks = 0;
    const adopted = adoptManagedProcess(target.pid, {
      ownsProcess: async () => {
        ownershipChecks += 1;
        if (ownershipChecks === 1) return true;
        killTarget(target.pid);
        await target.exit;
        return false;
      },
    });

    try {
      await waitFor(async () => expect(await readFile(readyPath, "utf8")).toBe("ready"));
      await expect(adopted.stop({ termGraceMs: 10 })).resolves.toBeUndefined();
      expect(ownershipChecks).toBe(2);
      expect(adopted.isAlive()).toBe(false);
    } finally {
      await cleanupTarget(target);
    }
  });

  it("does not deny an adopted stop when the target exits during ownership verification", async () => {
    const target = spawnTarget("setInterval(() => {}, 1000)");
    const ownershipStarted = deferred();
    const ownershipResult = deferred<boolean>();
    const adopted = adoptManagedProcess(target.pid, {
      ownsProcess: () => {
        ownershipStarted.resolve();
        return ownershipResult.promise;
      },
    });

    try {
      const stopping = adopted.stop();
      await ownershipStarted.promise;
      killTarget(target.pid);
      await target.exit;
      ownershipResult.resolve(false);
      await expect(stopping).resolves.toBeUndefined();
    } finally {
      ownershipResult.resolve(false);
      await cleanupTarget(target);
    }
  });

  it("shares the first adopted-process stop and ownership decision", async () => {
    const target = spawnTarget("setInterval(() => {}, 1000)");
    const ownershipStarted = deferred();
    const ownershipResult = deferred<boolean>();
    let ownershipChecks = 0;
    const adopted = adoptManagedProcess(target.pid, {
      ownsProcess: async () => {
        ownershipChecks += 1;
        ownershipStarted.resolve();
        return ownershipResult.promise;
      },
    });

    try {
      const first = adopted.stop({ termGraceMs: 100 });
      const second = adopted.stop({ termGraceMs: 0 });
      expect(second).toBe(first);
      await ownershipStarted.promise;
      expect(ownershipChecks).toBe(1);
      expect(adopted.isAlive()).toBe(true);

      ownershipResult.resolve(true);
      await first;
      await expect(adopted.stop()).resolves.toBeUndefined();
      expect(ownershipChecks).toBe(1);
    } finally {
      ownershipResult.resolve(true);
      await cleanupTarget(target);
    }
  });

  it("supports async adopted readiness, timeout, and abort", async () => {
    const target = spawnTarget("setInterval(() => {}, 1000)");
    const adopted = adoptManagedProcess(target.pid, { ownsProcess: () => true });
    let checks = 0;

    try {
      await adopted.waitUntilReady(async () => {
        checks += 1;
        return checks === 2;
      }, { intervalMs: 5 });

      await expect(adopted.waitUntilReady(
        () => new Promise<boolean>(() => {}),
        { timeoutMs: 10 },
      )).rejects.toThrow("did not become ready within 10ms");

      const controller = new AbortController();
      const reason = new Error("adopted readiness cancelled");
      const waiting = adopted.waitUntilReady(() => new Promise<boolean>(() => {}), {
        signal: controller.signal,
      });
      controller.abort(reason);
      await expect(waiting).rejects.toBe(reason);
    } finally {
      await cleanupTarget(target);
    }
  });

  it("rejects adopted readiness when the target disappears", async () => {
    const target = spawnTarget("setInterval(() => {}, 1000)");
    const adopted = adoptManagedProcess(target.pid, { ownsProcess: () => true });
    const checkStarted = deferred();

    try {
      const waiting = adopted.waitUntilReady(() => {
        checkStarted.resolve();
        return new Promise<boolean>(() => {});
      });
      await checkStarted.promise;
      killTarget(target.pid);

      await expect(waiting).rejects.toThrow(`Process ${target.pid} disappeared before becoming ready`);
      await target.exit;
    } finally {
      await cleanupTarget(target);
    }
  });

  it.runIf(process.platform !== "win32")("adopts the persisted POSIX group after its leader exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sao-adopt-group-"));
    const childPidPath = join(directory, "child.pid");
    const target = spawnTarget([
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "writeFileSync(process.argv[1], String(child.pid));",
      "child.unref();",
    ].join(" "), [childPidPath]);
    let childPid: number | undefined;

    try {
      await target.exit;
      childPid = Number(await readFile(childPidPath, "utf8"));
      const adopted = adoptManagedProcess(target.pid, { ownsProcess: () => true });
      expect(adopted.isAlive()).toBe(true);

      await adopted.stop({ termGraceMs: 50 });

      expect(adopted.isAlive()).toBe(false);
      await waitFor(() => expect(isPidAlive(childPid!)).toBe(false));
    } finally {
      killTarget(target.pid);
      if (childPid !== undefined && isPidAlive(childPid)) process.kill(childPid, "SIGKILL");
      await target.exit.catch(() => {});
      await waitFor(() => expect(isSignalTargetAlive(-target.pid)).toBe(false));
      if (childPid !== undefined) {
        await waitFor(() => expect(isPidAlive(childPid!)).toBe(false));
      }
    }
  });

  it.runIf(process.platform !== "win32")("never falls back to a positive PID when the adopted group is absent", async () => {
    const target = spawnTarget("setInterval(() => {}, 1000)", [], false);
    let ownershipChecks = 0;
    const adopted = adoptManagedProcess(target.pid, {
      ownsProcess: () => {
        ownershipChecks += 1;
        return true;
      },
    });

    try {
      expect(isSignalTargetAlive(-target.pid)).toBe(false);
      expect(isPidAlive(target.pid)).toBe(true);
      expect(adopted.isAlive()).toBe(false);

      await adopted.stop();

      expect(ownershipChecks).toBe(0);
      expect(isPidAlive(target.pid)).toBe(true);
    } finally {
      process.kill(target.pid, "SIGKILL");
      await target.exit.catch(() => {});
    }
  });

  it("rejects invalid persisted PIDs before adoption", () => {
    const ownsProcess = () => true;
    for (const pid of [0, 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
      expect(() => adoptManagedProcess(pid, { ownsProcess })).toThrow("positive safe process PID");
    }
    expect(() => adoptManagedProcess(123, {} as never)).toThrow("ownsProcess must be provided");
  });

  it.runIf(process.platform !== "win32")("locates and verifies a managed POSIX process group", async () => {
    const marker = `sao-locator-${crypto.randomUUID()}`;
    const processHandle = spawnManagedProcess(node, ["-e", "setInterval(() => {}, 1000)", marker]);
    const locator = createPosixProcessGroupLocator([marker]);

    try {
      await waitFor(async () => expect(await locator.locate()).toBe(processHandle.pid));
      await expect(locator.owns(processHandle.pid)).resolves.toBe(true);
      await expect(locator.owns(processHandle.pid + 1)).resolves.toBe(false);
    } finally {
      await processHandle.stop({ termGraceMs: 20 });
    }
  });

  it("atomically publishes and validates readiness records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sao-ready-record-"));
    const readyPath = join(directory, "ready.json");
    try {
      await publishReadyRecord(readyPath, { state: "ready", pid: 42 });

      await expect(readReadyRecord(readyPath, (record): record is typeof record & { state: "ready" } =>
        record.state === "ready"
      )).resolves.toEqual({ state: "ready", pid: 42 });
      await expect(readReadyRecord(readyPath, (record): record is typeof record & { state: "other" } =>
        record.state === "other"
      )).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("provides strict loopback HTTP endpoints", async () => {
    const port = await getAvailableLoopbackPort();
    expect(port).toBeGreaterThan(0);
    expect(isLoopbackHttpUrl(`http://127.0.0.1:${port}`)).toBe(true);
    expect(isLoopbackHttpUrl(`http://localhost:${port}`)).toBe(false);
    expect(isLoopbackHttpUrl(`https://127.0.0.1:${port}`)).toBe(false);
    expect(isLoopbackHttpUrl(`http://user@127.0.0.1:${port}`)).toBe(false);
  });
});

interface SpawnedTarget {
  readonly pid: number;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly group: boolean;
}

function spawnTarget(script: string, args: readonly string[] = [], detached = true): SpawnedTarget {
  const child = spawn(node, ["-e", script, ...args], {
    detached,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("Test process did not receive a PID");
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { pid, exit, group: detached && process.platform !== "win32" };
}

async function cleanupTarget(target: SpawnedTarget): Promise<void> {
  killTarget(target.pid, target.group);
  await target.exit.catch(() => {});
  if (target.group) {
    await waitFor(() => expect(isSignalTargetAlive(-target.pid)).toBe(false));
  }
}

function killTarget(pid: number, group = process.platform !== "win32"): void {
  try {
    process.kill(group && process.platform !== "win32" ? -pid : pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function fileContains(path: string, expected: string): Promise<boolean> {
  try {
    return await readFile(path, "utf8") === expected;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isSignalTargetAlive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isPidAlive(pid: number): boolean {
  return isSignalTargetAlive(pid);
}
