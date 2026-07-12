import type {
  OrchestratorState,
  SessionNote,
  StoredCapacityReservation,
  StoredDelivery,
  StoredEvent,
  StoredExhaustion,
  StoredSandbox,
  StoredSession,
} from "../core/types.js";
import { isSupportedRetryDelay } from "../utils/time.js";

export const CURRENT_STATE_VERSION = 7 as const;
export const MINIMUM_STATE_VERSION = 1 as const;
const MAX_JSON_NESTING_DEPTH = 100;

export type StateValidationErrorCode = "invalid-json" | "invalid-state" | "unsupported-version";

export class StateValidationError extends Error {
  readonly name = "StateValidationError";

  constructor(
    readonly code: StateValidationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function failure(code: StateValidationErrorCode, source: string, message: string): never {
  throw new StateValidationError(
    code,
    `Invalid orchestrator state at ${source}: ${message} The state file was not modified.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value: unknown, path: string, source: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) failure("invalid-state", source, `${path} must be an object.`);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    failure("invalid-state", source, `${path} must be JSON-safe; symbol properties are not supported.`);
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) {
      failure("invalid-state", source, `${path}.${key} must be JSON-safe; non-enumerable properties are not supported.`);
    }
    if (!("value" in descriptor)) {
      failure("invalid-state", source, `${path}.${key} must be JSON-safe; accessor properties are not supported.`);
    }
  }
}

function requireFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  source: string,
): void {
  for (const field of required) {
    if (!Object.hasOwn(value, field)) failure("invalid-state", source, `${path}.${field} is required.`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) failure("invalid-state", source, `${path}.${field} is not recognized.`);
  }
}

function requireArray(value: unknown, path: string, source: string): asserts value is unknown[] {
  if (!Array.isArray(value)) failure("invalid-state", source, `${path} must be an array.`);
  if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) {
    failure("invalid-state", source, `${path} must be a plain JSON array.`);
  }
  const properties = Object.getOwnPropertyNames(value);
  if (properties.length !== value.length + 1) {
    failure("invalid-state", source, `${path} must be a dense JSON array without extra properties.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      failure("invalid-state", source, `${path} must be a dense JSON array without accessors.`);
    }
  }
}

function requireString(value: unknown, path: string, source: string): asserts value is string {
  if (typeof value !== "string") failure("invalid-state", source, `${path} must be a string.`);
}

function optionalString(value: Record<string, unknown>, field: string, path: string, source: string): void {
  if (value[field] !== undefined) requireString(value[field], `${path}.${field}`, source);
}

function requireInteger(value: unknown, path: string, minimum: number, source: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    failure("invalid-state", source, `${path} must be an integer greater than or equal to ${minimum}.`);
  }
}

function requireTimestamp(value: unknown, path: string, source: string): asserts value is string {
  requireString(value, path, source);
  if (!Number.isFinite(Date.parse(value))) failure("invalid-state", source, `${path} must be a valid timestamp.`);
}

function requireJsonValue(
  value: unknown,
  path: string,
  source: string,
  ancestors = new Set<object>(),
  depth = 0,
): void {
  if (depth > MAX_JSON_NESTING_DEPTH) {
    failure("invalid-state", source, `${path} exceeds the maximum JSON nesting depth of ${MAX_JSON_NESTING_DEPTH}.`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    failure("invalid-state", source, `${path} must be JSON-safe; non-finite numbers are not supported.`);
  }
  if (typeof value !== "object") {
    failure("invalid-state", source, `${path} must be JSON-safe; ${typeof value} values are not supported.`);
  }
  if (ancestors.has(value)) failure("invalid-state", source, `${path} must be JSON-safe; circular values are not supported.`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    requireArray(value, path, source);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))!;
      requireJsonValue(descriptor.value, `${path}[${index}]`, source, ancestors, depth + 1);
    }
  } else {
    requireRecord(value, path, source);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      requireJsonValue(descriptor.value, `${path}.${key}`, source, ancestors, depth + 1);
    }
  }
  ancestors.delete(value);
}

function requireJsonRecord(value: unknown, path: string, source: string): asserts value is Record<string, unknown> {
  requireRecord(value, path, source);
  for (const [key, item] of Object.entries(value)) requireJsonValue(item, `${path}.${key}`, source);
}

function validateSession(value: unknown, index: number, source: string): asserts value is StoredSession {
  const path = `state.sessions[${index}]`;
  requireRecord(value, path, source);
  requireFields(value, ["id", "key", "status", "state", "createdAt", "updatedAt"], ["endedAt", "endReason"], path, source);
  requireString(value.id, `${path}.id`, source);
  requireString(value.key, `${path}.key`, source);
  if (!(["active", "ended", "failed", "paused"] as unknown[]).includes(value.status)) {
    failure("invalid-state", source, `${path}.status must be active, ended, failed, or paused.`);
  }
  requireJsonRecord(value.state, `${path}.state`, source);
  requireString(value.createdAt, `${path}.createdAt`, source);
  requireString(value.updatedAt, `${path}.updatedAt`, source);
  optionalString(value, "endedAt", path, source);
  optionalString(value, "endReason", path, source);
}

function validateEvent(value: unknown, index: number, source: string): asserts value is StoredEvent {
  const path = `state.events[${index}]`;
  requireRecord(value, path, source);
  requireFields(
    value,
    ["id", "channelId", "sourceId", "dedupeKey", "sessionKey", "receivedAt"],
    ["type", "input", "payload", "meta", "occurredAt"],
    path,
    source,
  );
  for (const field of ["id", "channelId", "sourceId", "dedupeKey", "sessionKey", "receivedAt"] as const) {
    requireString(value[field], `${path}.${field}`, source);
  }
  optionalString(value, "type", path, source);
  optionalString(value, "occurredAt", path, source);
  if (value.input !== undefined) requireJsonValue(value.input, `${path}.input`, source);
  if (value.payload !== undefined) requireJsonValue(value.payload, `${path}.payload`, source);
  if (value.meta !== undefined) requireJsonRecord(value.meta, `${path}.meta`, source);
}

function validateDelivery(
  value: unknown,
  index: number,
  source: string,
  historicalRetryFields = false,
  allowIgnored = false,
  phaseAware = false,
): asserts value is StoredDelivery {
  const path = `state.deliveries[${index}]`;
  requireRecord(value, path, source);
  requireFields(
    value,
    [
      "id", "eventId", "channelId", "clientId", "handlerId", "status", "attempts", "maxAttempts",
      ...(historicalRetryFields ? [] : ["retryDelayMs"]),
      "createdAt", "updatedAt", ...(phaseAware ? ["phase"] : []),
    ],
    ["startedAt", "processedAt", "lastError", "sessionId", ...(historicalRetryFields ? [] : ["nextAttemptAt"]), ...(allowIgnored ? ["ignoredReason"] : []), ...(phaseAware ? ["lastFailureStage", "staged"] : [])],
    path,
    source,
  );
  for (const field of ["id", "eventId", "channelId", "clientId", "handlerId", "createdAt", "updatedAt"] as const) {
    requireString(value[field], `${path}.${field}`, source);
  }
  const statuses = allowIgnored
    ? ["pending", "processing", "processed", "failed", "ignored"]
    : ["pending", "processing", "processed", "failed"];
  if (!(statuses as unknown[]).includes(value.status)) {
    const expected = allowIgnored
      ? "pending, processing, processed, failed, or ignored"
      : "pending, processing, processed, or failed";
    failure("invalid-state", source, `${path}.status must be ${expected}.`);
  }
  if (phaseAware) {
    if (!("sandbox handling acknowledging cleaning persisting completed".split(" ") as unknown[]).includes(value.phase)) {
      failure("invalid-state", source, `${path}.phase is not recognized.`);
    }
    if ((value.status === "processed" || value.status === "ignored") !== (value.phase === "completed")) {
      failure("invalid-state", source, `${path}.phase must be completed exactly when the delivery is processed or ignored.`);
    }
    if (value.lastFailureStage !== undefined && !("sandbox handling acknowledging cleaning persisting".split(" ") as unknown[]).includes(value.lastFailureStage)) {
      failure("invalid-state", source, `${path}.lastFailureStage is not recognized.`);
    }
    if (value.staged !== undefined) {
      requireRecord(value.staged, `${path}.staged`, source);
      requireFields(value.staged, ["mutations", "notes", "releaseCapacity"], ["end"], `${path}.staged`, source);
      requireArray(value.staged.mutations, `${path}.staged.mutations`, source);
      value.staged.mutations.forEach((mutation, mutationIndex) => {
        const mutationPath = `${path}.staged.mutations[${mutationIndex}]`;
        requireRecord(mutation, mutationPath, source);
        if (mutation.type === "set") {
          requireFields(mutation, ["type", "name", "value"], [], mutationPath, source);
          requireJsonValue(mutation.value, `${mutationPath}.value`, source);
        } else if (mutation.type === "delete") {
          requireFields(mutation, ["type", "name"], [], mutationPath, source);
        } else failure("invalid-state", source, `${mutationPath}.type is not recognized.`);
        requireString(mutation.name, `${mutationPath}.name`, source);
      });
      requireArray(value.staged.notes, `${path}.staged.notes`, source);
      value.staged.notes.forEach((note, noteIndex) => validateNote(note, noteIndex, source, `${path}.staged.notes`));
      if (typeof value.staged.releaseCapacity !== "boolean") failure("invalid-state", source, `${path}.staged.releaseCapacity must be a boolean.`);
      if (value.staged.end !== undefined) {
        requireRecord(value.staged.end, `${path}.staged.end`, source);
        requireFields(value.staged.end, ["endedAt"], ["reason"], `${path}.staged.end`, source);
        requireTimestamp(value.staged.end.endedAt, `${path}.staged.end.endedAt`, source);
        optionalString(value.staged.end, "reason", `${path}.staged.end`, source);
      }
    }
    const stagedPhases = ["acknowledging", "cleaning", "persisting"];
    if (stagedPhases.includes(String(value.phase)) && value.staged === undefined) {
      failure("invalid-state", source, `${path}.staged is required after handling completes.`);
    }
    const terminalIgnoredEffects = value.status === "ignored" && value.phase === "completed";
    if (value.staged !== undefined && !stagedPhases.includes(String(value.phase)) && !terminalIgnoredEffects) {
      failure("invalid-state", source, `${path}.staged is not valid before handling or after completion.`);
    }
  }
  requireInteger(value.attempts, `${path}.attempts`, 0, source);
  requireInteger(value.maxAttempts, `${path}.maxAttempts`, 1, source);
  if (!historicalRetryFields) {
    requireInteger(value.retryDelayMs, `${path}.retryDelayMs`, 0, source);
    if (!isSupportedRetryDelay(value.retryDelayMs)) {
      failure("invalid-state", source, `${path}.retryDelayMs exceeds the supported range.`);
    }
  }
  if (value.attempts > value.maxAttempts) {
    failure("invalid-state", source, `${path}.attempts cannot exceed ${path}.maxAttempts.`);
  }
  if (value.status === "pending" && value.attempts >= value.maxAttempts) {
    failure("invalid-state", source, `${path} is pending but has no retry attempts remaining.`);
  }
  if ((value.status === "processing" || value.status === "processed") && value.attempts === 0) {
    failure("invalid-state", source, `${path} has status ${value.status} but has never been attempted.`);
  }
  if (value.status === "failed" && value.attempts !== value.maxAttempts) {
    failure("invalid-state", source, `${path} is failed but has not exhausted its retry attempts.`);
  }
  if (value.status === "ignored") {
    if (value.ignoredReason !== "session-missing" && value.ignoredReason !== "session-ended") {
      failure("invalid-state", source, `${path}.ignoredReason must be session-missing or session-ended.`);
    }
    if (value.processedAt === undefined) failure("invalid-state", source, `${path}.processedAt is required for ignored deliveries.`);
    if (value.attempts === 0 && value.startedAt !== undefined) failure("invalid-state", source, `${path}.startedAt is not valid for an unattempted ignored delivery.`);
    if (value.attempts === 0 && value.lastError !== undefined) failure("invalid-state", source, `${path}.lastError is not valid for an unattempted ignored delivery.`);
    if (value.nextAttemptAt !== undefined) failure("invalid-state", source, `${path}.nextAttemptAt is not valid for ignored deliveries.`);
    if (value.ignoredReason === "session-missing" && value.sessionId !== undefined) {
      failure("invalid-state", source, `${path}.sessionId is not valid when the session was missing at dispatch.`);
    }
    if (value.ignoredReason === "session-ended" && value.sessionId === undefined) {
      failure("invalid-state", source, `${path}.sessionId is required when the bound session ended before claim.`);
    }
    if (value.attempts > 0 && value.ignoredReason !== "session-ended") {
      failure("invalid-state", source, `${path} can only be ignored after an attempt when its bound session ended.`);
    }
  } else if (value.ignoredReason !== undefined) {
    failure("invalid-state", source, `${path}.ignoredReason is only valid for ignored deliveries.`);
  }
  for (const field of ["startedAt", "processedAt", "lastError", "sessionId", "ignoredReason"] as const) {
    optionalString(value, field, path, source);
  }
  if (!historicalRetryFields && value.nextAttemptAt !== undefined) {
    requireTimestamp(value.nextAttemptAt, `${path}.nextAttemptAt`, source);
    if (value.status !== "pending") {
      failure("invalid-state", source, `${path}.nextAttemptAt is only valid for pending deliveries.`);
    }
    if (value.attempts === 0 || value.retryDelayMs === 0) {
      failure("invalid-state", source, `${path}.nextAttemptAt requires a delayed retry attempt.`);
    }
  }
}

function validateNote(value: unknown, index: number, source: string, base = "state.notes"): asserts value is SessionNote {
  const path = `${base}[${index}]`;
  requireRecord(value, path, source);
  requireFields(value, ["id", "sessionId", "message", "createdAt"], ["data"], path, source);
  for (const field of ["id", "sessionId", "message", "createdAt"] as const) {
    requireString(value[field], `${path}.${field}`, source);
  }
  if (value.data !== undefined) requireJsonValue(value.data, `${path}.data`, source);
}

function validateExhaustion(value: unknown, index: number, source: string): asserts value is StoredExhaustion {
  const path = `state.exhaustions[${index}]`;
  requireRecord(value, path, source);
  requireFields(value, ["id", "sourceDeliveryId", "eventId", "clientId", "stage", "failure", "status", "attempts", "maxAttempts", "retryDelayMs", "createdAt", "updatedAt"], ["sessionId", "nextAttemptAt", "startedAt", "processedAt"], path, source);
  for (const field of ["id", "sourceDeliveryId", "eventId", "clientId", "createdAt", "updatedAt"] as const) requireString(value[field], `${path}.${field}`, source);
  optionalString(value, "sessionId", path, source);
  if (!("sandbox handling acknowledging cleaning persisting".split(" ") as unknown[]).includes(value.stage)) failure("invalid-state", source, `${path}.stage is not recognized.`);
  if (!("pending processing processed failed".split(" ") as unknown[]).includes(value.status)) failure("invalid-state", source, `${path}.status is not recognized.`);
  requireRecord(value.failure, `${path}.failure`, source);
  requireFields(value.failure, ["name"], ["message"], `${path}.failure`, source);
  requireString(value.failure.name, `${path}.failure.name`, source);
  optionalString(value.failure, "message", `${path}.failure`, source);
  if (value.failure.name.length > 128) failure("invalid-state", source, `${path}.failure.name is too long.`);
  if (typeof value.failure.message === "string" && value.failure.message.length > 256) failure("invalid-state", source, `${path}.failure.message is too long.`);
  requireInteger(value.attempts, `${path}.attempts`, 0, source);
  requireInteger(value.maxAttempts, `${path}.maxAttempts`, 1, source);
  requireInteger(value.retryDelayMs, `${path}.retryDelayMs`, 0, source);
  if (!isSupportedRetryDelay(value.retryDelayMs)) failure("invalid-state", source, `${path}.retryDelayMs exceeds the supported range.`);
  if (value.attempts > value.maxAttempts) failure("invalid-state", source, `${path}.attempts exceeds its retry budget.`);
  if (value.status === "pending" && value.attempts >= value.maxAttempts) failure("invalid-state", source, `${path} is pending but exhausted.`);
  if ((value.status === "processing" || value.status === "processed") && value.attempts === 0) failure("invalid-state", source, `${path} has not been attempted.`);
  if (value.status === "failed" && value.attempts !== value.maxAttempts) failure("invalid-state", source, `${path} failed before exhaustion.`);
  if (value.status === "processed" && value.processedAt === undefined) failure("invalid-state", source, `${path}.processedAt is required.`);
  for (const field of ["nextAttemptAt", "startedAt", "processedAt"] as const) if (value[field] !== undefined) requireTimestamp(value[field], `${path}.${field}`, source);
  if (value.nextAttemptAt !== undefined && value.status !== "pending") failure("invalid-state", source, `${path}.nextAttemptAt is only valid while pending.`);
}

function validateCapacityReservation(
  value: unknown,
  index: number,
  source: string,
): asserts value is StoredCapacityReservation {
  const path = `state.capacityReservations[${index}]`;
  requireRecord(value, path, source);
  requireFields(value, ["id", "clientId", "sessionId", "acquiredAt"], [], path, source);
  requireString(value.id, `${path}.id`, source);
  requireString(value.clientId, `${path}.clientId`, source);
  requireString(value.sessionId, `${path}.sessionId`, source);
  requireTimestamp(value.acquiredAt, `${path}.acquiredAt`, source);
}

function validateSandbox(value: unknown, index: number, source: string): asserts value is StoredSandbox {
  const path = `state.sandboxes[${index}]`;
  requireRecord(value, path, source);
  requireFields(
    value,
    ["sessionId", "clientId", "environmentId", "status", "checkpoint", "createdAt", "updatedAt"],
    ["lastError"],
    path,
    source,
  );
  for (const field of ["sessionId", "clientId", "environmentId"] as const) {
    requireString(value[field], `${path}.${field}`, source);
  }
  if (!("creating active cleaning cleaned unknown".split(" ") as unknown[]).includes(value.status)) {
    failure("invalid-state", source, `${path}.status must be creating, active, cleaning, cleaned, or unknown.`);
  }
  requireJsonRecord(value.checkpoint, `${path}.checkpoint`, source);
  requireTimestamp(value.createdAt, `${path}.createdAt`, source);
  requireTimestamp(value.updatedAt, `${path}.updatedAt`, source);
  optionalString(value, "lastError", path, source);
}

function requireUniqueIds(items: readonly { id: string }[], path: string, source: string): void {
  const ids = new Set<string>();
  items.forEach((item, index) => {
    if (ids.has(item.id)) failure("invalid-state", source, `${path}[${index}].id duplicates ${JSON.stringify(item.id)}.`);
    ids.add(item.id);
  });
}

function validateRelationships(state: OrchestratorState, source: string): void {
  requireUniqueIds(state.sessions, "state.sessions", source);
  requireUniqueIds(state.events, "state.events", source);
  requireUniqueIds(state.deliveries, "state.deliveries", source);
  requireUniqueIds(state.exhaustions, "state.exhaustions", source);
  requireUniqueIds(state.capacityReservations, "state.capacityReservations", source);
  requireUniqueIds(state.notes, "state.notes", source);

  const activeKeys = new Set<string>();
  for (const session of state.sessions) {
    if (session.status !== "active") continue;
    if (activeKeys.has(session.key)) {
      failure("invalid-state", source, `state.sessions contains more than one active session for key ${JSON.stringify(session.key)}.`);
    }
    activeKeys.add(session.key);
  }

  const sessions = new Map(state.sessions.map((session) => [session.id, session]));
  const events = new Map(state.events.map((event) => [event.id, event]));
  const dedupeIdentities = new Set<string>();
  state.events.forEach((event, index) => {
    const identity = JSON.stringify([event.channelId, event.dedupeKey]);
    if (dedupeIdentities.has(identity)) {
      failure("invalid-state", source, `state.events[${index}] duplicates a channelId and dedupeKey identity.`);
    }
    dedupeIdentities.add(identity);
  });
  const deliveryIdentities = new Set<string>();
  state.deliveries.forEach((delivery, index) => {
    const event = events.get(delivery.eventId);
    if (!event) failure("invalid-state", source, `state.deliveries[${index}].eventId references missing event ${JSON.stringify(delivery.eventId)}.`);
    if (event.channelId !== delivery.channelId) {
      failure("invalid-state", source, `state.deliveries[${index}].channelId does not match its event.`);
    }
    if (
      delivery.sessionId !== undefined &&
      !sessions.has(delivery.sessionId) &&
      delivery.ignoredReason !== "session-ended"
    ) {
      failure("invalid-state", source, `state.deliveries[${index}].sessionId references missing session ${JSON.stringify(delivery.sessionId)}.`);
    }
    if (delivery.sessionId !== undefined && sessions.has(delivery.sessionId)) {
      const session = sessions.get(delivery.sessionId)!;
      if (session.key !== event.sessionKey) {
        failure("invalid-state", source, `state.deliveries[${index}].sessionId does not match its event sessionKey.`);
      }
      if (delivery.ignoredReason === "session-ended" && session.status === "active") {
        failure("invalid-state", source, `state.deliveries[${index}] is session-ended but references an active session.`);
      }
    }
    const identity = JSON.stringify([delivery.eventId, delivery.clientId, delivery.handlerId]);
    if (deliveryIdentities.has(identity)) {
      failure("invalid-state", source, `state.deliveries[${index}] duplicates an eventId, clientId, and handlerId identity.`);
    }
    deliveryIdentities.add(identity);
    if (delivery.staged) {
      if (!delivery.sessionId) failure("invalid-state", source, `state.deliveries[${index}].staged requires sessionId.`);
      for (const note of delivery.staged.notes) {
        if (note.sessionId !== delivery.sessionId) failure("invalid-state", source, `state.deliveries[${index}].staged note does not match sessionId.`);
      }
    }
  });
  state.exhaustions.forEach((work, index) => {
    if (!events.has(work.eventId)) failure("invalid-state", source, `state.exhaustions[${index}].eventId references a missing event.`);
    const delivery = state.deliveries.find(({ id }) => id === work.sourceDeliveryId);
    if (!delivery) failure("invalid-state", source, `state.exhaustions[${index}].sourceDeliveryId references a missing delivery.`);
    // Exhaustion is independent historical work; a manual retry may have moved its source beyond failed.
    if (delivery.eventId !== work.eventId || delivery.clientId !== work.clientId || delivery.sessionId !== work.sessionId) {
      failure("invalid-state", source, `state.exhaustions[${index}] does not match its source delivery.`);
    }
    if (work.sessionId !== undefined && !sessions.has(work.sessionId)) failure("invalid-state", source, `state.exhaustions[${index}].sessionId references a missing session.`);
  });
  const exhaustionSources = new Set<string>();
  state.exhaustions.forEach((work, index) => {
    if (exhaustionSources.has(work.sourceDeliveryId)) failure("invalid-state", source, `state.exhaustions[${index}] duplicates sourceDeliveryId.`);
    exhaustionSources.add(work.sourceDeliveryId);
  });
  state.notes.forEach((note, index) => {
    if (!sessions.has(note.sessionId)) {
      failure("invalid-state", source, `state.notes[${index}].sessionId references missing session ${JSON.stringify(note.sessionId)}.`);
    }
  });
  const sandboxIdentities = new Set<string>();
  state.sandboxes.forEach((sandbox, index) => {
    if (!sessions.has(sandbox.sessionId)) {
      failure("invalid-state", source, `state.sandboxes[${index}].sessionId references missing session ${JSON.stringify(sandbox.sessionId)}.`);
    }
    const identity = JSON.stringify([sandbox.sessionId, sandbox.clientId, sandbox.environmentId]);
    if (sandboxIdentities.has(identity)) {
      failure("invalid-state", source, `state.sandboxes[${index}] duplicates a sessionId, clientId, and environmentId identity.`);
    }
    sandboxIdentities.add(identity);
  });
  const capacityIdentities = new Set<string>();
  state.capacityReservations.forEach((reservation, index) => {
    const session = sessions.get(reservation.sessionId);
    if (!session) {
      failure(
        "invalid-state",
        source,
        `state.capacityReservations[${index}].sessionId references missing session ${JSON.stringify(reservation.sessionId)}.`,
      );
    }
    if (session.status !== "active") {
      failure("invalid-state", source, `state.capacityReservations[${index}] must reference an active session.`);
    }
    const identity = JSON.stringify([reservation.clientId, reservation.sessionId]);
    if (capacityIdentities.has(identity)) {
      failure("invalid-state", source, `state.capacityReservations[${index}] duplicates a clientId and sessionId identity.`);
    }
    capacityIdentities.add(identity);
  });
}

export function validateAndMigrateState(value: unknown, source = "state"): OrchestratorState {
  requireRecord(value, "state", source);
  if (!Object.hasOwn(value, "version")) failure("invalid-state", source, "state.version is required.");
  if (!Number.isInteger(value.version)) failure("invalid-state", source, "state.version must be an integer.");
  const version = value.version as number;
  if (version < MINIMUM_STATE_VERSION) {
    failure(
      "unsupported-version",
      source,
      `state version ${version} is older than the minimum supported version ${MINIMUM_STATE_VERSION}. Use an intermediate package version to migrate it or restore a compatible backup.`,
    );
  }
  if (version > CURRENT_STATE_VERSION) {
    failure(
      "unsupported-version",
      source,
      `state version ${version} is newer than this package supports (${CURRENT_STATE_VERSION}). Upgrade the package or restore a compatible backup.`,
    );
  }

  requireFields(
    value,
    [
      "version", "sessions", "events", "deliveries", ...(version >= 4 ? ["capacityReservations"] : []),
      ...(version >= 6 ? ["sandboxes"] : []), ...(version >= 7 ? ["exhaustions"] : []), "notes", "cursors",
    ],
    [],
    "state",
    source,
  );
  requireArray(value.sessions, "state.sessions", source);
  requireArray(value.events, "state.events", source);
  requireArray(value.deliveries, "state.deliveries", source);
  requireArray(value.notes, "state.notes", source);
  value.sessions.forEach((session, index) => validateSession(session, index, source));
  value.events.forEach((event, index) => validateEvent(event, index, source));
  const deliveries = version <= 2
    ? value.deliveries.map((delivery, index) => {
        validateDelivery(delivery, index, source, true);
        return { ...delivery, retryDelayMs: 0 };
      })
    : value.deliveries;
  const phaseAwareDeliveries = deliveries.map((delivery, index) => {
    if (version >= 7) return delivery;
    validateDelivery(delivery, index, source, false, version >= 5);
    return {
      ...delivery,
      phase: delivery.status === "processed" || delivery.status === "ignored" ? "completed" : "sandbox",
    };
  });
  phaseAwareDeliveries.forEach((delivery, index) => validateDelivery(delivery, index, source, false, version >= 5, true));
  const capacityReservations = version >= 4 ? value.capacityReservations : [];
  requireArray(capacityReservations, "state.capacityReservations", source);
  capacityReservations.forEach((reservation, index) => validateCapacityReservation(reservation, index, source));
  const sandboxes = version >= 6 ? value.sandboxes : [];
  requireArray(sandboxes, "state.sandboxes", source);
  sandboxes.forEach((sandbox, index) => validateSandbox(sandbox, index, source));
  const exhaustions = version >= 7 ? value.exhaustions : [];
  requireArray(exhaustions, "state.exhaustions", source);
  exhaustions.forEach((work, index) => validateExhaustion(work, index, source));
  value.notes.forEach((note, index) => validateNote(note, index, source));
  requireRecord(value.cursors, "state.cursors", source);
  for (const [cursorId, cursor] of Object.entries(value.cursors)) {
    requireJsonRecord(cursor, `state.cursors.${cursorId}`, source);
  }

  const state = {
    ...value,
    version: CURRENT_STATE_VERSION,
    deliveries: phaseAwareDeliveries,
    exhaustions,
    capacityReservations,
    sandboxes,
  } as unknown as OrchestratorState;
  validateRelationships(state, source);
  return state;
}

export function parseAndMigrateState(raw: string, source: string): OrchestratorState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    failure(
      "invalid-json",
      source,
      "the file contains invalid JSON. Repair the JSON or restore a compatible backup before retrying.",
    );
  }
  return validateAndMigrateState(parsed, source);
}
