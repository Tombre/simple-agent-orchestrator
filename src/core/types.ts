export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = Record<string, JsonValue>;

export interface StateKey<T = unknown> {
  readonly name: string;
  readonly scope: "session" | "environment" | "cursor";
  readonly __type?: T;
}

export type KeyLike<T = unknown> = StateKey<T> | string;

export function sessionKey<T = unknown>(name: string): StateKey<T> {
  return { name, scope: "session" };
}

export function envKey<T = unknown>(name: string): StateKey<T> {
  return { name, scope: "environment" };
}

export function cursorKey<T = unknown>(name: string): StateKey<T> {
  return { name, scope: "cursor" };
}

export function keyName(key: KeyLike): string {
  return typeof key === "string" ? key : key.name;
}

export interface KeyBuilder<TParts extends Record<string, string | number | boolean>> {
  readonly namespace: string;
  (parts: TParts): string;
}

export function defineKey<TParts extends Record<string, string | number | boolean>>(
  namespace: string,
  options?: { parts?: readonly (keyof TParts)[] },
): KeyBuilder<TParts> {
  const builder = ((parts: TParts) => {
    const keys = options?.parts?.length
      ? options.parts
      : (Object.keys(parts).sort() as (keyof TParts)[]);

    const encoded = keys.map((key) => {
      const value = parts[key];
      return `${encodeURIComponent(String(key))}=${encodeURIComponent(String(value))}`;
    });

    return `${namespace}:${encoded.join(":")}`;
  }) as KeyBuilder<TParts>;

  Object.defineProperty(builder, "namespace", { value: namespace });
  return builder;
}

export interface DispatchEvent<
  TPayload = unknown,
  TInput = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  id: string;
  type?: string | undefined;
  dedupeKey?: string | undefined;
  sessionKey?: string | undefined;
  input?: TInput | undefined;
  payload?: TPayload | undefined;
  meta?: TMeta | undefined;
  occurredAt?: Date | string | undefined;
}

export interface OrchestratorEvent<
  TPayload = unknown,
  TInput = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> extends DispatchEvent<TPayload, TInput, TMeta> {
  channelId: string;
  dedupeKey: string;
  sessionKey: string;
  receivedAt: string;
  occurredAt?: string | undefined;
}

export type DeliveryStatus = "pending" | "processing" | "processed" | "failed";
export type SessionStatus = "active" | "ended" | "failed" | "paused";

export interface StoredSession {
  id: string;
  key: string;
  status: SessionStatus;
  state: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  endedAt?: string | undefined;
  endReason?: string | undefined;
}

export interface StoredEvent {
  id: string;
  channelId: string;
  sourceId: string;
  dedupeKey: string;
  sessionKey: string;
  type?: string | undefined;
  input?: unknown;
  payload?: unknown;
  meta?: Record<string, unknown> | undefined;
  occurredAt?: string | undefined;
  receivedAt: string;
}

export interface StoredDelivery {
  id: string;
  eventId: string;
  channelId: string;
  clientId: string;
  handlerId: string;
  status: DeliveryStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | undefined;
  processedAt?: string | undefined;
  lastError?: string | undefined;
  sessionId?: string | undefined;
}

export interface SessionNote {
  id: string;
  sessionId: string;
  message: string;
  data?: unknown;
  createdAt: string;
}

export interface OrchestratorState {
  version: 2;
  sessions: StoredSession[];
  events: StoredEvent[];
  deliveries: StoredDelivery[];
  notes: SessionNote[];
  cursors: Record<string, Record<string, unknown>>;
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface RetryOptions {
  attempts?: number;
}

export interface ConcurrencyOptions {
  workers?: number;
  perSession?: boolean;
}

export interface ProjectContext {
  root: string;
  orchestratorDir: string;
  packageJson: Record<string, unknown>;
  resolve(...parts: string[]): string;
  fromRoot(...parts: string[]): string;
  fromOrchestrator(...parts: string[]): string;
  statePath(...parts: string[]): string;
  cachePath(...parts: string[]): string;
}
