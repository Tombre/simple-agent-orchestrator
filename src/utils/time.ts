export const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;
export const MAX_TIMER_DURATION_MS = 2_147_483_647;
export const MAX_RETRY_DELAY_MS = MAX_TIMER_DURATION_MS;

export function nowIso(): string {
  return new Date().toISOString();
}

export function isSupportedRetryDelay(durationMs: number): boolean {
  return Number.isFinite(durationMs) && durationMs >= 0 && durationMs <= MAX_RETRY_DELAY_MS;
}

export function parseDuration(value: number | string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid duration: ${value}`);
    }
    return value;
  }

  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!match) {
    throw new Error(`Invalid duration string: ${value}. Use ms, s, m, or h.`);
  }

  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  const duration = amount * multiplier;
  if (!Number.isFinite(duration)) throw new Error(`Invalid duration: ${value}`);
  return duration;
}
