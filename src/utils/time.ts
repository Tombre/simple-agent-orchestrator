export function nowIso(): string {
  return new Date().toISOString();
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
  return amount * multiplier;
}
