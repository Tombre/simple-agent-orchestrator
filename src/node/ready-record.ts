import { open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { JsonRecord } from "../core/types.js";

export async function publishReadyRecord(filePath: string, record: JsonRecord): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const temporary = await open(temporaryPath, "wx", 0o600);
  try {
    await temporary.writeFile(JSON.stringify(record), "utf8");
    await temporary.close();
    await rename(temporaryPath, filePath);
  } catch (error) {
    await temporary.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readReadyRecord<T extends JsonRecord>(
  filePath: string,
  validate: (record: JsonRecord) => record is T,
): Promise<T | undefined> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return isRecord(value) && validate(value) ? value : undefined;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
