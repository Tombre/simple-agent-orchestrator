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
import type {
  ClientDefinition,
  HandlerContext,
  HandlerSandboxAccessor,
  RegisteredHandler,
} from "../core/client.js";
import type {
  AnySandboxDefinition,
  EnvironmentDefinition,
  EnvironmentInstance,
  ResourceSandboxDefinition,
  SandboxCleanupStepContext,
  SandboxCleanupStepDisposition,
  SandboxCleanupStepOptions,
  SandboxContext,
  SandboxCompletionContext,
  SandboxDefinition,
  SandboxDeliveryContext,
  SandboxDisposition,
  SandboxResourceCleanupContext,
  SandboxResourceCreateContext,
  SandboxResourceReconcileContext,
} from "../core/environment.js";
import {
  createEmptyEnvironment,
  EnvironmentInstanceImpl,
  isResourceSandboxDefinition,
} from "../core/environment.js";
import type { OrchestratorConfig } from "../core/config.js";
import { HandlerTimeoutError } from "../core/errors.js";
import { createStoredSession, SessionImpl } from "../core/session.js";
import type {
  DispatchEvent,
  DispatchResult,
  FailureStage,
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
  StoredExhaustion,
  StoredFailureDescriptor,
  StoredSandbox,
  StoredSandboxCleanupStep,
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
  completeSession(sessionId: string, reason?: string): Promise<boolean>;
  releaseCapacity(clientId: string, sessionIdOrKey: string): Promise<boolean>;
  retryDelivery(id: string): Promise<boolean>;
  pruneState(options: StatePruneOptions): Promise<StatePrunePlan>;
}

interface RuntimeChannel {
  readonly definition: ChannelDefinition;
  readonly id: string;
  readonly polls: readonly PollDefinition[];
}

interface RuntimeEnvironmentDefinition extends EnvironmentDefinition {
  readonly sandboxHandle?: AnySandboxDefinition | undefined;
}

interface RuntimeClient extends Omit<ClientDefinition, "environment"> {
  readonly definition: ClientDefinition;
  readonly environment?: RuntimeEnvironmentDefinition | undefined;
}

interface ClaimedDelivery {
  delivery: StoredDelivery;
  event: StoredEvent;
  session: StoredSession;
  handler: RegisteredHandler;
  client: RuntimeClient;
  capacityReserved: boolean;
}

interface ClaimedExhaustion {
  work: StoredExhaustion;
  delivery: StoredDelivery;
  event: StoredEvent;
  session?: StoredSession | undefined;
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
  ignored: number;
}

interface WorkCounts {
  pending: number;
  processing: number;
  processed: number;
  failed: number;
}

class WebhookValidationError extends Error {}

function emptyDeliveryCounts(): DeliveryCounts {
  return { pending: 0, processing: 0, processed: 0, failed: 0, ignored: 0 };
}

function emptyWorkCounts(): WorkCounts {
  return { pending: 0, processing: 0, processed: 0, failed: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateJsonValue(
  value: unknown,
  depth = 0,
  ancestors = new Set<object>(),
): asserts value is JsonValue {
  if (depth > MAX_JSON_NESTING_DEPTH) throw new WebhookValidationError("JSON nesting is too deep.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new WebhookValidationError("Numbers must be finite.");
    return;
  }
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length > 0 ||
      Object.getOwnPropertyNames(value).length !== value.length + 1
    ) {
      throw new WebhookValidationError("Values must be dense JSON arrays without extra properties.");
    }
    if (ancestors.has(value)) throw new WebhookValidationError("Values must not be circular.");
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new WebhookValidationError("Values must be dense JSON arrays without accessors.");
      }
      validateJsonValue(descriptor.value, depth + 1, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  if (!isRecord(value)) throw new WebhookValidationError("Values must be JSON-safe.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WebhookValidationError("Values must be plain JSON objects.");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new WebhookValidationError("Values must not contain symbol properties.");
  }
  if (ancestors.has(value)) throw new WebhookValidationError("Values must not be circular.");
  ancestors.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new WebhookValidationError("Values must not contain non-enumerable or accessor properties.");
    }
    validateJsonValue(descriptor.value, depth + 1, ancestors);
  }
  ancestors.delete(value);
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

function sanitizeFailure(error: unknown): StoredFailureDescriptor {
  const name = error instanceof Error && error.name.trim() ? error.name.slice(0, 128) : "Error";
  return { name, message: "Operation failed." };
}

function snapshotEnvironment(definition: EnvironmentDefinition | undefined): RuntimeEnvironmentDefinition | undefined {
  if (!definition) return undefined;
  return {
    id: definition.id,
    mountHooks: [...definition.mountHooks],
    unmountHooks: [...definition.unmountHooks],
    ...(definition.sandbox ? {
      sandbox: { ...definition.sandbox },
      sandboxHandle: definition.sandbox,
    } : {}),
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
    ...(client.exhaustion === undefined ? {} : {
      exhaustion: { ...client.exhaustion, retries: { ...client.exhaustion.retries } },
    }),
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
  private readonly completingSessions = new Set<string>();
  private readonly ensureLocks = new Map<string, Promise<unknown>>();
  private readonly sandboxLocks = new Map<string, Promise<void>>();
  private readonly sandboxCleanupStepLocks = new Map<string, Promise<void>>();
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
        const exhaustions = emptyWorkCounts();
        for (const work of state.exhaustions) exhaustions[work.status] += 1;
        return honoContext.json({
          uptimeMs: Math.max(0, Date.now() - (this.runtimeStartedAt ?? Date.now())),
          http: this.httpAddress,
          totals: {
            events: state.events.length,
            sessions: state.sessions.length,
            deliveries,
            exhaustions,
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
        const exhaustionCountsByEvent = new Map<string, WorkCounts>();
        for (const delivery of state.deliveries) {
          if (!selectedIds.has(delivery.eventId)) continue;
          const counts = countsByEvent.get(delivery.eventId) ?? emptyDeliveryCounts();
          counts[delivery.status] += 1;
          countsByEvent.set(delivery.eventId, counts);
        }
        for (const work of state.exhaustions) {
          if (!selectedIds.has(work.eventId)) continue;
          const counts = exhaustionCountsByEvent.get(work.eventId) ?? emptyWorkCounts();
          counts[work.status] += 1;
          exhaustionCountsByEvent.set(work.eventId, counts);
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
            exhaustions: exhaustionCountsByEvent.get(event.id) ?? emptyWorkCounts(),
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
        const didProcessExhaustion = await this.processNextExhaustion(client);
        processed = processed || didProcess || didProcessExhaustion;
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
      completeSession: (sessionId, reason) => trackContextOperation(() => this.completeSession(sessionId, reason)),
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
            const existingOnly = handler.session === "existing-only";
            const activeSession = existingOnly
              ? state.sessions.find((session) => session.key === sessionKey && session.status === "active")
              : undefined;
            const createdAt = nowIso();
            const ignored = existingOnly && !activeSession;
            state.deliveries.push({
              id: newId("deliv"),
              eventId: storedEvent.id,
              channelId,
              clientId: client.id,
              handlerId: handler.id,
              status: ignored ? "ignored" : "pending",
              phase: ignored ? "completed" : "sandbox",
              attempts: 0,
              maxAttempts: Math.max(1, handler.retries.attempts ?? this.options.config.retries?.attempts ?? 3),
              retryDelayMs: parseRetryDelay(handler.retries.delay ?? this.options.config.retries?.delay ?? 0),
              createdAt,
              updatedAt: createdAt,
              ...(activeSession ? { sessionId: activeSession.id } : {}),
              ...(ignored ? { processedAt: createdAt, ignoredReason: "session-missing" as const } : {}),
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

  async listSandboxes(sessionId?: string): Promise<StoredSandbox[]> {
    await this.init();
    const state = await this.store.read();
    return state.sandboxes
      .filter((sandbox) => sessionId === undefined || sandbox.sessionId === sessionId)
      .map((sandbox) => structuredClone(sandbox))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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

  async completeSession(sessionId: string, reason = "completed"): Promise<boolean> {
    return this.runMutation(async () => {
      await this.init();
      if (this.completingSessions.has(sessionId)) throw new Error(`Session completion is already in progress: ${sessionId}`);
      this.completingSessions.add(sessionId);
      try {
        const snapshot = await this.mutex.run(async () => {
          const state = await this.store.read();
          const session = state.sessions.find((candidate) => candidate.id === sessionId && candidate.status === "active");
          if (!session) throw new Error(`Session completion requires an exact active session ID: ${sessionId}`);
          const unfinished = this.findUnfinishedDelivery(state, session);
          if (unfinished) {
            throw new Error(`Cannot complete session ${sessionId}: unfinished delivery work exists (${unfinished.id})`);
          }
          const legacy = Object.entries(session.state).filter(
            ([key, value]) => key.startsWith("__sao.sandbox.") && key.endsWith(".created") && value === true,
          );
          for (const [flag] of legacy) {
            const environmentId = flag.slice("__sao.sandbox.".length, -".created".length);
            const owners = this.clients.filter((client) =>
              client.environment?.id === environmentId && client.environment.sandbox !== undefined
            );
            if (owners.length !== 1) {
              throw new Error(`Cannot complete session ${sessionId}: legacy sandbox ownership cannot be safely assigned to a client`);
            }
            const client = owners[0]!;
            if (!state.sandboxes.some((sandbox) =>
              sandbox.sessionId === sessionId && sandbox.clientId === client.id && sandbox.environmentId === environmentId
            )) {
              const timestamp = nowIso();
              state.sandboxes.push({
                sessionId,
                clientId: client.id,
                environmentId,
                status: "active",
                checkpoint: {},
                cleanupSteps: {},
                createdAt: timestamp,
                updatedAt: timestamp,
              });
            }
            delete session.state[flag];
          }
          if (legacy.length > 0) await this.store.write(state);
          return {
            session: { ...session, state: { ...session.state } },
            sandboxes: state.sandboxes
              .filter((sandbox) => sandbox.sessionId === sessionId)
              .map((sandbox) => structuredClone(sandbox)),
          };
        });

        const session = new SessionImpl(snapshot.session, (sessionInstance, name, factory) =>
          this.coordinateEnsure(sessionInstance, name, factory),
        );
        const lockKeys = snapshot.sandboxes.map((sandbox) =>
          this.sandboxKey(sessionId, sandbox.clientId, sandbox.environmentId)
        );
        await this.withSandboxLocks(lockKeys, async () => {
          for (const sandbox of snapshot.sandboxes) {
            if (sandbox.status === "cleaned") continue;
            const client = this.clients.find((candidate) => candidate.id === sandbox.clientId);
            const definition = client?.environment;
            if (!client || !definition || definition.id !== sandbox.environmentId || !definition.sandbox) {
              throw new Error(
                `Cannot complete session ${sessionId}: sandbox ${sandbox.clientId}/${sandbox.environmentId} is not configured`,
              );
            }
            const environment = await this.getMountedEnvironment(client);
            await this.completeSandbox(client, environment, session, reason);
          }

          await this.mutex.run(async () => {
            const state = await this.store.read();
            const stored = state.sessions.find((candidate) => candidate.id === sessionId && candidate.status === "active");
            if (!stored) throw new Error(`Session completion requires an exact active session ID: ${sessionId}`);
            const unfinished = this.findUnfinishedDelivery(state, stored);
            if (unfinished) {
              throw new Error(`Cannot complete session ${sessionId}: unfinished delivery work exists (${unfinished.id})`);
            }
            const incomplete = state.sandboxes.find(
              (sandbox) => sandbox.sessionId === sessionId && sandbox.status !== "cleaned",
            );
            if (incomplete) throw new Error(`Sandbox cleanup did not complete for ${incomplete.clientId}/${incomplete.environmentId}`);
            this.mergeSession(state, session);
            state.notes.push(...session.pendingNotes());
            stored.status = "ended";
            stored.endedAt = nowIso();
            stored.endReason = reason;
            stored.updatedAt = nowIso();
            state.capacityReservations = state.capacityReservations.filter((reservation) => reservation.sessionId !== sessionId);
            await this.store.write(state);
          });
        });
        session.clearMutations();
        session.clearNotes();
        return true;
      } finally {
        this.completingSessions.delete(sessionId);
      }
    });
  }

  async listEvents(): Promise<{ event: StoredEvent; deliveries: StoredDelivery[]; exhaustions: StoredExhaustion[] }[]> {
    await this.init();
    const state = await this.store.read();
    return state.events
      .map((event) => ({
        event,
        deliveries: state.deliveries.filter((delivery) => delivery.eventId === event.id),
        exhaustions: state.exhaustions.filter((work) => work.eventId === event.id),
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
        if (plan.deliveryIds.length || plan.exhaustionIds.length || plan.sessionIds.length || plan.noteIds.length || plan.eventIds.length) {
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
        if (!delivery) {
          const work = state.exhaustions.find((candidate) => candidate.id === id);
          if (!work || work.status !== "failed") return false;
          work.status = "pending";
          work.maxAttempts = Math.max(work.maxAttempts, work.attempts + 1);
          work.processedAt = undefined;
          work.nextAttemptAt = undefined;
          work.updatedAt = nowIso();
          await this.store.write(state);
          return true;
        }
        if (delivery.status !== "failed") return false;
        delivery.status = "pending";
        delivery.maxAttempts = Math.max(delivery.maxAttempts, delivery.attempts + 1);
        delivery.lastError = undefined;
        delivery.lastFailureStage = undefined;
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
      const interruptedExhaustions = state.exhaustions.filter(({ status }) => status === "processing");
      if (interrupted.length === 0 && interruptedExhaustions.length === 0) return [];

      const recoveredAt = nowIso();
      for (const delivery of interrupted) {
        delivery.status = "pending";
        delivery.maxAttempts = Math.max(delivery.maxAttempts, delivery.attempts + 1);
        delivery.lastError = `Interrupted during attempt ${delivery.attempts}; recovered at ${delivery.phase}.`;
        if (delivery.phase !== "completed") delivery.lastFailureStage = delivery.phase;
        delivery.nextAttemptAt = undefined;
        delivery.updatedAt = recoveredAt;
      }
      for (const work of interruptedExhaustions) {
        work.status = "pending";
        work.maxAttempts = Math.max(work.maxAttempts, work.attempts + 1);
        work.nextAttemptAt = undefined;
        work.updatedAt = recoveredAt;
      }
      await this.store.write(state);
      return [
        ...interrupted.map(({ id, attempts }) => ({ id, interruptedAttempt: attempts })),
        ...interruptedExhaustions.map(({ id, attempts }) => ({ id, interruptedAttempt: attempts })),
      ];
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
      const pollStartedAt = new Date().toISOString();
      const ctx = {
        pollStartedAt,
        channel: channelApi,
        cursor,
        project: this.project,
        logger: this.logger,
        signal,
      };
      const items = await poll.fetch(ctx);
      const events: DispatchEvent[] = [];

      if (poll.map) {
        for (const item of items) {
          const mapped = await poll.map(item, ctx);
          if (!mapped) continue;
          const mappedEvents: readonly DispatchEvent[] = Array.isArray(mapped) ? mapped : [mapped];
          for (const event of mappedEvents) {
            await channelApi.dispatch(event);
            events.push(event);
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
      const processedExhaustion = signal.aborted ? false : await this.processNextExhaustion(client);
      if (!processed && !processedExhaustion) {
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

  private async processNextExhaustion(client: RuntimeClient): Promise<boolean> {
    if (!client.exhaustion) return false;
    const claimed = await this.mutex.run(async (): Promise<ClaimedExhaustion | undefined> => {
      const state = await this.store.read();
      const work = state.exhaustions.find((candidate) =>
        candidate.clientId === client.id && candidate.status === "pending" &&
        (candidate.nextAttemptAt === undefined || Date.parse(candidate.nextAttemptAt) <= Date.now())
      );
      if (!work) return undefined;
      const delivery = state.deliveries.find(({ id }) => id === work.sourceDeliveryId);
      const event = state.events.find(({ id }) => id === work.eventId);
      if (!delivery || !event) return undefined;
      work.status = "processing";
      work.attempts += 1;
      work.nextAttemptAt = undefined;
      work.startedAt = nowIso();
      work.updatedAt = work.startedAt;
      await this.store.write(state);
      const session = work.sessionId === undefined ? undefined : state.sessions.find(({ id }) => id === work.sessionId);
      return {
        work: structuredClone(work),
        delivery: structuredClone(delivery),
        event: structuredClone(event),
        ...(session === undefined ? {} : { session: structuredClone(session) }),
        client,
      };
    });
    if (!claimed) return false;

    const timeoutMs = parseHandlerTimeout(client.exhaustion.timeout ?? 0);
    const attemptSignal = createAttemptSignal(this.abortController.signal, timeoutMs);
    try {
      const environment = await this.getMountedEnvironment(client);
      await client.exhaustion.handle({
        event: this.toRuntimeEvent(claimed.event),
        sourceDelivery: claimed.delivery,
        ...(claimed.session === undefined ? {} : { session: new SessionImpl(claimed.session) }),
        stage: claimed.work.stage,
        failure: claimed.work.failure,
        attempt: claimed.work.attempts,
        signal: attemptSignal.signal,
        project: this.project,
        logger: this.logger,
        environment,
        client: client.definition,
      });
      attemptSignal.throwIfTimedOut();
      await this.persistExhaustionResult(claimed.work.id);
    } catch (error) {
      attemptSignal.cancelTimeout();
      await this.persistExhaustionResult(claimed.work.id, attemptSignal.timeoutError ?? error);
    } finally {
      attemptSignal.dispose();
    }
    return true;
  }

  private async persistExhaustionResult(id: string, error?: unknown): Promise<void> {
    await this.mutex.run(async () => {
      const state = await this.store.read();
      const work = state.exhaustions.find((candidate) => candidate.id === id);
      if (!work) return;
      const timestamp = Date.now();
      if (error === undefined) {
        work.status = "processed";
        work.processedAt = new Date(timestamp).toISOString();
        work.nextAttemptAt = undefined;
      } else {
        const exhausted = work.attempts >= work.maxAttempts;
        work.status = exhausted ? "failed" : "pending";
        work.nextAttemptAt = !exhausted && work.retryDelayMs > 0
          ? new Date(Math.min(MAX_DATE_TIMESTAMP, timestamp + work.retryDelayMs)).toISOString()
          : undefined;
      }
      work.updatedAt = new Date(timestamp).toISOString();
      await this.store.write(state);
    });
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

        let session = handler.session === "existing-only"
          ? state.sessions.find((candidate) => candidate.id === delivery.sessionId && candidate.status === "active")
          : delivery.phase !== "sandbox" && delivery.sessionId
          ? state.sessions.find((candidate) => candidate.id === delivery.sessionId)
          : state.sessions.find((candidate) => candidate.key === event.sessionKey && candidate.status === "active");
        if (session && this.completingSessions.has(session.id)) continue;
        if (handler.session === "existing-only" && !session) {
          const ignoredAt = nowIso();
          delivery.status = "ignored";
          delivery.phase = "completed";
          delivery.ignoredReason = "session-ended";
          delivery.processedAt = ignoredAt;
          delivery.nextAttemptAt = undefined;
          delivery.updatedAt = ignoredAt;
          await this.store.write(state);
          continue;
        }
        const existingSessionId = session?.id;
        let reservation = existingSessionId
          ? state.capacityReservations.find(
              (candidate) => candidate.clientId === client.id && candidate.sessionId === existingSessionId,
            )
          : undefined;
        if (handler.session !== "existing-only" && client.capacityOptions && !reservation) {
          const active = state.capacityReservations.filter(({ clientId }) => clientId === client.id).length;
          if (active >= client.capacityOptions.maxActiveSessions) continue;
        }
        if (!session) {
          session = createStoredSession(event.sessionKey);
          state.sessions.push(session);
        }
        if (handler.session !== "existing-only" && client.capacityOptions && !reservation) {
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
          capacityReserved: reservation !== undefined,
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
    let stage: FailureStage = delivery.phase === "completed" ? "persisting" : delivery.phase;

    try {
      sessionImpl = new SessionImpl(claimed.session, (sessionInstance, name, factory) =>
        this.coordinateEnsure(sessionInstance, name, factory),
      );
      if (delivery.staged) {
        sessionImpl.restoreEffects(delivery.staged);
        releaseCapacity = delivery.staged.releaseCapacity;
      }

      const environment = await this.getMountedEnvironment(client);
      const timeoutMs = parseHandlerTimeout(handler.timeout ?? this.options.config.timeout ?? 0);
      attemptSignal = createAttemptSignal(this.abortController.signal, timeoutMs);
      if (delivery.phase === "sandbox" && handler.session !== "existing-only") {
        stage = "sandbox";
        await this.ensureSandbox(client, environment, sessionImpl, event, attemptSignal);
        await this.checkpointDelivery(delivery.id, "handling");
      }
      attemptSignal.throwIfTimedOut();

      const orchestratorEvent = this.toRuntimeEvent(event);
      const sandbox = await this.createHandlerSandboxAccessor(
        client,
        sessionImpl.id,
        delivery.phase === "cleaning",
      );
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
          reserved: claimed.capacityReserved,
          release() {
            if (!client.capacityOptions) throw new Error(`Client ${client.id} does not have retained capacity`);
            releaseCapacity = true;
          },
        },
        sandbox,
      };

      if (delivery.phase === "sandbox" || delivery.phase === "handling") {
        stage = "handling";
        await handler.handle(handlerContext);
        attemptSignal.throwIfTimedOut();
        await this.checkpointDelivery(delivery.id, "acknowledging", sessionImpl.stagedEffects(releaseCapacity));
      }
      if (delivery.phase === "sandbox" || delivery.phase === "handling" || delivery.phase === "acknowledging") {
        stage = "acknowledging";
        await handler.onSuccess?.(handlerContext);
        attemptSignal.throwIfTimedOut();
        await this.checkpointDelivery(delivery.id, "cleaning", sessionImpl.stagedEffects(releaseCapacity));
      }

      if (sessionImpl.endRequested()) {
        stage = "cleaning";
        await this.cleanupSandbox(client, environment, sessionImpl, event, attemptSignal);
        attemptSignal.throwIfTimedOut();
      }
      await this.checkpointDelivery(delivery.id, "persisting", sessionImpl.stagedEffects(releaseCapacity));

      attemptSignal.dispose();
      stage = "persisting";
      await this.persistSuccess(delivery.id, client.id, sessionImpl, releaseCapacity);
    } catch (error) {
      const failure = attemptSignal?.timeoutError ?? error;
      attemptSignal?.cancelTimeout();
      if (handlerContext) {
        try {
          await handler.onFailure?.({ ...handlerContext, error: failure, stage });
        } catch (onFailureError) {
          this.logger.warn("onFailure hook failed", { error: formatError(onFailureError) });
        }
      }
      attemptSignal?.dispose();
      await this.persistFailure(delivery.id, stage, failure, client);
    } finally {
      attemptSignal?.dispose();
    }
  }

  private async checkpointDelivery(
    deliveryId: string,
    phase: StoredDelivery["phase"],
    staged?: StoredDelivery["staged"],
  ): Promise<void> {
    await this.mutex.run(async () => {
      const state = await this.store.read();
      const delivery = state.deliveries.find(({ id }) => id === deliveryId);
      if (!delivery) return;
      delivery.phase = phase;
      if (staged !== undefined) delivery.staged = structuredClone(staged);
      delivery.updatedAt = nowIso();
      await this.store.write(state);
    });
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
        delivery.phase = "completed";
        delivery.processedAt = nowIso();
        delivery.updatedAt = nowIso();
        delivery.lastError = undefined;
        delivery.nextAttemptAt = undefined;
        delivery.lastFailureStage = undefined;
        delivery.staged = undefined;
      }
      await this.store.write(state);
    });
    session.clearMutations();
  }

  private async persistFailure(
    deliveryId: string,
    stage: FailureStage,
    error: unknown,
    client: RuntimeClient,
  ): Promise<void> {
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
        delivery.lastFailureStage = stage;
        delivery.updatedAt = new Date(failedAt).toISOString();
        if (exhausted && client.exhaustion && !state.exhaustions.some(({ sourceDeliveryId }) => sourceDeliveryId === delivery.id)) {
          const createdAt = new Date(failedAt).toISOString();
          state.exhaustions.push({
            id: newId("exh"),
            sourceDeliveryId: delivery.id,
            eventId: delivery.eventId,
            clientId: client.id,
            ...(delivery.sessionId === undefined ? {} : { sessionId: delivery.sessionId }),
            stage,
            failure: sanitizeFailure(error),
            status: "pending",
            attempts: 0,
            maxAttempts: Math.max(1, client.exhaustion.retries.attempts ?? 3),
            retryDelayMs: parseRetryDelay(client.exhaustion.retries.delay ?? 0),
            createdAt,
            updatedAt: createdAt,
          });
        }
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
    client: RuntimeClient,
    environment: EnvironmentInstance,
    session: SessionImpl,
    event: StoredEvent,
    attemptSignal: AttemptSignal,
  ): Promise<void> {
    const definition = client.environment;
    if (!definition?.sandbox) return;
    const resourceDefinition = this.resourceSandboxDefinition(client);
    await this.withSandboxLock(this.sandboxKey(session.id, client.id, definition.id), async () => {
      attemptSignal.throwIfTimedOut();
      const currentSession = await this.getSession(session.id);
      if (currentSession?.status !== "active") throw new Error(`Session ended before sandbox creation: ${session.id}`);
      let record = await this.getSandbox(session.id, client.id, definition.id);
      if (!record) record = await this.adoptLegacySandbox(session.id, client.id, definition.id);
      const activeResourceMissing = resourceDefinition !== undefined &&
        record?.status === "active" && !Object.hasOwn(record, "resource");
      if (record?.status === "active" && !activeResourceMissing) {
        return;
      }
      if (record && record.status !== "cleaned" && definition.sandbox!.reconcile) {
        let disposition: SandboxDisposition;
        try {
          disposition = resourceDefinition
            ? await resourceDefinition.reconcile!(
                this.resourceSandboxContext(
                  client,
                  environment,
                  session,
                  event,
                  attemptSignal.signal,
                  record,
                  { type: "delivery" },
                ),
              )
            : await (definition.sandbox as SandboxDefinition).reconcile!(
                this.sandboxContext(
                  client,
                  environment,
                  session,
                  event,
                  attemptSignal.signal,
                  record,
                  { type: "delivery" },
                ),
              );
          if (disposition !== "active" && disposition !== "cleaned" && disposition !== "unknown") {
            throw new Error(`Invalid sandbox reconciliation disposition: ${String(disposition)}`);
          }
        } catch (error) {
          await this.setSandboxStatus(session.id, client.id, definition.id, record.status, undefined, error);
          throw error;
        }
        attemptSignal.throwIfTimedOut();
        record = (await this.getSandbox(session.id, client.id, definition.id)) ?? record;
        if (disposition === "active" && resourceDefinition) this.assertPublishedSandboxResource(record);
        record = await this.persistSandboxDisposition(record, disposition);
        if (disposition === "active") {
          return;
        }
        if (disposition === "unknown") throw new Error(`Sandbox reconciliation remained unknown for ${client.id}/${definition.id}`);
      }
      if (record?.status === "cleaning" || record?.status === "unknown") {
        throw new Error(
          `Sandbox ${client.id}/${definition.id} is ${record.status} and cannot be used without successful reconciliation`,
        );
      }
      if (record?.status === "active" && resourceDefinition && !Object.hasOwn(record, "resource")) {
        throw new Error(
          `Active resource-aware sandbox ${client.id}/${definition.id} has no published resource and cannot be recovered without reconciliation`,
        );
      }
      record = await this.setSandboxStatus(
        session.id,
        client.id,
        definition.id,
        "creating",
        record?.checkpoint ?? {},
      );
      try {
        const resource = resourceDefinition
          ? await resourceDefinition.create(
              this.resourceSandboxContext(
                client,
                environment,
                session,
                event,
                attemptSignal.signal,
                record,
                { type: "delivery" },
              ),
            )
          : await (definition.sandbox as SandboxDefinition).create(
              this.sandboxContext(
                client,
                environment,
                session,
                event,
                attemptSignal.signal,
                record,
                { type: "delivery" },
              ),
            );
        if (resourceDefinition && resource !== undefined) {
          record = await this.publishSandboxResource(record, resource);
        }
        if (resourceDefinition) {
          record = (await this.getSandbox(session.id, client.id, definition.id)) ?? record;
          this.assertPublishedSandboxResource(record);
        }
      } catch (error) {
        await this.setSandboxStatus(session.id, client.id, definition.id, "creating", undefined, error);
        throw error;
      }
      attemptSignal.throwIfTimedOut();
      await this.setSandboxStatus(session.id, client.id, definition.id, "active");
      await this.persistSessionMutations(session);
    });
  }

  private async cleanupSandbox(
    client: RuntimeClient,
    environment: EnvironmentInstance,
    session: SessionImpl,
    event: StoredEvent,
    attemptSignal: AttemptSignal,
  ): Promise<void> {
    const definition = client.environment;
    if (!definition?.sandbox?.cleanup) return;
    const resourceDefinition = this.resourceSandboxDefinition(client);
    await this.withSandboxLock(this.sandboxKey(session.id, client.id, definition.id), async () => {
      attemptSignal.throwIfTimedOut();
      let record = await this.getSandbox(session.id, client.id, definition.id);
      if (!record || record.status === "cleaned") return;
      const resourceMissing = resourceDefinition !== undefined && !Object.hasOwn(record, "resource");
      const canReenterTypedCleanup = resourceDefinition !== undefined && record.status === "cleaning" && !resourceMissing;
      if ((record.status !== "active" && !canReenterTypedCleanup) || resourceMissing) {
        if (!definition.sandbox!.reconcile) {
          throw new Error(
            `Sandbox ${client.id}/${definition.id} is ${record.status} and cleanup cannot continue without reconciliation`,
          );
        }
        let disposition: SandboxDisposition;
        try {
          disposition = resourceDefinition
            ? await resourceDefinition.reconcile!(
                this.resourceSandboxContext(
                  client,
                  environment,
                  session,
                  event,
                  attemptSignal.signal,
                  record,
                  { type: "delivery" },
                ),
              )
            : await (definition.sandbox as SandboxDefinition).reconcile!(
                this.sandboxContext(
                  client,
                  environment,
                  session,
                  event,
                  attemptSignal.signal,
                  record,
                  { type: "delivery" },
                ),
              );
          if (disposition !== "active" && disposition !== "cleaned" && disposition !== "unknown") {
            throw new Error(`Invalid sandbox reconciliation disposition: ${String(disposition)}`);
          }
        } catch (error) {
          await this.setSandboxStatus(session.id, client.id, definition.id, record.status, undefined, error);
          throw error;
        }
        attemptSignal.throwIfTimedOut();
        record = (await this.getSandbox(session.id, client.id, definition.id)) ?? record;
        if (disposition === "active" && resourceDefinition) this.assertPublishedSandboxResource(record);
        record = await this.persistSandboxDisposition(record, disposition);
        if (disposition === "cleaned") return;
        if (disposition === "unknown") {
          throw new Error(`Sandbox reconciliation remained unknown for ${client.id}/${definition.id}`);
        }
      }
      if (resourceDefinition) this.assertPublishedSandboxResource(record);
      record = await this.setSandboxStatus(session.id, client.id, definition.id, "cleaning");
      try {
        if (resourceDefinition) {
          await resourceDefinition.cleanup!(
            this.resourceSandboxCleanupContext(
              client,
              environment,
              session,
              event,
              attemptSignal.signal,
              record,
              { type: "delivery" },
            ),
          );
        } else {
          await (definition.sandbox as SandboxDefinition).cleanup!(
            this.sandboxContext(client, environment, session, event, attemptSignal.signal, record, { type: "delivery" }),
          );
        }
      } catch (error) {
        await this.setSandboxStatus(session.id, client.id, definition.id, "cleaning", undefined, error);
        throw error;
      }
      attemptSignal.throwIfTimedOut();
      await this.setSandboxStatus(session.id, client.id, definition.id, "cleaned");
    });
  }

  private async completeSandbox(
    client: RuntimeClient,
    environment: EnvironmentInstance,
    session: SessionImpl,
    reason: string,
  ): Promise<void> {
    const definition = client.environment!;
    const sandbox = definition.sandbox!;
    const resourceDefinition = this.resourceSandboxDefinition(client);
    let record = await this.getSandbox(session.id, client.id, definition.id);
    if (!record || record.status === "cleaned") return;
    const resourceMissing = resourceDefinition !== undefined && !Object.hasOwn(record, "resource");
    const canReenterTypedCleanup = resourceDefinition !== undefined && record.status === "cleaning" && !resourceMissing;
    if ((record.status !== "active" && !canReenterTypedCleanup) || resourceMissing) {
      if (!sandbox.reconcile) {
        throw new Error(
          `Cannot complete session ${session.id}: sandbox ${client.id}/${definition.id} is ${record.status} and cleanup cannot continue without reconciliation`,
        );
      }
      let disposition: SandboxDisposition;
      try {
        disposition = resourceDefinition
          ? await resourceDefinition.reconcile!(
              this.resourceSandboxContext(
                client,
                environment,
                session,
                undefined,
                this.abortController.signal,
                record,
                { type: "completion", reason },
              ),
            )
          : await (sandbox as SandboxDefinition).reconcile!(
              this.sandboxContext(client, environment, session, undefined, this.abortController.signal, record, {
                type: "completion",
                reason,
              }),
            );
        if (disposition !== "active" && disposition !== "cleaned" && disposition !== "unknown") {
          throw new Error(`Invalid sandbox reconciliation disposition: ${String(disposition)}`);
        }
      } catch (error) {
        await this.setSandboxStatus(session.id, client.id, definition.id, record.status, undefined, error);
        throw error;
      }
      record = (await this.getSandbox(session.id, client.id, definition.id)) ?? record;
      if (disposition === "cleaned") {
        await this.persistAdministrativeSandboxSuccess(session, client.id, definition.id);
        return;
      }
      if (disposition === "active" && resourceDefinition) this.assertPublishedSandboxResource(record);
      record = await this.persistSandboxDisposition(record, disposition);
      if (disposition === "unknown") throw new Error(`Sandbox reconciliation remained unknown for ${client.id}/${definition.id}`);
    }
    if (!sandbox.cleanup) {
      throw new Error(`Cannot complete session ${session.id}: sandbox ${client.id}/${definition.id} has no cleanup hook`);
    }
    if (resourceDefinition) this.assertPublishedSandboxResource(record);
    record = await this.setSandboxStatus(session.id, client.id, definition.id, "cleaning");
    try {
      if (resourceDefinition) {
        await resourceDefinition.cleanup!(
          this.resourceSandboxCleanupContext(
            client,
            environment,
            session,
            undefined,
            this.abortController.signal,
            record,
            { type: "completion", reason },
          ),
        );
      } else {
        await (sandbox as SandboxDefinition).cleanup!(
          this.sandboxContext(client, environment, session, undefined, this.abortController.signal, record, {
            type: "completion",
            reason,
          }),
        );
      }
    } catch (error) {
      await this.setSandboxStatus(session.id, client.id, definition.id, "cleaning", undefined, error);
      throw error;
    }
    await this.persistAdministrativeSandboxSuccess(session, client.id, definition.id);
  }

  private async persistAdministrativeSandboxSuccess(
    session: SessionImpl,
    clientId: string,
    environmentId: string,
  ): Promise<void> {
    await this.mutex.run(async () => {
      const state = await this.store.read();
      const storedSession = state.sessions.find(({ id }) => id === session.id);
      if (!storedSession) throw new Error(`Session not found while saving sandbox cleanup: ${session.id}`);
      for (const mutation of session.pendingMutations()) {
        if (mutation.type === "set") storedSession.state[mutation.name] = mutation.value;
        else delete storedSession.state[mutation.name];
      }
      storedSession.updatedAt = nowIso();
      state.notes.push(...session.pendingNotes());
      const sandbox = state.sandboxes.find((candidate) =>
        candidate.sessionId === session.id &&
        candidate.clientId === clientId &&
        candidate.environmentId === environmentId
      );
      if (!sandbox) throw new Error(`Sandbox record not found for ${session.id}/${clientId}/${environmentId}`);
      sandbox.status = "cleaned";
      sandbox.lastError = undefined;
      sandbox.updatedAt = nowIso();
      await this.store.write(state);
    });
    session.clearMutations();
    session.clearNotes();
  }

  private findUnfinishedDelivery(state: OrchestratorState, session: StoredSession): StoredDelivery | undefined {
    const eventIds = new Set(
      state.events.filter(({ sessionKey }) => sessionKey === session.key).map(({ id }) => id),
    );
    return state.deliveries.find((delivery) =>
      (delivery.status === "pending" || delivery.status === "processing") &&
      (delivery.sessionId === session.id || eventIds.has(delivery.eventId))
    );
  }

  private sandboxContext(
    client: ClientDefinition,
    environment: EnvironmentInstance,
    session: SessionImpl,
    event: StoredEvent,
    signal: AbortSignal,
    sandbox: StoredSandbox,
    cause: { type: "delivery" },
  ): SandboxDeliveryContext;
  private sandboxContext(
    client: ClientDefinition,
    environment: EnvironmentInstance,
    session: SessionImpl,
    event: undefined,
    signal: AbortSignal,
    sandbox: StoredSandbox,
    cause: SandboxCompletionContext["cause"],
  ): SandboxCompletionContext;
  private sandboxContext(
    client: ClientDefinition,
    environment: EnvironmentInstance,
    session: SessionImpl,
    event: StoredEvent | undefined,
    signal: AbortSignal,
    sandbox: StoredSandbox,
    cause: SandboxContext["cause"],
  ): SandboxContext {
    let currentCheckpoint = structuredClone(sandbox.checkpoint);
    const base = {
      environment,
      project: this.project,
      logger: this.logger,
      signal,
      session,
      currentStatus: sandbox.status,
      checkpoint: async (update: JsonRecord) => {
        if (!isRecord(update)) throw new Error("Sandbox checkpoint update must be a JSON object");
        validateJsonValue(update);
        currentCheckpoint = { ...currentCheckpoint, ...structuredClone(update) };
        await this.updateSandboxCheckpoint(session.id, client.id, environment.id, update);
      },
    };
    const context = (event
      ? { ...base, cause: { type: "delivery" }, event: this.toRuntimeEvent(event) }
      : { ...base, cause: cause.type === "completion" ? cause : { type: "completion" }, event: undefined }) as unknown as SandboxContext;
    Object.defineProperty(context, "currentCheckpoint", {
      enumerable: true,
      get: () => structuredClone(currentCheckpoint),
    });
    return context;
  }

  private resourceSandboxContext(
    client: ClientDefinition,
    environment: EnvironmentInstance,
    session: SessionImpl,
    event: StoredEvent | undefined,
    signal: AbortSignal,
    sandbox: StoredSandbox,
    cause: SandboxContext["cause"],
  ): SandboxResourceCreateContext<JsonValue> & SandboxResourceReconcileContext<JsonValue> {
    const context = event === undefined
      ? this.sandboxContext(
          client,
          environment,
          session,
          undefined,
          signal,
          sandbox,
          cause.type === "completion" ? cause : { type: "completion" },
        )
      : this.sandboxContext(client, environment, session, event, signal, sandbox, { type: "delivery" });
    const resourceContext = Object.assign(context, {
      publishResource: async (resource: JsonValue) => {
        await this.publishSandboxResource(sandbox, resource);
      },
    }) as SandboxResourceCreateContext<JsonValue> & SandboxResourceReconcileContext<JsonValue>;
    if (Object.hasOwn(sandbox, "resource")) {
      Object.defineProperty(resourceContext, "resource", {
        enumerable: true,
        value: structuredClone(sandbox.resource),
      });
    }
    return resourceContext;
  }

  private resourceSandboxCleanupContext(
    client: ClientDefinition,
    environment: EnvironmentInstance,
    session: SessionImpl,
    event: StoredEvent | undefined,
    signal: AbortSignal,
    sandbox: StoredSandbox,
    cause: SandboxContext["cause"],
  ): SandboxResourceCleanupContext<JsonValue> {
    this.assertPublishedSandboxResource(sandbox);
    const context = event === undefined
      ? this.sandboxContext(
          client,
          environment,
          session,
          undefined,
          signal,
          sandbox,
          cause.type === "completion" ? cause : { type: "completion" },
        )
      : this.sandboxContext(client, environment, session, event, signal, sandbox, { type: "delivery" });
    const resource = structuredClone(sandbox.resource) as JsonValue;
    const readonlySession = Object.freeze({
      get id() {
        return session.id;
      },
      get key() {
        return session.key;
      },
      get status() {
        return session.status;
      },
      get: session.get.bind(session),
      getOptional: session.getOptional.bind(session),
      has: session.has.bind(session),
    });
    const stepContext = {
      environment: context.environment,
      project: context.project,
      logger: context.logger,
      signal: context.signal,
      currentStatus: context.currentStatus,
      checkpoint: context.checkpoint,
      cause: context.cause,
      event: context.event,
      session: readonlySession,
      resource: structuredClone(resource),
    } as SandboxCleanupStepContext<JsonValue>;
    Object.defineProperty(stepContext, "currentCheckpoint", {
      enumerable: true,
      get: () => context.currentCheckpoint,
    });
    return Object.assign(context, {
      resource,
      cleanup: {
        step: (
          id: string,
          options: SandboxCleanupStepOptions<JsonValue>,
          operation: (ctx: SandboxCleanupStepContext<JsonValue>) => Promise<void> | void,
        ) => this.withSandboxCleanupStepLock(
          `${this.sandboxKey(sandbox.sessionId, sandbox.clientId, sandbox.environmentId)}:${id}`,
          () => this.runSandboxCleanupStep(sandbox, id, options, operation, stepContext),
        ),
      },
    }) as SandboxResourceCleanupContext<JsonValue>;
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
      if (client.exhaustion?.retries.delay !== undefined) parseRetryDelay(client.exhaustion.retries.delay);
      if (client.exhaustion?.timeout !== undefined) parseHandlerTimeout(client.exhaustion.timeout);
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

  private sandboxKey(sessionId: string, clientId: string, environmentId: string): string {
    return JSON.stringify([sessionId, clientId, environmentId]);
  }

  private resourceSandboxDefinition(
    client: RuntimeClient | ClientDefinition,
  ): ResourceSandboxDefinition<JsonValue> | undefined {
    const environment = client.environment as RuntimeEnvironmentDefinition | undefined;
    const handle = environment?.sandboxHandle;
    if (!handle || !isResourceSandboxDefinition(handle)) return undefined;
    return environment.sandbox as ResourceSandboxDefinition<JsonValue>;
  }

  private async createHandlerSandboxAccessor(
    client: RuntimeClient,
    sessionId: string,
    includeCleaningResource = false,
  ): Promise<HandlerSandboxAccessor> {
    const environment = client.environment;
    const handle = environment?.sandboxHandle;
    const definition = this.resourceSandboxDefinition(client);
    const record = definition && environment
      ? await this.getSandbox(sessionId, client.id, environment.id)
      : undefined;
    const resourceAvailable = record !== undefined &&
      (record.status === "active" || (includeCleaningResource && record.status === "cleaning")) &&
      Object.hasOwn(record, "resource");
    if (record?.status === "active" && !resourceAvailable) {
      throw new Error(`Active resource-aware sandbox ${client.id}/${environment!.id} has no published resource`);
    }
    const resource = resourceAvailable
      ? structuredClone(record.resource)
      : undefined;
    const assertConfigured = (requested: ResourceSandboxDefinition<JsonValue>) => {
      if (!definition || requested !== handle) {
        throw new Error(`Sandbox definition is not configured for client ${client.id}`);
      }
    };
    return {
      get<TResource extends JsonValue>(requested: ResourceSandboxDefinition<TResource>): Readonly<TResource> {
        assertConfigured(requested as unknown as ResourceSandboxDefinition<JsonValue>);
        if (!resourceAvailable) {
          throw new Error(`Active sandbox resource not found for ${client.id}/${environment!.id}`);
        }
        return structuredClone(resource) as Readonly<TResource>;
      },
      getOptional<TResource extends JsonValue>(
        requested: ResourceSandboxDefinition<TResource>,
      ): Readonly<TResource> | undefined {
        assertConfigured(requested as unknown as ResourceSandboxDefinition<JsonValue>);
        return structuredClone(resource) as Readonly<TResource> | undefined;
      },
    };
  }

  private async getSandbox(
    sessionId: string,
    clientId: string,
    environmentId: string,
  ): Promise<StoredSandbox | undefined> {
    return this.mutex.run(async () => {
      const state = await this.store.read();
      const sandbox = state.sandboxes.find((candidate) =>
        candidate.sessionId === sessionId &&
        candidate.clientId === clientId &&
        candidate.environmentId === environmentId
      );
      return sandbox ? structuredClone(sandbox) : undefined;
    });
  }

  private async adoptLegacySandbox(
    sessionId: string,
    clientId: string,
    environmentId: string,
  ): Promise<StoredSandbox | undefined> {
    return this.mutex.run(async () => {
      const state = await this.store.read();
      const session = state.sessions.find((candidate) => candidate.id === sessionId);
      const flag = `__sao.sandbox.${environmentId}.created`;
      if (session?.state[flag] !== true) return undefined;
      const owners = this.clients.filter((client) =>
        client.environment?.id === environmentId && client.environment.sandbox !== undefined
      );
      if (owners.length !== 1 || owners[0]!.id !== clientId) {
        throw new Error(
          `Cannot use legacy sandbox ${environmentId} for session ${sessionId}: ownership cannot be safely assigned to a client`,
        );
      }
      const timestamp = nowIso();
      const sandbox: StoredSandbox = {
        sessionId,
        clientId,
        environmentId,
        status: "active",
        checkpoint: {},
        cleanupSteps: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.sandboxes.push(sandbox);
      delete session.state[flag];
      session.updatedAt = timestamp;
      await this.store.write(state);
      return structuredClone(sandbox);
    });
  }

  private async setSandboxStatus(
    sessionId: string,
    clientId: string,
    environmentId: string,
    status: StoredSandbox["status"],
    checkpoint?: JsonRecord,
    error?: unknown,
  ): Promise<StoredSandbox> {
    return this.mutex.run(async () => {
      const state = await this.store.read();
      let sandbox = state.sandboxes.find((candidate) =>
        candidate.sessionId === sessionId &&
        candidate.clientId === clientId &&
        candidate.environmentId === environmentId
      );
      const updatedAt = nowIso();
      if (!sandbox) {
        sandbox = {
          sessionId,
          clientId,
          environmentId,
          status,
          checkpoint: structuredClone(checkpoint ?? {}),
          cleanupSteps: {},
          createdAt: updatedAt,
          updatedAt,
        };
        state.sandboxes.push(sandbox);
      } else {
        sandbox.status = status;
        if (checkpoint !== undefined) sandbox.checkpoint = structuredClone(checkpoint);
        sandbox.cleanupSteps ??= {};
        sandbox.updatedAt = updatedAt;
      }
      sandbox.lastError = error === undefined ? undefined : formatError(error);
      await this.store.write(state);
      return structuredClone(sandbox);
    });
  }

  private async updateSandboxCheckpoint(
    sessionId: string,
    clientId: string,
    environmentId: string,
    update: JsonRecord,
  ): Promise<void> {
    await this.mutex.run(async () => {
      const state = await this.store.read();
      const sandbox = state.sandboxes.find((candidate) =>
        candidate.sessionId === sessionId &&
        candidate.clientId === clientId &&
        candidate.environmentId === environmentId
      );
      if (!sandbox) throw new Error(`Sandbox record not found for ${clientId}/${environmentId}`);
      sandbox.checkpoint = { ...sandbox.checkpoint, ...structuredClone(update) };
      sandbox.updatedAt = nowIso();
      await this.store.write(state);
    });
  }

  private assertPublishedSandboxResource(
    sandbox: StoredSandbox,
  ): asserts sandbox is StoredSandbox & { resource: JsonValue } {
    if (!Object.hasOwn(sandbox, "resource")) {
      throw new Error(`Active resource-aware sandbox ${sandbox.clientId}/${sandbox.environmentId} has no published resource`);
    }
  }

  private async publishSandboxResource(
    sandbox: StoredSandbox,
    resource: JsonValue,
  ): Promise<StoredSandbox> {
    try {
      validateJsonValue(resource);
    } catch (error) {
      throw new Error("Sandbox resource must be JSON-safe", { cause: error });
    }
    return this.mutex.run(async () => {
      const state = await this.store.read();
      const stored = state.sandboxes.find((candidate) =>
        candidate.sessionId === sandbox.sessionId &&
        candidate.clientId === sandbox.clientId &&
        candidate.environmentId === sandbox.environmentId
      );
      if (!stored) {
        throw new Error(`Sandbox record not found for ${sandbox.clientId}/${sandbox.environmentId}`);
      }
      stored.resource = structuredClone(resource);
      stored.updatedAt = nowIso();
      await this.store.write(state);
      return structuredClone(stored);
    });
  }

  private async runSandboxCleanupStep(
    sandbox: StoredSandbox,
    id: string,
    options: SandboxCleanupStepOptions<JsonValue>,
    operation: (ctx: SandboxCleanupStepContext<JsonValue>) => Promise<void> | void,
    context: SandboxCleanupStepContext<JsonValue>,
  ): Promise<void> {
    if (id.trim().length === 0) throw new Error("Sandbox cleanup step id must be a non-empty string");
    const idempotent = options.retry === "idempotent";
    const reconcile = options.reconcile;
    if (idempotent === (typeof reconcile === "function")) {
      throw new Error(`Sandbox cleanup step ${id} must specify either idempotent retry or reconciliation`);
    }
    context.signal.throwIfAborted();

    let storedStep = await this.getSandboxCleanupStep(sandbox, id);
    if (storedStep?.status === "completed") return;
    if (storedStep && !idempotent) {
      let disposition: SandboxCleanupStepDisposition;
      try {
        disposition = await reconcile!(context);
      } catch (error) {
        await this.setSandboxCleanupStep(sandbox, id, {
          ...storedStep,
          status: "unknown",
          updatedAt: nowIso(),
          lastError: formatError(error),
        });
        throw error;
      }
      context.signal.throwIfAborted();
      if (disposition === "completed") {
        const completedAt = nowIso();
        await this.setSandboxCleanupStep(sandbox, id, {
          ...storedStep,
          status: "completed",
          updatedAt: completedAt,
          completedAt,
          lastError: undefined,
        });
        return;
      }
      if (disposition !== "incomplete") {
        const error = new Error(
          disposition === "unknown"
            ? `Sandbox cleanup step ${id} reconciliation remained unknown`
            : `Invalid sandbox cleanup step reconciliation disposition: ${String(disposition)}`,
        );
        await this.setSandboxCleanupStep(sandbox, id, {
          ...storedStep,
          status: "unknown",
          updatedAt: nowIso(),
          lastError: formatError(error),
        });
        throw error;
      }
    }

    context.signal.throwIfAborted();
    const startedAt = nowIso();
    storedStep = await this.setSandboxCleanupStep(sandbox, id, {
      status: "running",
      attempts: (storedStep?.attempts ?? 0) + 1,
      createdAt: storedStep?.createdAt ?? startedAt,
      updatedAt: startedAt,
      startedAt,
    });
    context.signal.throwIfAborted();
    try {
      await operation(context);
    } catch (error) {
      await this.setSandboxCleanupStep(sandbox, id, {
        ...storedStep,
        status: "failed",
        updatedAt: nowIso(),
        lastError: formatError(error),
      });
      throw error;
    }
    const completedAt = nowIso();
    await this.setSandboxCleanupStep(sandbox, id, {
      ...storedStep,
      status: "completed",
      updatedAt: completedAt,
      completedAt,
      lastError: undefined,
    });
  }

  private async getSandboxCleanupStep(
    sandbox: StoredSandbox,
    id: string,
  ): Promise<StoredSandboxCleanupStep | undefined> {
    return this.mutex.run(async () => {
      const state = await this.store.read();
      const stored = state.sandboxes.find((candidate) =>
        candidate.sessionId === sandbox.sessionId &&
        candidate.clientId === sandbox.clientId &&
        candidate.environmentId === sandbox.environmentId
      );
      const step = stored?.cleanupSteps && Object.hasOwn(stored.cleanupSteps, id)
        ? stored.cleanupSteps[id]
        : undefined;
      return step ? structuredClone(step) : undefined;
    });
  }

  private async setSandboxCleanupStep(
    sandbox: StoredSandbox,
    id: string,
    step: StoredSandboxCleanupStep,
  ): Promise<StoredSandboxCleanupStep> {
    return this.mutex.run(async () => {
      const state = await this.store.read();
      const stored = state.sandboxes.find((candidate) =>
        candidate.sessionId === sandbox.sessionId &&
        candidate.clientId === sandbox.clientId &&
        candidate.environmentId === sandbox.environmentId
      );
      if (!stored) throw new Error(`Sandbox record not found for ${sandbox.clientId}/${sandbox.environmentId}`);
      stored.cleanupSteps ??= {};
      stored.cleanupSteps = { ...stored.cleanupSteps, [id]: structuredClone(step) };
      stored.updatedAt = step.updatedAt;
      await this.store.write(state);
      return structuredClone(step);
    });
  }

  private async persistSandboxDisposition(
    sandbox: StoredSandbox,
    disposition: SandboxDisposition,
  ): Promise<StoredSandbox> {
    return this.setSandboxStatus(
      sandbox.sessionId,
      sandbox.clientId,
      sandbox.environmentId,
      disposition,
    );
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

  private async withSandboxLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort();
    const acquire = (index: number): Promise<T> => {
      const key = ordered[index];
      return key === undefined ? fn() : this.withSandboxLock(key, () => acquire(index + 1));
    };
    return acquire(0);
  }

  private async withSandboxCleanupStepLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.sandboxCleanupStepLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.sandboxCleanupStepLocks.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.sandboxCleanupStepLocks.get(key) === tail) this.sandboxCleanupStepLocks.delete(key);
    }
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
}
