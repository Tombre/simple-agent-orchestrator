import type { KeyLike, SessionNote, StoredSession } from "./types.js";
import { keyName } from "./types.js";
import { newId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";

export interface SessionEndOptions {
  reason?: string;
}

export interface Session {
  readonly id: string;
  readonly key: string;
  readonly status: StoredSession["status"];
  get<T = unknown>(key: KeyLike<T>): T;
  getOptional<T = unknown>(key: KeyLike<T>): T | undefined;
  set<T = unknown>(key: KeyLike<T>, value: T): void;
  has(key: KeyLike): boolean;
  delete(key: KeyLike): void;
  ensure<T = unknown>(key: KeyLike<T>, factory: () => Promise<T> | T): Promise<T>;
  note(message: string, data?: unknown): void;
  end(options?: SessionEndOptions): void;
  toStored(): StoredSession;
  drainNotes(): SessionNote[];
}

export type EnsureCoordinator = <T>(
  session: SessionImpl,
  name: string,
  factory: () => Promise<T> | T,
) => Promise<T>;

export type SessionMutation =
  | { type: "set"; name: string; value: unknown }
  | { type: "delete"; name: string };

export class SessionImpl implements Session {
  private readonly notes: SessionNote[] = [];
  private ended = false;
  private endReason: string | undefined;
  private readonly ensureCache = new Map<string, Promise<unknown>>();
  private readonly mutations = new Map<string, SessionMutation>();

  constructor(
    private readonly stored: StoredSession,
    private readonly ensureCoordinator?: EnsureCoordinator,
  ) {}

  get id(): string {
    return this.stored.id;
  }

  get key(): string {
    return this.stored.key;
  }

  get status(): StoredSession["status"] {
    return this.stored.status;
  }

  get<T = unknown>(key: KeyLike<T>): T {
    const name = keyName(key);
    if (!(name in this.stored.state)) throw new Error(`Session value not found: ${name}`);
    return this.stored.state[name] as T;
  }

  getOptional<T = unknown>(key: KeyLike<T>): T | undefined {
    return this.stored.state[keyName(key)] as T | undefined;
  }

  set<T = unknown>(key: KeyLike<T>, value: T): void {
    const name = keyName(key);
    this.stored.state[name] = value;
    this.mutations.set(name, { type: "set", name, value });
    this.stored.updatedAt = nowIso();
  }

  has(key: KeyLike): boolean {
    return keyName(key) in this.stored.state;
  }

  delete(key: KeyLike): void {
    const name = keyName(key);
    delete this.stored.state[name];
    this.mutations.set(name, { type: "delete", name });
    this.stored.updatedAt = nowIso();
  }

  async ensure<T = unknown>(key: KeyLike<T>, factory: () => Promise<T> | T): Promise<T> {
    const name = keyName(key);
    if (name in this.stored.state) return this.stored.state[name] as T;

    if (this.ensureCoordinator) {
      return this.ensureCoordinator(this, name, factory);
    }

    const existing = this.ensureCache.get(name) as Promise<T> | undefined;
    if (existing) return existing;

    const created = Promise.resolve().then(factory).then((value) => {
      this.set(name, value);
      this.ensureCache.delete(name);
      return value;
    });

    this.ensureCache.set(name, created);
    return created;
  }

  note(message: string, data?: unknown): void {
    this.notes.push({
      id: newId("note"),
      sessionId: this.id,
      message,
      data,
      createdAt: nowIso(),
    });
  }

  end(options?: SessionEndOptions): void {
    this.ended = true;
    this.endReason = options?.reason;
    this.stored.status = "ended";
    this.stored.endedAt = nowIso();
    this.stored.endReason = this.endReason;
    this.stored.updatedAt = nowIso();
  }

  toStored(): StoredSession {
    return { ...this.stored, state: { ...this.stored.state } };
  }

  pendingMutations(): SessionMutation[] {
    return [...this.mutations.values()];
  }

  clearMutations(): void {
    this.mutations.clear();
  }

  clearMutation(name: string): void {
    this.mutations.delete(name);
  }

  mergeStoredState(state: Record<string, unknown>): void {
    for (const name of Object.keys(this.stored.state)) {
      if (!this.mutations.has(name) && !(name in state)) delete this.stored.state[name];
    }
    for (const [name, value] of Object.entries(state)) {
      if (!this.mutations.has(name)) this.stored.state[name] = value;
    }
  }

  drainNotes(): SessionNote[] {
    const drained = [...this.notes];
    this.notes.length = 0;
    return drained;
  }
}

export function createStoredSession(key: string): StoredSession {
  const now = nowIso();
  return {
    id: newId("sess"),
    key,
    status: "active",
    state: {},
    createdAt: now,
    updatedAt: now,
  };
}
