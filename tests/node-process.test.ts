import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnManagedProcess } from "../src/node/index.js";
import { waitFor } from "./helpers.js";

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
});

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
