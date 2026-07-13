import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ManagedProcessLocator {
  locate(): Promise<number | undefined>;
  owns(processGroupId: number): Promise<boolean>;
}

export function createPosixProcessGroupLocator(
  requiredCommandValues: readonly string[],
): ManagedProcessLocator {
  if (process.platform === "win32") {
    throw new Error("POSIX process-group discovery is unavailable on Windows");
  }
  if (requiredCommandValues.length === 0 || requiredCommandValues.some((value) => value.length === 0)) {
    throw new Error("Process-group discovery requires non-empty command values");
  }
  const matches = (command: string) => requiredCommandValues.every((value) => commandHasArgument(command, value));
  return {
    async locate() {
      const groups = [...new Set((await processRows())
        .filter(({ command }) => matches(command))
        .map(({ processGroupId }) => processGroupId))];
      if (groups.length > 1) throw new Error("Multiple process groups match the managed resource");
      return groups[0];
    },
    async owns(processGroupId) {
      return (await processRows()).some((row) => row.processGroupId === processGroupId && matches(row.command));
    },
  };
}

function commandHasArgument(command: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s'\"])${escaped}(?=$|[\\s'\"])`).test(command);
}

async function processRows(): Promise<Array<{ processGroupId: number; command: string }>> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,pgid=,command="], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) return [];
    const processGroupId = Number(match[2]);
    return Number.isSafeInteger(processGroupId) && processGroupId > 1
      ? [{ processGroupId, command: match[3]! }]
      : [];
  });
}
