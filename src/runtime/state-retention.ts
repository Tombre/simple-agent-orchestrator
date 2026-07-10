import type { OrchestratorState } from "../core/types.js";

export interface StatePruneOptions {
  before: Date | string;
  dropDedupe?: boolean;
}

export type StatePruneBlockedSessionReason = "active-sandbox" | "retained-delivery";

export interface StatePrunePlan {
  before: string;
  dropDedupe: boolean;
  deliveryIds: string[];
  sessionIds: string[];
  noteIds: string[];
  eventIds: string[];
  dedupeProtectedEventIds: string[];
  blockedSessions: { id: string; reason: StatePruneBlockedSessionReason }[];
}

const sandboxFlagPrefix = "__sao.sandbox.";
const sandboxFlagSuffix = ".created";

function parseIsoTimestamp(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return undefined;
  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond, , , rawOffsetHour, rawOffsetMinute] = match;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  const second = Number(rawSecond);
  const offsetHour = Number(rawOffsetHour ?? 0);
  const offsetMinute = Number(rawOffsetMinute ?? 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (
    daysInMonth === undefined || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function normalizeCutoff(value: Date | string): { iso: string; timestamp: number } {
  const timestamp = value instanceof Date ? value.getTime() : parseIsoTimestamp(value);
  if (timestamp === undefined || !Number.isFinite(timestamp)) {
    throw new Error("State prune --before must be a valid ISO 8601 timestamp with a timezone");
  }
  return { iso: new Date(timestamp).toISOString(), timestamp };
}

function isBefore(value: string | undefined, cutoff: number): boolean {
  if (value === undefined) return false;
  const timestamp = parseIsoTimestamp(value);
  return timestamp !== undefined && timestamp < cutoff;
}

function hasActiveSandbox(state: Record<string, unknown>): boolean {
  return Object.entries(state).some(
    ([key, value]) => key.startsWith(sandboxFlagPrefix) && key.endsWith(sandboxFlagSuffix) && value === true,
  );
}

export function planStatePrune(state: OrchestratorState, options: StatePruneOptions): StatePrunePlan {
  const cutoff = normalizeCutoff(options.before);
  const dropDedupe = options.dropDedupe ?? false;
  const deliveryIds = state.deliveries
    .filter((delivery) => delivery.status === "processed" && isBefore(delivery.processedAt, cutoff.timestamp))
    .map(({ id }) => id);
  const removedDeliveries = new Set(deliveryIds);
  const retainedDeliveries = state.deliveries.filter(({ id }) => !removedDeliveries.has(id));
  const retainedSessionIds = new Set(retainedDeliveries.flatMap(({ sessionId }) => sessionId ? [sessionId] : []));
  const retainedEventIds = new Set(retainedDeliveries.map(({ eventId }) => eventId));

  const sessionIds: string[] = [];
  const blockedSessions: StatePrunePlan["blockedSessions"] = [];
  for (const session of state.sessions) {
    if (session.status !== "ended" || !isBefore(session.endedAt, cutoff.timestamp)) continue;
    if (retainedSessionIds.has(session.id)) {
      blockedSessions.push({ id: session.id, reason: "retained-delivery" });
    } else if (hasActiveSandbox(session.state)) {
      blockedSessions.push({ id: session.id, reason: "active-sandbox" });
    } else {
      sessionIds.push(session.id);
    }
  }

  const removedSessions = new Set(sessionIds);
  const noteIds = state.notes.filter(({ sessionId }) => removedSessions.has(sessionId)).map(({ id }) => id);
  const eventCandidates = state.events.filter(
    (event) => isBefore(event.receivedAt, cutoff.timestamp) && !retainedEventIds.has(event.id),
  );

  return {
    before: cutoff.iso,
    dropDedupe,
    deliveryIds,
    sessionIds,
    noteIds,
    eventIds: dropDedupe ? eventCandidates.map(({ id }) => id) : [],
    dedupeProtectedEventIds: dropDedupe ? [] : eventCandidates.map(({ id }) => id),
    blockedSessions,
  };
}

export function applyStatePrune(state: OrchestratorState, plan: StatePrunePlan): void {
  const deliveryIds = new Set(plan.deliveryIds);
  const sessionIds = new Set(plan.sessionIds);
  const noteIds = new Set(plan.noteIds);
  const eventIds = new Set(plan.eventIds);
  state.deliveries = state.deliveries.filter(({ id }) => !deliveryIds.has(id));
  state.sessions = state.sessions.filter(({ id }) => !sessionIds.has(id));
  state.notes = state.notes.filter(({ id }) => !noteIds.has(id));
  state.events = state.events.filter(({ id }) => !eventIds.has(id));
}
