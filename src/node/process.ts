import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";

const DEFAULT_TERM_GRACE_MS = 5_000;
const DEFAULT_KILL_WAIT_MS = 5_000;
const DEFAULT_READY_INTERVAL_MS = 50;
const MAX_PROCESS_PID = 2_147_483_647;
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
  readonly stdio?: ManagedProcessStdio;
  readonly termGraceMs?: number;
  readonly ownsProcess?: (pid: number) => boolean | Promise<boolean>;
}

export type ManagedProcessStdio = "ignore" | "inherit" | readonly [
  ManagedProcessStdioTarget,
  ManagedProcessStdioTarget,
  ManagedProcessStdioTarget,
  ...ManagedProcessStdioTarget[],
];
export type ManagedProcessStdioTarget = "ignore" | "inherit" | number;

export interface AdoptManagedProcessOptions {
  readonly termGraceMs?: number;
  readonly ownsProcess: (pid: number) => boolean | Promise<boolean>;
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

export interface AdoptedManagedProcess {
  readonly pid: number;
  isAlive(): boolean;
  stop(options?: StopManagedProcessOptions): Promise<void>;
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
  validateDetachedStdio(options.stdio);
  const child: ChildProcess = spawn(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    detached: true,
    shell: false,
    stdio: (Array.isArray(options.stdio) ? [...options.stdio] : options.stdio ?? "ignore") as StdioOptions,
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

export function adoptManagedProcess(
  pid: number,
  options: AdoptManagedProcessOptions,
): AdoptedManagedProcess {
  validatePid(pid);
  const ownsProcess = options?.ownsProcess;
  if (typeof ownsProcess !== "function") {
    throw new Error("ownsProcess must be provided when adopting a managed process");
  }
  const termGraceMs = duration(options.termGraceMs, DEFAULT_TERM_GRACE_MS, "termGraceMs");
  return new NodeAdoptedManagedProcess(pid, termGraceMs, ownsProcess);
}

class NodeAdoptedManagedProcess implements AdoptedManagedProcess {
  private stopPromise: Promise<void> | undefined;

  constructor(
    readonly pid: number,
    private readonly defaultTermGraceMs: number,
    private readonly ownsProcess: AdoptManagedProcessOptions["ownsProcess"],
  ) {}

  isAlive(): boolean {
    return managedTargetIsAlive(this.pid);
  }

  stop(options: StopManagedProcessOptions = {}): Promise<void> {
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
      this.throwIfGone();
      const ready = await this.runReadinessCheck(check, options.signal, deadline, timeoutMs);
      if (ready) {
        this.throwIfGone();
        return;
      }

      const remaining = deadline === undefined ? intervalMs : deadline - Date.now();
      if (remaining <= 0) throw this.readinessTimeout(timeoutMs);
      await this.waitForInterval(Math.min(intervalMs, remaining), options.signal);
    }
  }

  private async stopOnce(graceMs: number): Promise<void> {
    if (!this.isAlive()) return;
    if (!await this.verifyOwnership()) return;

    if (!signalManagedTarget(this.pid, "SIGTERM")) return;
    if (await waitForCondition(() => !this.isAlive(), graceMs)) return;

    if (!this.isAlive()) return;
    if (!await this.verifyOwnership()) return;
    if (!signalManagedTarget(this.pid, "SIGKILL")) return;
    if (!await waitForCondition(() => !this.isAlive(), DEFAULT_KILL_WAIT_MS)) {
      throw new Error(`Process ${this.pid} remained alive after SIGKILL`);
    }
  }

  private async verifyOwnership(): Promise<boolean> {
    let ownsProcess: boolean;
    try {
      ownsProcess = await this.ownsProcess(this.pid);
    } catch (error) {
      if (!this.isAlive()) return false;
      throw error;
    }
    if (!this.isAlive()) return false;
    if (ownsProcess !== true) {
      throw new Error(`Process ${this.pid} ownership check denied signaling`);
    }
    return true;
  }

  private runReadinessCheck(
    check: () => boolean | Promise<boolean>,
    signal?: AbortSignal,
    deadline?: number,
    timeoutMs?: number,
  ): Promise<boolean> {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      let disappearanceTimer: ReturnType<typeof setTimeout> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (disappearanceTimer !== undefined) clearTimeout(disappearanceTimer);
        if (timeout !== undefined) clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      };
      const succeed = (ready: boolean): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(ready);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const abort = (): void => fail(signal?.reason);
      const detectDisappearance = (): void => {
        if (settled) return;
        if (!this.isAlive()) {
          fail(this.disappearanceError());
          return;
        }
        disappearanceTimer = setTimeout(detectDisappearance, 10);
      };

      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      if (deadline !== undefined) {
        timeout = setTimeout(
          () => fail(this.readinessTimeout(timeoutMs)),
          Math.max(0, deadline - Date.now()),
        );
      }
      detectDisappearance();
      Promise.resolve().then(check).then(succeed, fail);
    });
  }

  private waitForInterval(delayMs: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      let delay: ReturnType<typeof setTimeout> | undefined;
      let disappearanceTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (delay !== undefined) clearTimeout(delay);
        if (disappearanceTimer !== undefined) clearTimeout(disappearanceTimer);
        signal?.removeEventListener("abort", abort);
      };
      const succeed = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const abort = (): void => fail(signal?.reason);
      const detectDisappearance = (): void => {
        if (settled) return;
        if (!this.isAlive()) {
          fail(this.disappearanceError());
          return;
        }
        disappearanceTimer = setTimeout(detectDisappearance, 10);
      };

      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      delay = setTimeout(succeed, delayMs);
      detectDisappearance();
    });
  }

  private throwIfGone(): void {
    if (!this.isAlive()) throw this.disappearanceError();
  }

  private disappearanceError(): Error {
    return new Error(`Process ${this.pid} disappeared before becoming ready`);
  }

  private readinessTimeout(timeoutMs: number | undefined): Error {
    return new Error(`Process ${this.pid} did not become ready within ${timeoutMs}ms`);
  }
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
    if (this.ownsProcess !== undefined && await this.ownsProcess(this.pid) !== true) {
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

function validatePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid > MAX_PROCESS_PID) {
    throw new Error(`pid must be a positive safe process PID greater than 1 and no greater than ${MAX_PROCESS_PID}`);
  }
}

function validateDetachedStdio(stdio: ManagedProcessStdio | undefined): void {
  if (stdio === undefined || stdio === "ignore" || stdio === "inherit") return;
  const values = Array.isArray(stdio) ? stdio : [stdio];
  if (Array.isArray(stdio) && values.length < 3) {
    throw new Error("stdio arrays must explicitly configure stdin, stdout, and stderr");
  }
  for (const value of values) {
    if (
      value === undefined || value === null ||
      value === "pipe" || value === "overlapped" || value === "ipc"
    ) {
      throw new Error("stdio must not create pipes or IPC channels for a detached managed process");
    }
    if (value !== "ignore" && value !== "inherit" && !(typeof value === "number" && Number.isInteger(value) && value >= 0)) {
      throw new Error("stdio contains an unsupported detached process option");
    }
  }
}

function managedTargetIsAlive(pid: number): boolean {
  return signalTargetIsAlive(process.platform === "win32" ? pid : -pid);
}

function signalManagedTarget(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function signalTargetIsAlive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function pidIsAlive(pid: number): boolean {
  return signalTargetIsAlive(pid);
}

function processGroupIsAlive(pid: number): boolean {
  return signalTargetIsAlive(-pid);
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
