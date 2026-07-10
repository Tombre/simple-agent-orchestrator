import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface RuntimeOwner {
  pid: number;
  startedAt: string;
  token: string;
}

interface LockRecord {
  generation: string;
  owner: RuntimeOwner | undefined;
}

export interface RuntimeOwnership {
  release(): Promise<void>;
}

function parseOwner(raw: string): RuntimeOwner | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const value = parsed as Partial<RuntimeOwner>;
    if (
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      value.pid > 0x7fffffff ||
      typeof value.startedAt !== "string" ||
      typeof value.token !== "string"
    ) {
      return undefined;
    }
    return { pid: value.pid, startedAt: value.startedAt, token: value.token };
  } catch {
    return undefined;
  }
}

function generation(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

async function readLock(path: string): Promise<LockRecord | null> {
  try {
    const raw = await readFile(path, "utf8");
    return { generation: generation(raw), owner: parseOwner(raw) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH" && code !== "EINVAL" && code !== "ERR_INVALID_ARG_TYPE";
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function activeOwnerError(lockPath: string, owner: RuntimeOwner): Error {
  return new Error(
    `Another active orchestrator runtime owns ${lockPath} (PID ${owner.pid}, started ${owner.startedAt}). ` +
      "Stop it before starting another runtime for the same state.",
  );
}

function hardLinkError(lockPath: string, error: NodeJS.ErrnoException): Error {
  return new Error(
    `Runtime ownership for ${lockPath} requires a local filesystem with hard-link support (${error.code ?? "unknown error"}).`,
    { cause: error },
  );
}

async function publish(source: string, target: string): Promise<"created" | "exists"> {
  try {
    await link(source, target);
    return "created";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return "exists";
    throw hardLinkError(target, error as NodeJS.ErrnoException);
  }
}

export async function acquireRuntimeOwnership(lockPath: string): Promise<RuntimeOwnership> {
  await mkdir(dirname(lockPath), { recursive: true });
  const owner: RuntimeOwner = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: randomUUID(),
  };
  const candidatePath = `${lockPath}.${owner.pid}.${owner.token}.candidate`;
  let acquired = false;
  let candidatePending = true;
  const recoveryPaths: string[] = [];
  await writeFile(candidatePath, JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });

  try {
    while (true) {
      if ((await publish(candidatePath, lockPath)) === "created") {
        acquired = true;
        break;
      }

      const staleLock = await readLock(lockPath);
      if (!staleLock) continue;
      if (staleLock.owner && isProcessAlive(staleLock.owner.pid)) {
        throw activeOwnerError(lockPath, staleLock.owner);
      }

      let recoveryGeneration = staleLock.generation;
      while (true) {
        const recoveryPath = `${lockPath}.recovery.${recoveryGeneration}`;
        if ((await publish(candidatePath, recoveryPath)) === "created") {
          recoveryPaths.push(recoveryPath);
          break;
        }
        const recovery = await readLock(recoveryPath);
        if (!recovery) continue;
        if (recovery.owner && isProcessAlive(recovery.owner.pid)) {
          throw activeOwnerError(lockPath, recovery.owner);
        }
        recoveryGeneration = generation(`${recoveryGeneration}:${recovery.generation}`);
      }

      const currentLock = await readLock(lockPath);
      if (!currentLock || currentLock.generation !== staleLock.generation) continue;
      if (currentLock.owner && isProcessAlive(currentLock.owner.pid)) {
        throw activeOwnerError(lockPath, currentLock.owner);
      }
      await removeIfPresent(lockPath);
    }
  } finally {
    if (acquired) {
      try {
        await removeIfPresent(candidatePath);
        candidatePending = false;
      } catch {
        // Ownership is valid; release() will retry candidate cleanup.
      }
    } else {
      for (const recoveryPath of recoveryPaths) {
        const recovery = await readLock(recoveryPath);
        if (recovery?.owner?.token === owner.token) await removeIfPresent(recoveryPath);
      }
      await removeIfPresent(candidatePath);
    }
  }

  return {
    async release() {
      const currentLock = await readLock(lockPath);
      if (currentLock?.owner?.token === owner.token) await removeIfPresent(lockPath);
      if (candidatePending) {
        await removeIfPresent(candidatePath);
        candidatePending = false;
      }
    },
  };
}
