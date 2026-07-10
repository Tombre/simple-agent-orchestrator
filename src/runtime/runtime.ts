import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import type { ChannelDefinition, PollDefinition } from "../core/channel.js";
import { CursorImpl } from "../core/channel.js";
import type { ClientDefinition, HandlerContext, RegisteredHandler } from "../core/client.js";
import type { EnvironmentDefinition, EnvironmentInstance, SandboxContext } from "../core/environment.js";
import { createEmptyEnvironment, EnvironmentInstanceImpl } from "../core/environment.js";
import type { OrchestratorConfig } from "../core/config.js";
import { createStoredSession, SessionImpl } from "../core/session.js";
import type {
  DispatchEvent,
  Logger,
  OrchestratorEvent,
  OrchestratorState,
  ProjectContext,
  SessionNote,
  StoredDelivery,
  StoredEvent,
  StoredSession,
} from "../core/types.js";
import { memoryStore, type Store } from "../stores/index.js";
import { StoreMutex } from "../stores/store.js";
import { newId } from "../utils/id.js";
import { consoleLogger } from "../utils/logger.js";
import { nowIso, parseDuration } from "../utils/time.js";
import { acquireRuntimeOwnership, type RuntimeOwnership } from "./ownership.js";

export interface RuntimeOptions {
  project: ProjectContext;
  config: OrchestratorConfig;
}

export interface StartOptions {
  drain?: boolean;
  prettyStartupLog?: boolean;
}

interface ClaimedDelivery {
  delivery: StoredDelivery;
  event: StoredEvent;
  handler: RegisteredHandler;
  client: ClientDefinition;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Aborted"));
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(resolveDelay, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });
}

function normalizeDate(input: Date | string | undefined): string | undefined {
  if (!input) return undefined;
  return input instanceof Date ? input.toISOString() : new Date(input).toISOString();
}

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack ?? ""}`.trim();
  return String(error);
}

export class OrchestratorRuntime {
  private readonly store: Store;
  private readonly channels: ChannelDefinition[];
  private readonly clients: ClientDefinition[];
  private readonly logger: Logger;
  private readonly mutex = new StoreMutex();
  private readonly abortController = new AbortController();
  private readonly environmentInstances = new Map<string, EnvironmentInstanceImpl>();
  private readonly environmentMounts = new Map<string, Promise<EnvironmentInstanceImpl>>();
  private readonly intervalHandles: NodeJS.Timeout[] = [];
  private readonly workerPromises: Promise<void>[] = [];
  private readonly pollPromises = new Map<string, Promise<void>>();
  private readonly processingSessionKeys = new Set<string>();
  private readonly ensureLocks = new Map<string, Promise<unknown>>();
  private readonly sandboxLocks = new Map<string, Promise<void>>();
  private ownership: RuntimeOwnership | undefined;
  private ownershipPromise: Promise<RuntimeOwnership> | undefined;
  private initialized = false;

  constructor(private readonly options: RuntimeOptions) {
    this.store = options.config.store ?? memoryStore();
    this.channels = options.config.channels ?? [];
    this.clients = options.config.clients ?? [];
    this.logger = options.config.logger ?? consoleLogger;
  }

  get project(): ProjectContext {
    return this.options.project;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.validateConfiguration();
    await this.store.init();
    for (const channel of this.channels) {
      channel.__attachDispatch((event) => this.dispatch(channel.id, event));
    }
    this.initialized = true;
  }

  async start(options: StartOptions = {}): Promise<void> {
    await this.ensureRuntimeOwnership();
    try {
      await this.init();
      if (options.prettyStartupLog ?? true) this.printStartupSummary();

      if (options.drain) {
        try {
          await this.runAllPollsOnce();
          await this.drain();
        } finally {
          await this.stop();
        }
        return;
      }

      await this.mountAllEnvironments();
      this.startPollers();
      this.startWorkers();
    } catch (error) {
      try {
        await this.releaseRuntimeOwnership();
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], "Runtime startup and ownership release failed");
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.abortController.abort();
    for (const handle of this.intervalHandles) clearInterval(handle);
    this.intervalHandles.length = 0;
    await Promise.allSettled(this.pollPromises.values());
    await Promise.allSettled(this.workerPromises);
    let unmountError: unknown;
    try {
      await this.unmountAllEnvironments();
    } catch (error) {
      unmountError = error;
    }
    let releaseError: unknown;
    try {
      await this.releaseRuntimeOwnership();
    } catch (error) {
      releaseError = error;
    }
    if (unmountError && releaseError) {
      throw new AggregateError([unmountError, releaseError], "Runtime shutdown and ownership release failed");
    }
    if (unmountError) throw unmountError;
    if (releaseError) throw releaseError;
  }

  async drain(): Promise<void> {
    await this.ensureRuntimeOwnership();
    await this.mountAllEnvironments();
    while (true) {
      let processed = false;
      for (const client of this.clients) {
        const didProcess = await this.processNextDelivery(client);
        processed = processed || didProcess;
      }
      if (!processed) break;
    }
  }

  async dispatch(
    channelId: string,
    event: DispatchEvent,
  ): Promise<{ status: "queued" | "duplicate"; eventId: string }> {
    await this.init();
    const channel = this.channels.find((candidate) => candidate.id === channelId);
    if (!channel) throw new Error(`Unknown channel: ${channelId}`);

    return this.mutex.run(async () => {
      const state = await this.store.read();
      const sourceId = event.id;
      const dedupeKey = `${channelId}:${event.dedupeKey ?? event.id}`;
      const sessionKey = event.sessionKey ?? `${channelId}:${event.id}`;
      const existing = state.events.find((stored) => stored.channelId === channelId && stored.dedupeKey === dedupeKey);

      if (existing) {
        return { status: "duplicate", eventId: existing.id };
      }

      const storedEvent: StoredEvent = {
        id: newId("evt"),
        channelId,
        sourceId,
        dedupeKey,
        sessionKey,
        type: event.type,
        input: event.input,
        payload: event.payload,
        meta: event.meta,
        occurredAt: normalizeDate(event.occurredAt),
        receivedAt: nowIso(),
      };

      state.events.push(storedEvent);

      for (const client of this.clients) {
        for (const handler of client.handlers.filter((candidate) => candidate.channelId === channelId)) {
          const duplicateDelivery = state.deliveries.some(
            (delivery) =>
              delivery.eventId === storedEvent.id &&
              delivery.clientId === client.id &&
              delivery.handlerId === handler.id,
          );
          if (duplicateDelivery) continue;
          state.deliveries.push({
            id: newId("deliv"),
            eventId: storedEvent.id,
            channelId,
            clientId: client.id,
            handlerId: handler.id,
            status: "pending",
            attempts: 0,
            maxAttempts: Math.max(1, handler.retries.attempts ?? this.options.config.retries?.attempts ?? 3),
            createdAt: nowIso(),
            updatedAt: nowIso(),
          });
        }
      }

      await this.store.write(state);
      return { status: "queued", eventId: storedEvent.id };
    });
  }

  async listSessions(): Promise<StoredSession[]> {
    const state = await this.store.read();
    return state.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getSession(idOrKey: string): Promise<StoredSession | undefined> {
    const state = await this.store.read();
    return state.sessions.find((session) => session.id === idOrKey || session.key === idOrKey);
  }

  async listSessionNotes(idOrKey: string): Promise<SessionNote[]> {
    const state = await this.store.read();
    const session = state.sessions.find((candidate) => candidate.id === idOrKey || candidate.key === idOrKey);
    if (!session) return [];
    return state.notes
      .filter((note) => note.sessionId === session.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async endSession(idOrKey: string, reason = "manual"): Promise<boolean> {
    return this.mutex.run(async () => {
      const state = await this.store.read();
      const session = state.sessions.find((candidate) => candidate.id === idOrKey || candidate.key === idOrKey);
      if (!session) return false;
      session.status = "ended";
      session.endedAt = nowIso();
      session.endReason = reason;
      session.updatedAt = nowIso();
      await this.store.write(state);
      return true;
    });
  }

  async listEvents(): Promise<{ event: StoredEvent; deliveries: StoredDelivery[] }[]> {
    const state = await this.store.read();
    return state.events
      .map((event) => ({
        event,
        deliveries: state.deliveries.filter((delivery) => delivery.eventId === event.id),
      }))
      .sort((a, b) => b.event.receivedAt.localeCompare(a.event.receivedAt));
  }

  async retryDelivery(id: string): Promise<boolean> {
    return this.mutex.run(async () => {
      const state = await this.store.read();
      const delivery = state.deliveries.find((candidate) => candidate.id === id);
      if (!delivery || delivery.status !== "failed") return false;
      delivery.status = "pending";
      delivery.maxAttempts = Math.max(delivery.maxAttempts, delivery.attempts + 1);
      delivery.lastError = undefined;
      delivery.processedAt = undefined;
      delivery.updatedAt = nowIso();
      await this.store.write(state);
      return true;
    });
  }

  async printConfig(): Promise<Record<string, unknown>> {
    await this.init();
    const state = await this.store.read();
    return {
      projectRoot: this.project.root,
      orchestratorDir: this.project.orchestratorDir,
      store: this.store.name,
      channels: this.channels.map((channel) => channel.id),
      clients: this.clients.map((client) => client.id),
      sessions: state.sessions.length,
      events: state.events.length,
      deliveries: state.deliveries.length,
    };
  }

  private printStartupSummary(): void {
    this.logger.info("Starting Simple Agent Orchestrator", {
      projectRoot: this.project.root,
      orchestratorDir: this.project.orchestratorDir,
      store: this.store.name,
      channels: this.channels.map((channel) => channel.id).join(", ") || "none",
      clients: this.clients.map((client) => client.id).join(", ") || "none",
    });
  }

  private async ensureRuntimeOwnership(): Promise<void> {
    const lockPath = this.store.runtimeLockPath;
    if (!lockPath || this.ownership) return;
    this.ownershipPromise ??= acquireRuntimeOwnership(lockPath);
    try {
      this.ownership = await this.ownershipPromise;
    } finally {
      this.ownershipPromise = undefined;
    }
  }

  private async releaseRuntimeOwnership(): Promise<void> {
    const ownership = this.ownership;
    if (!ownership) return;
    await ownership.release();
    if (this.ownership === ownership) this.ownership = undefined;
  }

  private startPollers(): void {
    for (const channel of this.channels) {
      channel.polls.forEach((poll, index) => {
        if (poll.immediate ?? true) void this.schedulePoll(channel, poll, index);
        const interval = setInterval(() => {
          void this.schedulePoll(channel, poll, index);
        }, parseDuration(poll.every));
        this.intervalHandles.push(interval);
      });
    }
  }

  private async runAllPollsOnce(): Promise<void> {
    for (const channel of this.channels) {
      for (let index = 0; index < channel.polls.length; index += 1) {
        const poll = channel.polls[index]!;
        await this.schedulePoll(channel, poll, index);
      }
    }
  }

  private schedulePoll(channel: ChannelDefinition, poll: PollDefinition, index: number): Promise<void> {
    const cursorId = `${channel.id}:${index}`;
    const existing = this.pollPromises.get(cursorId);
    if (existing) return existing;
    const promise = this.runPoll(channel, poll, index).finally(() => {
      if (this.pollPromises.get(cursorId) === promise) this.pollPromises.delete(cursorId);
    });
    this.pollPromises.set(cursorId, promise);
    return promise;
  }

  private async runPoll(channel: ChannelDefinition, poll: PollDefinition, index: number): Promise<void> {
    const cursorId = `${channel.id}:${index}`;
    const signal = this.abortController.signal;
    if (signal.aborted) return;

    try {
      const cursorState = await this.mutex.run(async () => {
        const state = await this.store.read();
        state.cursors[cursorId] ??= {};
        await this.store.write(state);
        return { ...state.cursors[cursorId] };
      });

      const cursor = new CursorImpl(cursorState);
      const channelApi = {
        id: channel.id,
        dispatch: (event: DispatchEvent) => this.dispatch(channel.id, event),
      };
      const ctx = { channel: channelApi, cursor, project: this.project, logger: this.logger, signal };
      const items = await poll.fetch(ctx);
      const events: DispatchEvent[] = [];

      if (poll.map) {
        for (const item of items) {
          const mapped = await poll.map(item, ctx);
          if (mapped) {
            events.push(mapped);
            await channelApi.dispatch(mapped);
          }
        }
      }

      await poll.commit?.({ ...ctx, items, events });

      await this.mutex.run(async () => {
        const state = await this.store.read();
        state.cursors[cursorId] = cursor.entries();
        await this.store.write(state);
      });
    } catch (error) {
      this.logger.error(`Poll failed for channel ${channel.id}`, { error: formatError(error) });
    }
  }

  private startWorkers(): void {
    for (const client of this.clients) {
      for (let i = 0; i < client.concurrencyOptions.workers; i += 1) {
        this.workerPromises.push(this.workerLoop(client));
      }
    }
  }

  private async workerLoop(client: ClientDefinition): Promise<void> {
    const signal = this.abortController.signal;
    while (!signal.aborted) {
      const processed = await this.processNextDelivery(client);
      if (!processed) {
        try {
          await delay(500, signal);
        } catch {
          break;
        }
      }
    }
  }

  private async processNextDelivery(client: ClientDefinition): Promise<boolean> {
    const claimed = await this.claimNextDelivery(client);
    if (!claimed) return false;

    const releaseSessionKey = claimed.client.concurrencyOptions.perSession
      ? claimed.event.sessionKey
      : undefined;

    try {
      await this.runClaimedDelivery(claimed);
    } finally {
      if (releaseSessionKey) this.processingSessionKeys.delete(releaseSessionKey);
    }

    return true;
  }

  private async claimNextDelivery(client: ClientDefinition): Promise<ClaimedDelivery | undefined> {
    return this.mutex.run(async () => {
      const state = await this.store.read();
      for (const delivery of state.deliveries) {
        if (delivery.clientId !== client.id) continue;
        if (delivery.status !== "pending") continue;
        const event = state.events.find((candidate) => candidate.id === delivery.eventId);
        if (!event) continue;
        if (client.concurrencyOptions.perSession && this.processingSessionKeys.has(event.sessionKey)) continue;
        const handler = client.handlers.find((candidate) => candidate.id === delivery.handlerId);
        if (!handler) continue;

        delivery.status = "processing";
        delivery.attempts += 1;
        delivery.startedAt = nowIso();
        delivery.updatedAt = nowIso();
        if (client.concurrencyOptions.perSession) this.processingSessionKeys.add(event.sessionKey);
        await this.store.write(state);
        return { delivery: { ...delivery }, event: { ...event }, handler, client };
      }
      return undefined;
    });
  }

  private async runClaimedDelivery(claimed: ClaimedDelivery): Promise<void> {
    const { client, delivery, event, handler } = claimed;
    let sessionImpl: SessionImpl | undefined;
    let handlerContext: HandlerContext | undefined;

    try {
      const session = await this.resolveSession(event.sessionKey, delivery.id);
      sessionImpl = new SessionImpl(session, (sessionInstance, name, factory) =>
        this.coordinateEnsure(sessionInstance, name, factory),
      );

      const environment = await this.getMountedEnvironment(client);
      await this.ensureSandbox(client, environment, sessionImpl, event);

      const orchestratorEvent = this.toRuntimeEvent(event);
      handlerContext = {
        event: orchestratorEvent,
        session: sessionImpl,
        environment,
        client,
        project: this.project,
        logger: this.logger,
        attempt: delivery.attempts,
        signal: this.abortController.signal,
      };

      await handler.handle(handlerContext);
      await handler.onSuccess?.(handlerContext);

      if (sessionImpl.status === "ended") {
        await this.cleanupSandbox(client, environment, sessionImpl, event);
      }

      await this.persistSuccess(delivery.id, sessionImpl);
    } catch (error) {
      if (handlerContext) {
        try {
          await handler.onFailure?.({ ...handlerContext, error });
        } catch (onFailureError) {
          this.logger.warn("onFailure hook failed", { error: formatError(onFailureError) });
        }
      }
      await this.persistFailure(delivery.id, error);
    }
  }

  private toRuntimeEvent(event: StoredEvent): OrchestratorEvent {
    const dedupePrefix = `${event.channelId}:`;
    return {
      id: event.sourceId,
      channelId: event.channelId,
      dedupeKey: event.dedupeKey.startsWith(dedupePrefix)
        ? event.dedupeKey.slice(dedupePrefix.length)
        : event.dedupeKey,
      sessionKey: event.sessionKey,
      type: event.type,
      input: event.input,
      payload: event.payload,
      meta: event.meta,
      occurredAt: event.occurredAt,
      receivedAt: event.receivedAt,
    };
  }

  private async resolveSession(sessionKey: string, deliveryId: string): Promise<StoredSession> {
    return this.mutex.run(async () => {
      const state = await this.store.read();
      let session = state.sessions.find((candidate) => candidate.key === sessionKey && candidate.status === "active");
      if (!session) {
        session = createStoredSession(sessionKey);
        state.sessions.push(session);
      }
      const delivery = state.deliveries.find((candidate) => candidate.id === deliveryId);
      if (delivery) {
        delivery.sessionId = session.id;
        delivery.updatedAt = nowIso();
      }
      await this.store.write(state);
      return { ...session, state: { ...session.state } };
    });
  }

  private async coordinateEnsure<T>(
    session: SessionImpl,
    name: string,
    factory: () => Promise<T> | T,
  ): Promise<T> {
    const lockKey = `${session.id}:${name}`;
    const existing = this.ensureLocks.get(lockKey) as Promise<T> | undefined;
    if (existing) {
      const value = await existing;
      session.set(name, value);
      return value;
    }

    const promise = (async () => {
      const storedValue = await this.mutex.run(async () => {
        const state = await this.store.read();
        const stored = state.sessions.find((candidate) => candidate.id === session.id);
        return stored && name in stored.state ? (stored.state[name] as T) : undefined;
      });

      if (storedValue !== undefined) return storedValue;

      const created = await factory();
      await this.mutex.run(async () => {
        const state = await this.store.read();
        const stored = state.sessions.find((candidate) => candidate.id === session.id);
        if (stored) {
          stored.state[name] = created;
          stored.updatedAt = nowIso();
          await this.store.write(state);
        }
      });
      return created;
    })();

    this.ensureLocks.set(lockKey, promise);
    try {
      const value = await promise;
      session.set(name, value);
      return value;
    } finally {
      this.ensureLocks.delete(lockKey);
    }
  }

  private async persistSuccess(deliveryId: string, session: SessionImpl): Promise<void> {
    await this.mutex.run(async () => {
      const state = await this.store.read();
      this.mergeSession(state, session);
      state.notes.push(...session.drainNotes());
      const delivery = state.deliveries.find((candidate) => candidate.id === deliveryId);
      if (delivery) {
        delivery.status = "processed";
        delivery.processedAt = nowIso();
        delivery.updatedAt = nowIso();
        delivery.lastError = undefined;
      }
      await this.store.write(state);
    });
    session.clearMutations();
  }

  private async persistFailure(deliveryId: string, error: unknown): Promise<void> {
    await this.mutex.run(async () => {
      const state = await this.store.read();
      const delivery = state.deliveries.find((candidate) => candidate.id === deliveryId);
      if (delivery) {
        delivery.status = delivery.attempts >= delivery.maxAttempts ? "failed" : "pending";
        delivery.lastError = formatError(error);
        delivery.updatedAt = nowIso();
      }
      await this.store.write(state);
    });
  }

  private async mountAllEnvironments(): Promise<void> {
    for (const client of this.clients) {
      await this.getMountedEnvironment(client);
    }
  }

  private async getMountedEnvironment(client: ClientDefinition): Promise<EnvironmentInstance> {
    const definition = client.environment ?? createEmptyEnvironment();
    const key = `${client.id}:${definition.id}`;
    const existing = this.environmentInstances.get(key);
    if (existing) return existing;
    const existingMount = this.environmentMounts.get(key);
    if (existingMount) return existingMount;

    const mounting = this.mountEnvironment(key, definition);
    this.environmentMounts.set(key, mounting);
    try {
      return await mounting;
    } finally {
      if (this.environmentMounts.get(key) === mounting) this.environmentMounts.delete(key);
    }
  }

  private async mountEnvironment(key: string, definition: EnvironmentDefinition): Promise<EnvironmentInstanceImpl> {
    const instance = new EnvironmentInstanceImpl(definition.id);
    try {
      for (const hook of definition.mountHooks) {
        await hook({
          environment: instance,
          project: this.project,
          logger: this.logger,
          signal: this.abortController.signal,
        });
      }
    } catch (error) {
      for (const hook of [...definition.unmountHooks].reverse()) {
        try {
          await hook({ environment: instance, project: this.project, logger: this.logger, signal: this.abortController.signal });
        } catch (rollbackError) {
          this.logger.warn("Environment rollback failed", { error: formatError(rollbackError) });
        }
      }
      throw error;
    }
    this.environmentInstances.set(key, instance);
    return instance;
  }

  private async unmountAllEnvironments(): Promise<void> {
    for (const client of this.clients) {
      const definition = client.environment ?? createEmptyEnvironment();
      const instance = this.environmentInstances.get(`${client.id}:${definition.id}`);
      if (!instance) continue;
      for (const hook of [...definition.unmountHooks].reverse()) {
        await hook({
          environment: instance,
          project: this.project,
          logger: this.logger,
          signal: this.abortController.signal,
        });
      }
      this.environmentInstances.delete(`${client.id}:${definition.id}`);
    }
  }

  private async ensureSandbox(
    client: ClientDefinition,
    environment: EnvironmentInstance,
    session: SessionImpl,
    event: StoredEvent,
  ): Promise<void> {
    const definition = client.environment;
    if (!definition?.sandbox) return;
    const flag = `__sao.sandbox.${definition.id}.created`;
    await this.withSandboxLock(`${session.id}:${flag}`, async () => {
      await this.refreshSessionState(session);
      if (session.getOptional<boolean>(flag)) return;
      await definition.sandbox!.create(this.sandboxContext(environment, session, event));
      session.set(flag, true);
      await this.persistSessionMutations(session);
    });
  }

  private async cleanupSandbox(
    client: ClientDefinition,
    environment: EnvironmentInstance,
    session: SessionImpl,
    event: StoredEvent,
  ): Promise<void> {
    const definition = client.environment;
    if (!definition?.sandbox?.cleanup) return;
    const flag = `__sao.sandbox.${definition.id}.created`;
    await this.withSandboxLock(`${session.id}:${flag}`, async () => {
      await this.refreshSessionState(session);
      if (!session.getOptional<boolean>(flag)) return;
      await definition.sandbox!.cleanup!(this.sandboxContext(environment, session, event));
      session.set(flag, false);
      await this.persistSandboxFlag(session, flag, false);
    });
  }

  private sandboxContext(
    environment: EnvironmentInstance,
    session: SessionImpl,
    event: StoredEvent,
  ): SandboxContext {
    return {
      environment,
      project: this.project,
      logger: this.logger,
      signal: this.abortController.signal,
      session,
      event: this.toRuntimeEvent(event),
    };
  }

  private validateConfiguration(): void {
    this.assertUnique(this.channels.map(({ id }) => id), "channel");
    this.assertUnique(this.clients.map(({ id }) => id), "client");
    for (const client of this.clients) {
      this.assertUnique(client.handlers.map(({ id }) => id), "handler", ` for client ${client.id}`);
    }
  }

  private assertUnique(ids: string[], kind: string, suffix = ""): void {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) throw new Error(`Duplicate ${kind} id${suffix}: ${id}`);
      seen.add(id);
    }
  }

  private mergeSession(state: OrchestratorState, session: SessionImpl): StoredSession {
    const snapshot = session.toStored();
    let stored = state.sessions.find((candidate) => candidate.id === snapshot.id);
    if (!stored) {
      stored = { ...snapshot, state: {} };
      state.sessions.push(stored);
    }
    for (const mutation of session.pendingMutations()) {
      if (mutation.type === "set") stored.state[mutation.name] = mutation.value;
      else delete stored.state[mutation.name];
    }
    if (stored.status !== "ended" && snapshot.status === "ended") {
      stored.status = "ended";
      stored.endedAt = snapshot.endedAt;
      stored.endReason = snapshot.endReason;
    }
    stored.updatedAt = nowIso();
    return stored;
  }

  private async persistSessionMutations(session: SessionImpl): Promise<void> {
    await this.mutex.run(async () => {
      const state = await this.store.read();
      this.mergeSession(state, session);
      await this.store.write(state);
    });
    session.clearMutations();
  }

  private async persistSandboxFlag(session: SessionImpl, flag: string, value: boolean): Promise<void> {
    await this.mutex.run(async () => {
      const state = await this.store.read();
      const stored = state.sessions.find((candidate) => candidate.id === session.id);
      if (stored) {
        stored.state[flag] = value;
        stored.updatedAt = nowIso();
        await this.store.write(state);
      }
    });
    session.clearMutation(flag);
  }

  private async refreshSessionState(session: SessionImpl): Promise<void> {
    const state = await this.mutex.run(() => this.store.read());
    const stored = state.sessions.find((candidate) => candidate.id === session.id);
    if (stored) session.mergeStoredState(stored.state);
  }

  private async withSandboxLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.sandboxLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.sandboxLocks.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.sandboxLocks.get(key) === tail) this.sandboxLocks.delete(key);
    }
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
}
