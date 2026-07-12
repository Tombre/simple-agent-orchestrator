import { spawn, type ChildProcess } from "node:child_process";

const DEFAULT_TERM_GRACE_MS = 5_000;
const DEFAULT_READY_INTERVAL_MS = 50;
const MAX_TIMER_MS = 2_147_483_647;

export interface ManagedProcessExit {
  readonly pid: number;
  readonly code: number | null;
  readonly signal: string | null;
  readonly error?: Error;
}

export interface SpawnManagedProcessOptions {
  readonly cwd?: string | URL;
  readonly env?: Record<string, string | undefined>;
  readonly termGraceMs?: number;
  readonly ownsProcess?: (pid: number) => boolean | Promise<boolean>;
}

export interface StopManagedProcessOptions {
  readonly termGraceMs?: number;
}

export interface WaitUntilReadyOptions {
  readonly signal?: AbortSignal;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
}

export interface ManagedProcess {
  readonly pid: number;
  readonly exit: Promise<ManagedProcessExit>;
  isAlive(): boolean;
  stop(options?: StopManagedProcessOptions): Promise<ManagedProcessExit>;
  waitUntilReady(
    check: () => boolean | Promise<boolean>,
    options?: WaitUntilReadyOptions,
  ): Promise<void>;
}

export function spawnManagedProcess(
  command: string,
  args: readonly string[] = [],
  options: SpawnManagedProcessOptions = {},
): ManagedProcess {
  const termGraceMs = duration(options.termGraceMs, DEFAULT_TERM_GRACE_MS, "termGraceMs");
  const child = spawn(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    detached: true,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  const pid = child.pid;

  if (pid === undefined) {
    child.once("error", () => {});
    throw new Error(`Failed to spawn managed process: ${command} did not receive a PID`);
  }

  const managed = new NodeManagedProcess(child, pid, termGraceMs, options.ownsProcess);
  child.unref();
  return managed;
}

class NodeManagedProcess implements ManagedProcess {
  readonly exit: Promise<ManagedProcessExit>;
  private readonly child: ChildProcess;
  private readonly defaultTermGraceMs: number;
  private readonly ownsProcess: SpawnManagedProcessOptions["ownsProcess"];
  private exited = false;
  private spawnError: Error | undefined;
  private stopPromise: Promise<ManagedProcessExit> | undefined;

  constructor(
    child: ChildProcess,
    readonly pid: number,
    defaultTermGraceMs: number,
    ownsProcess: SpawnManagedProcessOptions["ownsProcess"],
  ) {
    this.child = child;
    this.defaultTermGraceMs = defaultTermGraceMs;
    this.ownsProcess = ownsProcess;
    this.exit = new Promise((resolve) => {
      child.once("error", (error) => {
        this.spawnError = error;
      });
      child.once("close", (code, signal) => {
        this.exited = true;
        resolve({
          pid,
          code,
          signal,
          ...(this.spawnError === undefined ? {} : { error: this.spawnError }),
        });
      });
    });
  }

  isAlive(): boolean {
    if (this.exited) return false;
    return pidIsAlive(this.pid);
  }

  stop(options: StopManagedProcessOptions = {}): Promise<ManagedProcessExit> {
    if (this.stopPromise === undefined) {
      const graceMs = duration(options.termGraceMs, this.defaultTermGraceMs, "termGraceMs");
      this.stopPromise = this.stopOnce(graceMs);
    }
    return this.stopPromise;
  }

  async waitUntilReady(
    check: () => boolean | Promise<boolean>,
    options: WaitUntilReadyOptions = {},
  ): Promise<void> {
    const intervalMs = duration(options.intervalMs, DEFAULT_READY_INTERVAL_MS, "intervalMs");
    const timeoutMs = options.timeoutMs === undefined
      ? undefined
      : duration(options.timeoutMs, 0, "timeoutMs");
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;

    while (true) {
      throwIfAborted(options.signal);
      if (!this.isAlive()) {
        const exit = await this.exit;
        throw new Error(formatEarlyExit(exit));
      }
      if (await this.runReadinessCheck(check, options.signal, deadline, timeoutMs)) return;

      const remaining = deadline === undefined ? intervalMs : deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Process ${this.pid} did not become ready within ${timeoutMs}ms`);
      }
      await this.waitForInterval(Math.min(intervalMs, remaining), options.signal);
    }
  }

  private async stopOnce(graceMs: number): Promise<ManagedProcessExit> {
    const detachedGroupAlive = process.platform !== "win32" && processGroupIsAlive(this.pid);
    if (!this.isAlive() && !detachedGroupAlive) return this.exit;
    await this.assertOwnership();
    if (!this.isAlive() && !detachedGroupAlive) return this.exit;

    const target = this.signal("SIGTERM", detachedGroupAlive || process.platform !== "win32");
    if (target === "gone") return this.exit;

    const stopped = target === "group"
      ? await waitForCondition(() => !processGroupIsAlive(this.pid), graceMs)
      : await waitForPromise(this.exit, graceMs);

    if (!stopped) {
      if (target === "group" && !processGroupIsAlive(this.pid)) return this.exit;
      if (target === "child" && !this.isAlive()) return this.exit;
      this.signal("SIGKILL", target === "group");
    }

    return this.exit;
  }

  private async assertOwnership(): Promise<void> {
    if (this.ownsProcess !== undefined && !await this.ownsProcess(this.pid)) {
      throw new Error(`Process ${this.pid} ownership check denied signaling`);
    }
  }

  private signal(signal: NodeJS.Signals, processGroup: boolean): "group" | "child" | "gone" {
    if (processGroup) {
      try {
        process.kill(-this.pid, signal);
        return "group";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }

    if (!this.isAlive()) return "gone";
    try {
      return this.child.kill(signal) ? "child" : "gone";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return "gone";
      throw error;
    }
  }

  private async waitForInterval(delayMs: number, signal?: AbortSignal): Promise<void> {
    await Promise.race([
      abortableDelay(delayMs, signal),
      this.exit.then((exit) => {
        throw new Error(formatEarlyExit(exit));
      }),
    ]);
  }

  private async runReadinessCheck(
    check: () => boolean | Promise<boolean>,
    signal?: AbortSignal,
    deadline?: number,
    timeoutMs?: number,
  ): Promise<boolean> {
    throwIfAborted(signal);
    let abort: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      if (signal === undefined) return;
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    const timedOut = new Promise<never>((_resolve, reject) => {
      if (deadline === undefined) return;
      timeout = setTimeout(() => {
        reject(new Error(`Process ${this.pid} did not become ready within ${timeoutMs}ms`));
      }, Math.max(0, deadline - Date.now()));
    });
    try {
      return await Promise.race([
        Promise.resolve().then(check),
        aborted,
        timedOut,
        this.exit.then((exit) => {
          throw new Error(formatEarlyExit(exit));
        }),
      ]);
    } finally {
      if (abort !== undefined) signal?.removeEventListener("abort", abort);
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

function duration(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > MAX_TIMER_MS) {
    throw new Error(`${name} must be between 0 and ${MAX_TIMER_MS} milliseconds`);
  }
  return Math.ceil(resolved);
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processGroupIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(finish, delayMs);
    function finish(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timeout);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason;
}

async function waitForPromise<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForCondition(check: () => boolean, timeoutMs?: number): Promise<boolean> {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  while (!check()) {
    if (deadline !== undefined && Date.now() >= deadline) return false;
    await abortableDelay(deadline === undefined ? 10 : Math.min(10, Math.max(0, deadline - Date.now())));
  }
  return true;
}

function formatEarlyExit(exit: ManagedProcessExit): string {
  const result = exit.code === null ? `signal ${exit.signal ?? "unknown"}` : `code ${exit.code}`;
  return `Process ${exit.pid} exited with ${result} before becoming ready`;
}
