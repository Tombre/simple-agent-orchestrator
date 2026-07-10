import { parseDuration } from "./time.js";

const requiredNames = new Set<string>();

export const env = {
  required(name: string): string {
    requiredNames.add(name);
    const value = process.env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  },

  optional(name: string, fallback?: string): string | undefined {
    return process.env[name] ?? fallback;
  },

  number(name: string, fallback?: number): number {
    const value = process.env[name];
    if (value === undefined || value === "") {
      if (fallback === undefined) throw new Error(`Missing required numeric environment variable: ${name}`);
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric environment variable ${name}: ${value}`);
    return parsed;
  },

  duration(name: string, fallback: number | string): number {
    const value = process.env[name];
    return parseDuration(value ?? fallback);
  },

  getRequiredNames(): string[] {
    return [...requiredNames].sort();
  },
};
