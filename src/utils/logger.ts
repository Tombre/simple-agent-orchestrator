import type { Logger } from "../core/types.js";

function write(level: string, message: string, data?: Record<string, unknown>): void {
  const suffix = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : "";
  const line = `[simple-agent-orchestrator] ${level.toUpperCase()} ${message}${suffix}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const consoleLogger: Logger = {
  debug(message, data) {
    if (process.env.SAO_DEBUG) write("debug", message, data);
  },
  info(message, data) {
    write("info", message, data);
  },
  warn(message, data) {
    write("warn", message, data);
  },
  error(message, data) {
    write("error", message, data);
  },
};

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
