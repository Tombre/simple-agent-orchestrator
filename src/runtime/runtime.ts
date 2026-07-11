import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ChannelDefinition, PollDefinition } from "../core/channel.js";
import { CursorImpl, pollCursorId } from "../core/channel.js";
import { bindChannelRuntime, unbindChannelRuntime } from "../core/channel-bindings.js";
import type { ClientDefinition, HandlerContext, RegisteredHandler } from "../core/client.js";
import type { EnvironmentDefinition, EnvironmentInstance, SandboxContext } from "../core/environment.js";
import { createEmptyEnvironment, EnvironmentInstanceImpl } from "../core/environment.js";
import type { OrchestratorConfig } from "../core/config.js";
import { HandlerTimeoutError } from "../core/errors.js";
import { createStoredSession, SessionImpl } from "../core/session.js";
import type {
  DispatchEvent,
  DispatchResult,
  JsonRecord,
  JsonValue,
  Logger,
  OrchestratorEvent,
  OrchestratorState,
  ProjectContext,
  SessionNote,
  StoredCapacityReservation,
  StoredDelivery,
  StoredEvent,
  StoredSession,
} from "../core/types.js";
import { memoryStore, type Store } from "../stores/index.js";
import { StoreMutex } from "../stores/store.js";
import { newId } from "../utils/id.js";
import { consoleLogger } from "../utils/logger.js";
import {
  isSupportedRetryDelay,
  MAX_DATE_TIMESTAMP,
  MAX_TIMER_DURATION_MS,
  nowIso,
  parseDuration,
} from "../utils/time.js";
import { acquireRuntimeOwnership, type RuntimeOwnership } from "./ownership.js";
import {
  applyStatePrune,
  planStatePrune,
  type StatePruneOptions,
  type StatePrunePlan,
} from "./state-retention.js";

export interface RuntimeOptions {
  project: ProjectContext;
  config: OrchestratorConfig;
}

export interface StartOptions {
  drain?: boolean;
  prettyStartupLog?: boolean;
  http?: boolean;
}

export interface OfflineOperationContext {
  dispatch(channel: ChannelDefinition | string, event: DispatchEvent): Promise<DispatchResult>;
  drain(): Promise<void>;
  endSession(idOrKey: string, reason?: string): Promise<boolean>;
  releaseCapacity(clientId: string, sessionIdOrKey: string): Promise<boolean>;
  retryDelivery(id: string): Promise<boolean>;
  pruneState(options: StatePruneOptions): Promise<StatePrunePlan>;
}

interface RuntimeChannel {
  readonly definition: ChannelDefinition;
  readonly id: string;
  readonly polls: readonly PollDefinition[];
}

interface RuntimeClient extends ClientDefinition {
  readonly definition: ClientDefinition;
}

interface ClaimedDelivery {
  delivery: StoredDelivery;
  event: StoredEvent;
  session: StoredSession;
  handler: RegisteredHandler;
  client: RuntimeClient;
}

type RuntimeLifecycleState = "unused" | "starting" | "started" | "drain" | "stopping" | "stopped";

interface MountedEnvironment {
  instance: EnvironmentInstanceImpl;
  pendingUnmountHooks: Array<(ctx: Parameters<EnvironmentDefinition["unmountHooks"][number]>[0]) => Promise<void> | void>;
}

interface HttpRequestToken {
  active: boolean;
}

const DEFAULT_HTTP_HOSTNAME = "127.0.0.1";
const DEFAULT_HTTP_PORT = 3_000;
const MAX_HTTP_PORT_ATTEMPTS = 10;
const WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;
const WEBHOOK_IDENTIFIER_LIMIT = 512;
const WEBHOOK_TYPE_LIMIT = 256;
const MAX_JSON_NESTING_DEPTH = 100;
const DEFAULT_OPERATIONAL_LIMIT = 25;
const MAX_OPERATIONAL_LIMIT = 100;

interface DeliveryCounts {
  pending: number;
  processing: number;
  processed: number;
  failed: number;
}

class WebhookValidationError extends Error {}

function emptyDeliveryCounts(): DeliveryCounts {
  return { pending: 0, processing: 0, processed: 0, failed: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateJsonValue(value: unknown, depth = 0): asserts value is JsonValue {
  if (depth > MAX_JSON_NESTING_DEPTH) throw new WebhookValidationError("JSON nesting is too deep.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new WebhookValidationError("Numbers must be finite.");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJsonValue(item, depth + 1);
    return;
  }
  if (!isRecord(value)) throw new WebhookValidationError("Values must be JSON-safe.");
  for (const item of Object.values(value)) validateJsonValue(item, depth + 1);
}

function validateOptionalString(
  value: Record<string, unknown>,
  field: string,
  maximumLength: number,
): string | undefined {
  const item = value[field];
  if (item === undefined) return undefined;
  if (typeof item !== "string") throw new WebhookValidationError(`${field} must be a string.`);
  if (item.length > maximumLength) {
    throw new WebhookValidationError(`${field} must not exceed ${maximumLength} characters.`);
  }
  return item;
}

function validateWebhookEvent(value: unknown): DispatchEvent<JsonValue, JsonValue, JsonRecord> {
  if (!isRecord(value)) throw new WebhookValidationError("The request body must be an object.");
  const allowed = new Set(["id", "type", "dedupeKey", "sessionKey", "input", "payload", "meta", "occurredAt"]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new WebhookValidationError("The request body contains an unknown field.");
  }

  const id = validateOptionalString(value, "id", WEBHOOK_IDENTIFIER_LIMIT);
  if (id === undefined || id.trim().length === 0) throw new WebhookValidationError("id must be a non-empty string.");
  const type = validateOptionalString(value, "type", WEBHOOK_TYPE_LIMIT);
  const dedupeKey = validateOptionalString(value, "dedupeKey", WEBHOOK_IDENTIFIER_LIMIT);
  const sessionKey = validateOptionalString(value, "sessionKey", WEBHOOK_IDENTIFIER_LIMIT);
  const occurredAt = validateOptionalString(value, "occurredAt", WEBHOOK_IDENTIFIER_LIMIT);
  if (occurredAt !== undefined && !Number.isFinite(Date.parse(occurredAt))) {
    throw new WebhookValidationError("occurredAt must be a valid date string.");
  }
  if (value.input !== undefined) validateJsonValue(value.input);
  if (value.payload !== undefined) validateJsonValue(value.payload);
  if (value.meta !== undefined) {
    if (!isRecord(value.meta)) throw new WebhookValidationError("meta must be an object.");
    validateJsonValue(value.meta);
  }

  return {
    id,
    ...(type === undefined ? {} : { type }),
    ...(dedupeKey === undefined ? {} : { dedupeKey }),
    ...(sessionKey === undefined ? {} : { sessionKey }),
    ...(value.input === undefined ? {} : { input: value.input }),
    ...(value.payload === undefined ? {} : { payload: value.payload }),
    ...(value.meta === undefined ? {} : { meta: value.meta as JsonRecord }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
  };
}

function parseOperationalLimit(url: string): number {
  const values = new URL(url).searchParams.getAll("limit");
  if (values.length === 0) return DEFAULT_OPERATIONAL_LIMIT;
  if (values.length !== 1 || !/^[1-9][0-9]*$/.test(values[0]!)) {
    throw new Error("invalid-limit");
  }
  const limit = Number(values[0]);
  if (limit > MAX_OPERATIONAL_LIMIT) throw new Error("invalid-limit");
  return limit;
}

function selectNewest<T>(
  items: readonly T[],
  limit: number,
  timestamp: (item: T) => string,
  id: (item: T) => string,
): T[] {
  const selected: T[] = [];
  const compare = (left: T, right: T) =>
    timestamp(right).localeCompare(timestamp(left)) || id(right).localeCompare(id(left));
  for (const item of items) {
    let low = 0;
    let high = selected.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (compare(item, selected[middle]!) < 0) high = middle;
      else low = middle + 1;
    }
    selected.splice(low, 0, item);
    if (selected.length > limit) selected.pop();
  }
  return selected;
}

function parseHttpPort(value: number | string, source: string): number {
  const valid = typeof value === "number"
    ? Number.isInteger(value)
    : /^[0-9]+$/.test(value);
  const port = valid ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid HTTP port${source ? ` in ${source}` : ""}: ${String(value)}`);
  }
  return port;
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

function isServerNotRunning(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ERR_SERVER_NOT_RUNNING";
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true;
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  const parts = ipv4.split(".");
  return parts.length === 4 && parts[0] === "127";
}

function formatHttpUrl(hostname: string, port: number): string {
  const urlHostname = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return `http://${urlHostname}:${port}`;
}

interface AttemptSignal {
  readonly signal: AbortSignal;
  readonly timeoutError: HandlerTimeoutError | undefined;
  cancelTimeout(): void;
  dispose(): void;
  throwIfTimedOut(): void;
}

function parseRetryDelay(value: number | string): number {
  const duration = parseDuration(value);
  const normalized = duration > 0 ? Math.ceil(duration) : 0;
  if (!isSupportedRetryDelay(normalized)) {
    throw new Error(`Invalid retry delay: ${String(value)} exceeds the supported range`);
  }
  return normalized;
}

function parseHandlerTimeout(value: number | string): number {
  const duration = parseDuration(value);
  const normalized = duration > 0 ? Math.ceil(duration) : 0;
  if (normalized > MAX_TIMER_DURATION_MS) {
    throw new Error(`Invalid handler timeout: ${String(value)} exceeds the supported range`);
  }
  return normalized;
}

function createAttemptSignal(runtimeSignal: AbortSignal, timeoutMs: number): AttemptSignal {
  const controller = new AbortController();
  let timeoutError: HandlerTimeoutError | undefined;
  let timer: NodeJS.Timeout | undefined;

  const onRuntimeAbort = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    controller.abort(runtimeSignal.reason);
  };

  if (runtimeSignal.aborted) {
    onRuntimeAbort();
  } else {
    runtimeSignal.addEventListener("abort", onRuntimeAbort, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timer = undefined;
        timeoutError = new HandlerTimeoutError(timeoutMs);
        controller.abort(timeoutError);
      }, timeoutMs);
      timer.unref();
    }
  }

  return {
    signal: controller.signal,
    get timeoutError() {
      return timeoutError;
    },
    cancelTimeout() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    dispose() {
      this.cancelTimeout();
      runtimeSignal.removeEventListener("abort", onRuntimeAbort);
    },
    throwIfTimedOut() {
      if (timeoutError) throw timeoutError;
    },
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Aborted"));
  return new Promise((resolveDelay, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
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

function snapshotEnvironment(definition: EnvironmentDefinition | undefined): EnvironmentDefinition | undefined {
  if (!definition) return undefined;
  return {
    id: definition.id,
    mountHooks: [...definition.mountHooks],
    unmountHooks: [...definition.unmountHooks],
    ...(definition.sandbox ? { sandbox: { ...definition.sandbox } } : {}),
  };
}

function snapshotClient(client: ClientDefinition): RuntimeClient {
  return {
    definition: client,
    id: client.id,
    handlers: client.handlers.map((handler) => ({
      ...handler,
      retries: { ...handler.retries },
    })),
    ...(client.environment ? { environment: snapshotEnvironment(client.environment) } : {}),
    ...(client.capacityOptions ? { capacityOptions: { ...client.capacityOptions } } : {}),
    concurrencyOptions: { ...client.concurrencyOptions },
    retryOptions: { ...client.retryOptions },
    ...(client.timeout === undefined ? {} : { timeout: client.timeout }),
  };
}

export class OrchestratorRuntime {
  private readonly sourceOptions: RuntimeOptions;
  private options: RuntimeOptions;
  private readonly defaultStore = memoryStore();
  private store: Store;
  private channels: RuntimeChannel[] = [];
  private clients: RuntimeClient[] = [];
  private logger: Logger;
  private readonly mutex = new StoreMutex();
  private readonly abortController = new AbortController();
  private readonly httpRequestContext = new AsyncLocalStorage<HttpRequestToken>();
  private readonly httpRequests = new Set<Promise<void>>();
  private readonly httpDispatches = new Set<Promise<unknown>>();
  private readonly mutationPromises = new Set<Promise<unknown>>();
  private readonly environmentInstances = new Map<string, MountedEnvironment>();
  private readonly environmentMounts = new Map<string, Promise<EnvironmentInstanceImpl>>();
  private readonly intervalHandles: NodeJS.Timeout[] = [];
  private readonly workerPromises: Promise<void>[] = [];
  private readonly pollPromises = new Map<string, Promise<void>>();
  private readonly processingSessionKeys = new Set<string>();
  private readonly ensureLocks = new Map<string, Promise<unknown>>();
  private readonly sandboxLocks = new Map<string, Promise<void>>();
  private ownership: RuntimeOwnership | undefined;
  private ownershipPromise: Promise<RuntimeOwnership> | undefined;
  private lifecycleState: RuntimeLifecycleState = "unused";
  private drainInProgress = false;
  private stopPromise: Promise<void> | undefined;
  private offlineOperationActive = false;
  private initialized = false;
  private initPromise: Promise<void> | undefined;
  private storePrepared = false;
  private httpServer: Server | undefined;
  private httpAccepting = false;
  private httpReady = false;
  private httpAddress: { hostname: string; port: number } | undefined;
  private runtimeStartedAt: number | undefined;

  constructor(options: RuntimeOptions) {
    this.sourceOptions = options;
    this.options = options;
    this.store = this.defaultStore;
    this.logger = consoleLogger;
  }

  get project(): ProjectContext {
    return this.options.project;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.lifecycleState === "stopping" || this.lifecycleState === "stopped") {
      throw new Error("Cannot initialize a runtime after the runtime has been stopped");
    }
    if (this.initPromise) return this.initPromise;
    const initializing = (async () => {
      this.prepareStore();
      this.compileConfiguration();
      this.validateConfiguration();
      await this.store.init();
      await this.store.read();
      if (this.lifecycleState === "stopping" || this.lifecycleState === "stopped") {
        throw new Error("Runtime stopped during initialization");
      }
      try {
        for (const channel of this.channels) {
          bindChannelRuntime(channel.definition, this, (event) => this.dispatch(channel.definition, event));
        }
        this.initialized = true;
      } catch (error) {
        for (const channel of this.channels) unbindChannelRuntime(channel.definition, this);
        throw error;
      }
    })();
    this.initPromise = initializing;
    try {
      await initializing;
    } finally {
      if (this.initPromise === initializing) this.initPromise = undefined;
    }
  }

  private compileConfiguration(): void {
    const source = this.sourceOptions.config;
    const clients = [...(source.clients ?? [])];
    const channels = [...(source.channels ?? [])];
    const channelDefinitions = new Set(channels);
    for (const client of clients) {
      for (const handler of client.handlers) {
        if (channelDefinitions.has(handler.channel)) continue;
        channelDefinitions.add(handler.channel);
        channels.push(handler.channel);
      }
    }
    const config: OrchestratorConfig = {
      ...source,
      store: this.store,
      channels,
      clients,
      ...(source.retries ? { retries: { ...source.retries } } : {}),
      ...(source.http ? { http: { ...source.http } } : {}),
    };
    this.options = { project: this.sourceOptions.project, config };
    this.channels = (config.channels ?? []).map((definition) => ({
      definition,
      id: definition.id,
      polls: definition.polls.map((poll) => ({ ...poll })),
    }));
    this.clients = (config.clients ?? []).map(snapshotClient);
    this.logger = config.logger ?? consoleLogger;
  }

  private prepareStore(): void {
    if (this.storePrepared) return;
    this.store = this.sourceOptions.config.store ?? this.defaultStore;
    this.storePrepared = true;
  }

  async start(options: StartOptions = {}): Promise<void> {
    this.claimStart();
    this.runtimeStartedAt = Date.now();
    let startupError: unknown;
    let startupFailed = false;
    try {
      await this.ensureRuntimeOwnership();
      await this.init();
      if (options.prettyStartupLog ?? true) this.printStartupSummary();

      if (options.drain) {
        await this.runAllPollsOnce();
        await this.drainOwned();
      } else {
        await this.recoverInterruptedDeliveries();
        await this.mountAllEnvironments();
        if (options.http !== false && this.options.config.http?.enabled !== false) await this.startHttpServer();
        this.startPollers();
        this.startWorkers();
      }
    } catch (error) {
      startupFailed = true;
      startupError = error;
    }

    if (startupFailed) {
      try {
        await this.shutdown();
      } catch (shutdownError) {
        throw new AggregateError([startupError, shutdownError], "Runtime startup and shutdown failed");
      }
      throw startupError;
    }

    if (options.drain) {
      await this.shutdown();
      return;
    }
    this.lifecycleState = "started";
    this.httpReady = this.httpServer !== undefined;
  }

  async stop(): Promise<void> {
    if (this.offlineOperationActive) throw new Error("Cannot stop a runtime during an active offline operation");
    if (this.lifecycleState === "starting") throw new Error("Cannot stop a runtime while the runtime is starting");
    if (this.drainInProgress) throw new Error("Cannot stop a runtime while a drain is in progress");
    await this.shutdown();
  }

  private async shutdown(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.lifecycleState = "stopping";
    const stopping = this.stopInternal();
    this.stopPromise = stopping;
    try {
      await stopping;
    } finally {
      this.lifecycleState = "stopped";
      if (this.stopPromise === stopping) this.stopPromise = undefined;
    }
  }

  private async stopInternal(): Promise<void> {
    if (this.initPromise) await Promise.allSettled([this.initPromise]);
    for (const channel of this.channels) unbindChannelRuntime(channel.definition, this);
    const httpClose = this.closeHttpServer();
    this.abortController.abort();
    for (const handle of this.intervalHandles) clearInterval(handle);
    this.intervalHandles.length = 0;
    await Promise.allSettled(this.pollPromises.values());
    await Promise.allSettled(this.workerPromises);
    let httpError: unknown;
    let httpFailed = false;
    try {
      await httpClose;
    } catch (error) {
      httpFailed = true;
      httpError = error;
    }
    await this.settleMutationWork();
    let unmountError: unknown;
    let unmountFailed = false;
    try {
      await this.unmountAllEnvironments();
    } catch (error) {
      unmountFailed = true;
      unmountError = error;
    }
    let releaseError: unknown;
    let releaseFailed = false;
    try {
      await this.releaseRuntimeOwnership();
    } catch (error) {
      releaseFailed = true;
      releaseError = error;
    }
    const errors: unknown[] = [];
    if (httpFailed) errors.push(httpError);
    if (unmountFailed) errors.push(unmountError);
    if (releaseFailed) errors.push(releaseError);
    if (errors.length > 1) throw new AggregateError(errors, "Runtime shutdown failed");
    if (errors.length === 1) throw errors[0];
  }

  private async startHttpServer(): Promise<void> {
    const http = this.options.config.http;
    const hostname = http?.hostname ?? DEFAULT_HTTP_HOSTNAME;
    const environmentPort = process.env.SAO_HTTP_PORT;
    const requestedPort = environmentPort === undefined
      ? (http?.port ?? DEFAULT_HTTP_PORT)
      : parseHttpPort(environmentPort, "SAO_HTTP_PORT");
    const app = new Hono();
    const dispatch = (channelId: string, event: DispatchEvent) => {
      if (!this.httpAccepting && this.httpRequestContext.getStore()?.active !== true) {
        return Promise.reject(new Error("HTTP server is not accepting requests"));
      }
      const pending = this.dispatch(channelId, event);
      this.httpDispatches.add(pending);
      void pending.then(
        () => this.httpDispatches.delete(pending),
        () => this.httpDispatches.delete(pending),
      );
      return pending;
    };
    const context = { app, project: this.project, logger: this.logger, signal: this.abortController.signal, dispatch };

    app.use("*", async (honoContext, next) => {
      if (!this.httpAccepting) return honoContext.json({ status: "stopping" }, 503);
      const token: HttpRequestToken = { active: true };
      const request = this.httpRequestContext.run(token, async () => {
        try {
          await next();
        } finally {
          token.active = false;
        }
      });
      this.httpRequests.add(request);
      try {
        await request;
      } finally {
        this.httpRequests.delete(request);
      }
    });
    await http?.middleware?.(context);
    app.get("/health", (honoContext) => this.httpReady
      ? honoContext.json({ status: "ok" })
      : honoContext.json({ status: "starting" }, 503));
    app.all("/health", (honoContext) => honoContext.notFound());
    app.post(
      "/webhooks/:channelId",
      bodyLimit({
        maxSize: WEBHOOK_BODY_LIMIT_BYTES,
        onError: (honoContext) => honoContext.json({
          error: { code: "payload_too_large", message: "The request body exceeds 1 MiB." },
        }, 413),
      }),
      async (honoContext) => {
        if (honoContext.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
          return honoContext.json({
            error: { code: "unsupported_media_type", message: "Content-Type must be application/json." },
          }, 415);
        }
        const channelId = honoContext.req.param("channelId");
        if (!this.channels.some((channel) => channel.id === channelId)) {
          return honoContext.json({
            error: { code: "unknown_channel", message: "The channel does not exist." },
          }, 404);
        }
        let value: unknown;
        try {
          value = await honoContext.req.json();
        } catch {
          return honoContext.json({
            error: { code: "invalid_request", message: "The request body must be valid JSON." },
          }, 400);
        }
        let event: DispatchEvent;
        try {
          event = validateWebhookEvent(value);
        } catch (error) {
          if (!(error instanceof WebhookValidationError)) throw error;
          return honoContext.json({
            error: { code: "invalid_request", message: error.message },
          }, 400);
        }
        try {
          const result = await dispatch(channelId, event);
          return result.status === "queued"
            ? honoContext.json(result, 202)
            : honoContext.json(result, 200);
        } catch (error) {
          this.logger.error("Webhook dispatch failed", { error: formatError(error), channelId });
          return honoContext.json({
            error: { code: "internal_error", message: "The request could not be completed." },
          }, 500);
        }
      },
    );
    app.get("/api/v1/status", async (honoContext) => {
      try {
        const state = await this.store.read();
        const deliveries = emptyDeliveryCounts();
        for (const delivery of state.deliveries) deliveries[delivery.status] += 1;
        return honoContext.json({
          uptimeMs: Math.max(0, Date.now() - (this.runtimeStartedAt ?? Date.now())),
          http: this.httpAddress,
          totals: {
            events: state.events.length,
            sessions: state.sessions.length,
            deliveries,
          },
        });
      } catch (error) {
        this.logger.error("Operational status read failed", { error: formatError(error) });
        return honoContext.json({
          error: { code: "internal_error", message: "The request could not be completed." },
        }, 500);
      }
    });
    app.get("/api/v1/events", async (honoContext) => {
      let limit: number;
      try {
        limit = parseOperationalLimit(honoContext.req.url);
      } catch {
        return honoContext.json({
          error: { code: "invalid_limit", message: `limit must be an integer from 1 through ${MAX_OPERATIONAL_LIMIT}.` },
        }, 400);
      }
      try {
        const state = await this.store.read();
        const selectedEvents = selectNewest(
          state.events,
          limit + 1,
          (event) => event.receivedAt,
          (event) => event.id,
        );
        const selectedIds = new Set(selectedEvents.map((event) => event.id));
        const countsByEvent = new Map<string, DeliveryCounts>();
        for (const delivery of state.deliveries) {
          if (!selectedIds.has(delivery.eventId)) continue;
          const counts = countsByEvent.get(delivery.eventId) ?? emptyDeliveryCounts();
          counts[delivery.status] += 1;
          countsByEvent.set(delivery.eventId, counts);
        }
        const summaries = selectedEvents
          .map((event) => ({
            id: event.id,
            sourceId: event.sourceId,
            channelId: event.channelId,
            dedupeKey: event.dedupeKey,
            sessionKey: event.sessionKey,
            ...(event.type === undefined ? {} : { type: event.type }),
            ...(event.occurredAt === undefined ? {} : { occurredAt: event.occurredAt }),
            receivedAt: event.receivedAt,
            deliveries: countsByEvent.get(event.id) ?? emptyDeliveryCounts(),
          }));
        return honoContext.json({ events: summaries.slice(0, limit), hasMore: selectedEvents.length > limit });
      } catch (error) {
        this.logger.error("Operational event read failed", { error: formatError(error) });
        return honoContext.json({
          error: { code: "internal_error", message: "The request could not be completed." },
        }, 500);
      }
    });
    app.get("/api/v1/sessions", async (honoContext) => {
      let limit: number;
      try {
        limit = parseOperationalLimit(honoContext.req.url);
      } catch {
        return honoContext.json({
          error: { code: "invalid_limit", message: `limit must be an integer from 1 through ${MAX_OPERATIONAL_LIMIT}.` },
        }, 400);
      }
      try {
        const state = await this.store.read();
        const selectedSessions = selectNewest(
          state.sessions,
          limit + 1,
          (session) => session.updatedAt,
          (session) => session.id,
        );
        const summaries = selectedSessions
          .map((session) => ({
            id: session.id,
            key: session.key,
            status: session.status,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            ...(session.endedAt === undefined ? {} : { endedAt: session.endedAt }),
          }));
        return honoContext.json({ sessions: summaries.slice(0, limit), hasMore: selectedSessions.length > limit });
      } catch (error) {
        this.logger.error("Operational session read failed", { error: formatError(error) });
        return honoContext.json({
          error: { code: "internal_error", message: "The request could not be completed." },
        }, 500);
      }
    });
    app.all("/webhooks", (honoContext) => honoContext.notFound());
    app.all("/webhooks/*", (honoContext) => honoContext.notFound());
    app.all("/api/v1", (honoContext) => honoContext.notFound());
    app.all("/api/v1/*", (honoContext) => honoContext.notFound());
    await http?.routes?.(context);

    let lastAddressInUseError: unknown;
    const finalPort = Math.min(65_535, requestedPort + MAX_HTTP_PORT_ATTEMPTS - 1);
    for (let port = requestedPort; port <= finalPort; port += 1) {
      const server = createServer(getRequestListener(app.fetch, {
        hostname,
        overrideGlobalObjects: false,
      }));
      try {
        await this.listen(server, hostname, port);
        this.httpServer = server;
        this.httpAccepting = true;
        const url = formatHttpUrl(hostname, port);
        const address = server.address() as AddressInfo;
        this.httpAddress = { hostname: address.address, port: address.port };
        if (!isLoopbackAddress(address.address)) {
          this.logger.warn("HTTP server has no built-in authentication and is bound to a non-loopback hostname", {
            hostname,
            port,
            address: address.address,
          });
        }
        this.logger.info(
          port === requestedPort ? "HTTP server listening" : "HTTP server listening on fallback port",
          { hostname, requestedPort, port, url },
        );
        return;
      } catch (error) {
        if (!isAddressInUse(error)) throw error;
        lastAddressInUseError = error;
      }
    }
    throw new Error(
      `Unable to bind HTTP server after ${finalPort - requestedPort + 1} attempts from port ${requestedPort}`,
      { cause: lastAddressInUseError },
    );
  }

  private listen(server: Server, hostname: string, port: number): Promise<void> {
    return new Promise((resolveListen, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolveListen();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.on("request", (_request, response) => {
        response.once("finish", () => {
          if (!this.httpAccepting) server.closeIdleConnections();
        });
      });
      server.listen(port, hostname);
    });
  }

  private async closeHttpServer(): Promise<void> {
    const server = this.httpServer;
    if (!server) return;
    this.httpAccepting = false;
    this.httpReady = false;
    const idleErrors: unknown[] = [];
    const closeIdleConnections = () => {
      try {
        server.closeIdleConnections();
      } catch (error) {
        idleErrors.push(error);
      }
    };
    const closed = new Promise<void>((resolveClose, reject) => {
      server.close((error) => {
        if (error && !isServerNotRunning(error)) {
          reject(error);
          return;
        }
        if (this.httpServer === server) this.httpServer = undefined;
        this.httpAddress = undefined;
        resolveClose();
      });
      closeIdleConnections();
    });
    const settledWork = this.settleHttpWork().then(closeIdleConnections);
    const results = await Promise.allSettled([
      closed,
      settledWork,
    ]);
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason)
      .concat(idleErrors);
    if (errors.length > 1) throw new AggregateError(errors, "HTTP server shutdown failed");
    if (errors.length === 1) throw errors[0];
  }

  private async settleHttpWork(): Promise<void> {
    while (this.httpRequests.size > 0 || this.httpDispatches.size > 0) {
      await Promise.allSettled([...this.httpRequests, ...this.httpDispatches]);
    }
  }

  private async settleMutationWork(): Promise<void> {
    while (this.mutationPromises.size > 0) {
      await Promise.allSettled(this.mutationPromises);
    }
  }

  async drain(): Promise<void> {
    this.claimDrain();
    try {
      await this.ensureRuntimeOwnership();
      await this.drainOwned();
    } finally {
      this.drainInProgress = false;
    }
  }

  private async drainOwned(): Promise<void> {
    await this.init();
    await this.recoverInterruptedDeliveries();
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

  private async drainOwnedGuarded(): Promise<void> {
    if (this.drainInProgress) throw new Error("Cannot drain a runtime while another drain is in progress");
    this.drainInProgress = true;
    try {
      await this.drainOwned();
    } finally {
      this.drainInProgress = false;
    }
  }

  async runOffline<T>(operation: (context: OfflineOperationContext) => T | Promise<T>): Promise<T> {
    if (this.offlineOperationActive) throw new Error("An offline operation is already active on this runtime");
    if (this.lifecycleState !== "unused") {
      throw new Error("runOffline requires an unused one-shot runtime");
    }
    this.offlineOperationActive = true;
    try {
      await this.ensureRuntimeOwnership();
    } catch (error) {
      this.offlineOperationActive = false;
      throw error;
    }
    try {
      await this.init();
    } catch (error) {
      let shutdownError: unknown;
      let shutdownFailed = false;
      try {
        await this.shutdown();
      } catch (caught) {
        shutdownFailed = true;
        shutdownError = caught;
      } finally {
        this.offlineOperationActive = false;
      }
      if (shutdownFailed) {
        throw new AggregateError([error, shutdownError], "Offline initialization and runtime shutdown failed");
      }
      throw error;
    }
    let result: T | undefined;
    let operationError: unknown;
    let operationFailed = false;
    let contextActive = true;
    const contextOperations = new Set<Promise<unknown>>();
    const trackContextOperation = <T>(operation: () => Promise<T>): Promise<T> => {
      if (!contextActive) {
        return Promise.reject(new Error("Offline operation context is no longer active"));
      }
      const pending = operation();
      contextOperations.add(pending);
      void pending.catch(() => {});
      return pending;
    };
    const context: OfflineOperationContext = {
      dispatch: (channel, event) => trackContextOperation(() => typeof channel === "string"
          ? this.dispatch(channel, event)
          : this.dispatch(channel, event)),
      drain: () => trackContextOperation(() => this.drainOwnedGuarded()),
      endSession: (idOrKey, reason) => trackContextOperation(() => this.endSession(idOrKey, reason)),
      releaseCapacity: (clientId, sessionIdOrKey) => trackContextOperation(
        () => this.releaseCapacity(clientId, sessionIdOrKey),
      ),
      retryDelivery: (id) => trackContextOperation(() => this.retryDelivery(id)),
      pruneState: (options) => trackContextOperation(() => this.pruneState(options)),
    };
    try {
      result = await operation(context);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    } finally {
      contextActive = false;
    }

    await Promise.allSettled(contextOperations);

    let stopError: unknown;
    let stopFailed = false;
    try {
      await this.shutdown();
    } catch (error) {
      stopFailed = true;
      stopError = error;
    } finally {
      this.offlineOperationActive = false;
    }
    if (operationFailed && stopFailed) {
      throw new AggregateError([operationError, stopError], "Offline operation and runtime shutdown failed");
    }
    if (operationFailed) throw operationError;
    if (stopFailed) throw stopError;
    return result as T;
  }

  private claimStart(): void {
    if (this.offlineOperationActive) throw new Error("Cannot start a runtime during an active offline operation");
    if (this.lifecycleState === "unused") {
      this.lifecycleState = "starting";
      return;
    }
    if (this.lifecycleState === "starting") throw new Error("Cannot start a runtime while the runtime is starting");
    if (this.lifecycleState === "started") throw new Error("Cannot start a runtime because start() has already been called");
    if (this.lifecycleState === "drain") {
      throw new Error("Cannot start a runtime after drain() has already claimed its one-shot lifecycle");
    }
    throw new Error("Cannot start a runtime after the runtime has been stopped");
  }

  private claimDrain(): void {
    if (this.offlineOperationActive) throw new Error("Cannot drain a runtime during an active offline operation");
    if (this.lifecycleState === "unused") this.lifecycleState = "drain";
    else if (this.lifecycleState === "starting" || this.lifecycleState === "started") {
      throw new Error("Cannot drain a runtime because start() has already claimed its one-shot lifecycle");
    } else if (this.lifecycleState === "stopping" || this.lifecycleState === "stopped") {
      throw new Error("Cannot drain a runtime after the runtime has been stopped");
    }
    if (this.drainInProgress) throw new Error("Cannot drain a runtime while another drain is in progress");
    this.drainInProgress = true;
  }

  private assertMutationAllowed(): void {
    const acceptedHttpWork = this.httpRequestContext.getStore()?.active === true;
    if (this.lifecycleState === "stopped" || (this.lifecycleState === "stopping" && !acceptedHttpWork)) {
      throw new Error("Cannot mutate a runtime after the runtime has been stopped");
    }
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertMutationAllowed();
    const pending = operation();
    this.mutationPromises.add(pending);
    void pending.then(
      () => this.mutationPromises.delete(pending),
      () => this.mutationPromises.delete(pending),
    );
    return pending;
  }

  async dispatch(channel: ChannelDefinition, event: DispatchEvent): Promise<DispatchResult>;
  async dispatch(channel: string, event: DispatchEvent): Promise<DispatchResult>;
  async dispatch(channel: ChannelDefinition | string, event: DispatchEvent): Promise<DispatchResult>;
  async dispatch(channel: ChannelDefinition | string, event: DispatchEvent): Promise<DispatchResult> {
    return this.runMutation(async () => {
      await this.init();
      const registered = typeof channel === "string"
        ? this.channels.find((candidate) => candidate.id === channel)
        : this.channels.find((candidate) => candidate.definition === channel);
      if (!registered) throw new Error(`Unknown channel: ${typeof channel === "string" ? channel : channel.id}`);
      const channelId = registered.id;

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
              retryDelayMs: parseRetryDelay(handler.retries.delay ?? this.options.config.retries?.delay ?? 0),
              createdAt: nowIso(),
              updatedAt: nowIso(),
            });
          }
        }

        await this.store.write(state);
        return { status: "queued", eventId: storedEvent.id };
      });
    });
  }

  async listSessions(): Promise<StoredSession[]> {
    await this.init();
    const state = await this.store.read();
    return state.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getSession(idOrKey: string): Promise<StoredSession | undefined> {
    await this.init();
    const state = await this.store.read();
    return state.sessions.find((session) => session.id === idOrKey || session.key === idOrKey);
  }

  async listSessionNotes(idOrKey: string): Promise<SessionNote[]> {
    await this.init();
    const state = await this.store.read();
    const session = state.sessions.find((candidate) => candidate.id === idOrKey || candidate.key === idOrKey);
    if (!session) return [];
    return state.notes
      .filter((note) => note.sessionId === session.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listCapacityReservations(): Promise<StoredCapacityReservation[]> {
    await this.init();
    const state = await this.store.read();
    return state.capacityReservations
      .map((reservation) => ({ ...reservation }))
      .sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt));
  }

  async releaseCapacity(clientId: string, sessionIdOrKey: string): Promise<boolean> {
    return this.runMutation(async () => {
      await this.init();
      return this.mutex.run(async () => {
        const state = await this.store.read();
        const reservationIndex = state.capacityReservations.findIndex((reservation) => {
          if (reservation.clientId !== clientId) return false;
          const session = state.sessions.find(({ id }) => id === reservation.sessionId);
          return session?.id === sessionIdOrKey || session?.key === sessionIdOrKey;
        });
        if (reservationIndex === -1) return false;
        state.capacityReservations.splice(reservationIndex, 1);
        await this.store.write(state);
        return true;
      });
    });
  }

  async endSession(idOrKey: string, reason = "manual"): Promise<boolean> {
    return this.runMutation(async () => {
      await this.init();
      return this.mutex.run(async () => {
        const state = await this.store.read();
        const session = state.sessions.find((candidate) => candidate.id === idOrKey || candidate.key === idOrKey);
        if (!session) return false;
        session.status = "ended";
        session.endedAt = nowIso();
        session.endReason = reason;
        session.updatedAt = nowIso();
        state.capacityReservations = state.capacityReservations.filter(({ sessionId }) => sessionId !== session.id);
        await this.store.write(state);
        return true;
      });
    });
  }

  async listEvents(): Promise<{ event: StoredEvent; deliveries: StoredDelivery[] }[]> {
    await this.init();
    const state = await this.store.read();
    return state.events
      .map((event) => ({
        event,
        deliveries: state.deliveries.filter((delivery) => delivery.eventId === event.id),
      }))
      .sort((a, b) => b.event.receivedAt.localeCompare(a.event.receivedAt));
  }

  async previewStatePrune(options: StatePruneOptions): Promise<StatePrunePlan> {
    await this.init();
    return planStatePrune(await this.store.read(), options);
  }

  async pruneState(options: StatePruneOptions): Promise<StatePrunePlan> {
    return this.runMutation(async () => {
      await this.init();
      return this.mutex.run(async () => {
        const state = await this.store.read();
        const plan = planStatePrune(state, options);
        if (plan.deliveryIds.length || plan.sessionIds.length || plan.noteIds.length || plan.eventIds.length) {
          applyStatePrune(state, plan);
          await this.store.write(state);
        }
        return plan;
      });
    });
  }

  async retryDelivery(id: string): Promise<boolean> {
    return this.runMutation(async () => {
      await this.init();
      return this.mutex.run(async () => {
        const state = await this.store.read();
        const delivery = state.deliveries.find((candidate) => candidate.id === id);
        if (!delivery || delivery.status !== "failed") return false;
        delivery.status = "pending";
        delivery.maxAttempts = Math.max(delivery.maxAttempts, delivery.attempts + 1);
        delivery.lastError = undefined;
        delivery.processedAt = undefined;
        delivery.nextAttemptAt = undefined;
        delivery.updatedAt = nowIso();
        await this.store.write(state);
        return true;
      });
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
      capacity: this.clients.flatMap((client) => client.capacityOptions ? [{
        clientId: client.id,
        maxActiveSessions: client.capacityOptions.maxActiveSessions,
        activeSessions: state.capacityReservations.filter(({ clientId }) => clientId === client.id).length,
      }] : []),
      http: {
        enabled: this.options.config.http?.enabled ?? true,
        hostname: this.options.config.http?.hostname ?? DEFAULT_HTTP_HOSTNAME,
        port: this.options.config.http?.port ?? DEFAULT_HTTP_PORT,
      },
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
    this.prepareStore();
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

  private async recoverInterruptedDeliveries(): Promise<void> {
    const recovered = await this.mutex.run(async () => {
      const state = await this.store.read();
      const interrupted = state.deliveries.filter(({ status }) => status === "processing");
      if (interrupted.length === 0) return [];

      const recoveredAt = nowIso();
      for (const delivery of interrupted) {
        delivery.status = "pending";
        delivery.maxAttempts = Math.max(delivery.maxAttempts, delivery.attempts + 1);
        delivery.lastError = `Interrupted during attempt ${delivery.attempts}; recovered before processing resumed. Handler and external effects may run again.`;
        delivery.nextAttemptAt = undefined;
        delivery.updatedAt = recoveredAt;
      }
      await this.store.write(state);
      return interrupted.map(({ id, attempts }) => ({ id, interruptedAttempt: attempts }));
    });

    if (recovered.length > 0) {
      this.logger.warn("Recovered interrupted deliveries", {
        count: recovered.length,
        deliveries: recovered,
      });
    }
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

  private schedulePoll(channel: RuntimeChannel, poll: PollDefinition, index: number): Promise<void> {
    const cursorId = pollCursorId(channel.id, poll, index);
    const existing = this.pollPromises.get(cursorId);
    if (existing) return existing;
    const promise = this.runPoll(channel, poll, index).finally(() => {
      if (this.pollPromises.get(cursorId) === promise) this.pollPromises.delete(cursorId);
    });
    this.pollPromises.set(cursorId, promise);
    return promise;
  }

  private async runPoll(channel: RuntimeChannel, poll: PollDefinition, index: number): Promise<void> {
    const cursorId = pollCursorId(channel.id, poll, index);
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

  private async workerLoop(client: RuntimeClient): Promise<void> {
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

  private async processNextDelivery(client: RuntimeClient): Promise<boolean> {
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

  private async claimNextDelivery(client: RuntimeClient): Promise<ClaimedDelivery | undefined> {
    return this.mutex.run(async () => {
      const state = await this.store.read();
      for (const delivery of state.deliveries) {
        if (delivery.clientId !== client.id) continue;
        if (delivery.status !== "pending") continue;
        if (delivery.nextAttemptAt !== undefined && Date.parse(delivery.nextAttemptAt) > Date.now()) continue;
        const event = state.events.find((candidate) => candidate.id === delivery.eventId);
        if (!event) continue;
        if (client.concurrencyOptions.perSession && this.processingSessionKeys.has(event.sessionKey)) continue;
        const handler = client.handlers.find((candidate) => candidate.id === delivery.handlerId);
        if (!handler) continue;

        let session = state.sessions.find(
          (candidate) => candidate.key === event.sessionKey && candidate.status === "active",
        );
        const existingSessionId = session?.id;
        let reservation = existingSessionId
          ? state.capacityReservations.find(
              (candidate) => candidate.clientId === client.id && candidate.sessionId === existingSessionId,
            )
          : undefined;
        if (client.capacityOptions && !reservation) {
          const active = state.capacityReservations.filter(({ clientId }) => clientId === client.id).length;
          if (active >= client.capacityOptions.maxActiveSessions) continue;
        }
        if (!session) {
          session = createStoredSession(event.sessionKey);
          state.sessions.push(session);
        }
        if (client.capacityOptions && !reservation) {
          reservation = {
            id: newId("cap"),
            clientId: client.id,
            sessionId: session.id,
            acquiredAt: nowIso(),
          };
          state.capacityReservations.push(reservation);
        }

        delivery.status = "processing";
        delivery.attempts += 1;
        delivery.nextAttemptAt = undefined;
        const claimedAt = nowIso();
        delivery.startedAt = claimedAt;
        delivery.updatedAt = claimedAt;
        delivery.sessionId = session.id;
        await this.store.write(state);
        if (client.concurrencyOptions.perSession) this.processingSessionKeys.add(event.sessionKey);
        return {
          delivery: { ...delivery },
          event: { ...event },
          session: { ...session, state: { ...session.state } },
          handler,
          client,
        };
      }
      return undefined;
    });
  }

  private async runClaimedDelivery(claimed: ClaimedDelivery): Promise<void> {
    const { client, delivery, event, handler } = claimed;
    let sessionImpl: SessionImpl | undefined;
    let handlerContext: HandlerContext | undefined;
    let attemptSignal: AttemptSignal | undefined;
    let releaseCapacity = false;

    try {
      sessionImpl = new SessionImpl(claimed.session, (sessionInstance, name, factory) =>
        this.coordinateEnsure(sessionInstance, name, factory),
      );

      const environment = await this.getMountedEnvironment(client);
      const timeoutMs = parseHandlerTimeout(handler.timeout ?? this.options.config.timeout ?? 0);
      attemptSignal = createAttemptSignal(this.abortController.signal, timeoutMs);
      await this.ensureSandbox(client, environment, sessionImpl, event, attemptSignal);
      attemptSignal.throwIfTimedOut();

      const orchestratorEvent = this.toRuntimeEvent(event);
      handlerContext = {
        event: orchestratorEvent,
        session: sessionImpl,
        environment,
        client: client.definition,
        project: this.project,
        logger: this.logger,
        attempt: delivery.attempts,
        signal: attemptSignal.signal,
        capacity: {
          reserved: client.capacityOptions !== undefined,
          release() {
            if (!client.capacityOptions) throw new Error(`Client ${client.id} does not have retained capacity`);
            releaseCapacity = true;
          },
        },
      };

      await handler.handle(handlerContext);
      attemptSignal.throwIfTimedOut();
      await handler.onSuccess?.(handlerContext);
      attemptSignal.throwIfTimedOut();

      if (sessionImpl.status === "ended") {
        await this.cleanupSandbox(client, environment, sessionImpl, event, attemptSignal);
        attemptSignal.throwIfTimedOut();
      }

      attemptSignal.dispose();
      await this.persistSuccess(delivery.id, client.id, sessionImpl, releaseCapacity);
    } catch (error) {
      const failure = attemptSignal?.timeoutError ?? error;
      attemptSignal?.cancelTimeout();
      if (handlerContext) {
        try {
          await handler.onFailure?.({ ...handlerContext, error: failure });
        } catch (onFailureError) {
          this.logger.warn("onFailure hook failed", { error: formatError(onFailureError) });
        }
      }
      attemptSignal?.dispose();
      await this.persistFailure(delivery.id, failure);
    } finally {
      attemptSignal?.dispose();
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

  private async persistSuccess(
    deliveryId: string,
    clientId: string,
    session: SessionImpl,
    releaseCapacity: boolean,
  ): Promise<void> {
    await this.mutex.run(async () => {
      const state = await this.store.read();
      const storedSession = this.mergeSession(state, session);
      state.notes.push(...session.drainNotes());
      if (storedSession.status === "ended") {
        state.capacityReservations = state.capacityReservations.filter(({ sessionId }) => sessionId !== session.id);
      } else if (releaseCapacity) {
        state.capacityReservations = state.capacityReservations.filter(
          (reservation) => reservation.clientId !== clientId || reservation.sessionId !== session.id,
        );
      }
      const delivery = state.deliveries.find((candidate) => candidate.id === deliveryId);
      if (delivery) {
        delivery.status = "processed";
        delivery.processedAt = nowIso();
        delivery.updatedAt = nowIso();
        delivery.lastError = undefined;
        delivery.nextAttemptAt = undefined;
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
        const failedAt = Date.now();
        const exhausted = delivery.attempts >= delivery.maxAttempts;
        delivery.status = exhausted ? "failed" : "pending";
        if (!exhausted && delivery.retryDelayMs > 0) {
          const retryAt = Math.min(MAX_DATE_TIMESTAMP, failedAt + delivery.retryDelayMs);
          delivery.nextAttemptAt = new Date(retryAt).toISOString();
        } else {
          delivery.nextAttemptAt = undefined;
        }
        delivery.lastError = formatError(error);
        delivery.updatedAt = new Date(failedAt).toISOString();
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
    if (existing) return existing.instance;
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
      const failedHooks: MountedEnvironment["pendingUnmountHooks"] = [];
      for (const hook of [...definition.unmountHooks].reverse()) {
        try {
          await hook({ environment: instance, project: this.project, logger: this.logger, signal: this.abortController.signal });
        } catch (rollbackError) {
          this.logger.warn("Environment rollback failed", { error: formatError(rollbackError) });
          failedHooks.push(hook);
        }
      }
      if (failedHooks.length > 0) {
        this.environmentInstances.set(key, { instance, pendingUnmountHooks: failedHooks });
      }
      throw error;
    }
    this.environmentInstances.set(key, {
      instance,
      pendingUnmountHooks: [...definition.unmountHooks].reverse(),
    });
    return instance;
  }

  private async unmountAllEnvironments(): Promise<void> {
    const errors: unknown[] = [];
    for (const [key, mounted] of [...this.environmentInstances.entries()].reverse()) {
      const failedHooks: MountedEnvironment["pendingUnmountHooks"] = [];
      for (const hook of mounted.pendingUnmountHooks) {
        try {
          await hook({
            environment: mounted.instance,
            project: this.project,
            logger: this.logger,
            signal: this.abortController.signal,
          });
        } catch (error) {
          errors.push(error);
          failedHooks.push(hook);
        }
      }
      mounted.pendingUnmountHooks = failedHooks;
      if (failedHooks.length === 0) this.environmentInstances.delete(key);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Multiple environment unmount hooks failed");
  }

  private async ensureSandbox(
    client: ClientDefinition,
    environment: EnvironmentInstance,
    session: SessionImpl,
    event: StoredEvent,
    attemptSignal: AttemptSignal,
  ): Promise<void> {
    const definition = client.environment;
    if (!definition?.sandbox) return;
    const flag = `__sao.sandbox.${definition.id}.created`;
    await this.withSandboxLock(`${session.id}:${flag}`, async () => {
      await this.refreshSessionState(session);
      attemptSignal.throwIfTimedOut();
      if (session.getOptional<boolean>(flag)) return;
      await definition.sandbox!.create(this.sandboxContext(environment, session, event, attemptSignal.signal));
      attemptSignal.throwIfTimedOut();
      session.set(flag, true);
      await this.persistSessionMutations(session);
    });
  }

  private async cleanupSandbox(
    client: ClientDefinition,
    environment: EnvironmentInstance,
    session: SessionImpl,
    event: StoredEvent,
    attemptSignal: AttemptSignal,
  ): Promise<void> {
    const definition = client.environment;
    if (!definition?.sandbox?.cleanup) return;
    const flag = `__sao.sandbox.${definition.id}.created`;
    await this.withSandboxLock(`${session.id}:${flag}`, async () => {
      await this.refreshSessionState(session);
      attemptSignal.throwIfTimedOut();
      if (!session.getOptional<boolean>(flag)) return;
      await definition.sandbox!.cleanup!(this.sandboxContext(environment, session, event, attemptSignal.signal));
      attemptSignal.throwIfTimedOut();
      session.set(flag, false);
      await this.persistSandboxFlag(session, flag, false);
    });
  }

  private sandboxContext(
    environment: EnvironmentInstance,
    session: SessionImpl,
    event: StoredEvent,
    signal: AbortSignal,
  ): SandboxContext {
    return {
      environment,
      project: this.project,
      logger: this.logger,
      signal,
      session,
      event: this.toRuntimeEvent(event),
    };
  }

  private validateConfiguration(): void {
    this.assertUnique(this.channels.map(({ id }) => id), "channel");
    this.assertUnique(this.clients.map(({ id }) => id), "client");
    const pollCursorIds: string[] = [];
    for (const channel of this.channels) {
      const pollIds = channel.polls.map((poll, index) => poll.id ?? String(index));
      this.assertUnique(pollIds, "poll", ` for channel ${channel.id}`);
      channel.polls.forEach((poll, index) => {
        parseDuration(poll.every);
        pollCursorIds.push(pollCursorId(channel.id, poll, index));
      });
    }
    this.assertUnique(pollCursorIds, "poll cursor");
    if (this.options.config.retries?.delay !== undefined) parseRetryDelay(this.options.config.retries.delay);
    if (this.options.config.timeout !== undefined) parseHandlerTimeout(this.options.config.timeout);
    if (this.options.config.http?.port !== undefined) parseHttpPort(this.options.config.http.port, "config.http.port");
    for (const client of this.clients) {
      this.assertUnique(client.handlers.map(({ id }) => id), "handler", ` for client ${client.id}`);
      if (
        client.capacityOptions &&
        (!Number.isSafeInteger(client.capacityOptions.maxActiveSessions) || client.capacityOptions.maxActiveSessions < 1)
      ) {
        throw new Error("Capacity maxActiveSessions must be a positive integer");
      }
      if (client.retryOptions.delay !== undefined) parseRetryDelay(client.retryOptions.delay);
      if (client.timeout !== undefined) parseHandlerTimeout(client.timeout);
      for (const handler of client.handlers) {
        if (handler.retries.delay !== undefined) parseRetryDelay(handler.retries.delay);
        if (handler.timeout !== undefined) parseHandlerTimeout(handler.timeout);
      }
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
