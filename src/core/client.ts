import type { ChannelDefinition } from "./channel.js";
import type {
  EnvironmentDefinition,
  EnvironmentInstance,
  ResourceSandboxDefinition,
} from "./environment.js";
import type {
  CapacityOptions,
  ConcurrencyOptions,
  Logger,
  JsonValue,
  OrchestratorEvent,
  ProjectContext,
  RetryOptions,
  FailureStage,
  StoredDelivery,
  StoredFailureDescriptor,
} from "./types.js";
import type { ReadonlySession, Session } from "./session.js";

export interface HandlerContext<
  TPayload = unknown,
  TInput = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  event: OrchestratorEvent<TPayload, TInput, TMeta>;
  session: Session;
  environment: EnvironmentInstance;
  client: ClientDefinition;
  project: ProjectContext;
  logger: Logger;
  attempt: number;
  signal: AbortSignal;
  capacity: HandlerCapacity;
  sandbox: HandlerSandboxAccessor;
}

export interface HandlerSandboxAccessor {
  get<TResource extends JsonValue>(definition: ResourceSandboxDefinition<TResource>): Readonly<TResource>;
  getOptional<TResource extends JsonValue>(
    definition: ResourceSandboxDefinition<TResource>,
  ): Readonly<TResource> | undefined;
}

export interface HandlerCapacity {
  readonly reserved: boolean;
  release(): void;
}

export type EventHandler<
  TPayload = unknown,
  TInput = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> = (ctx: HandlerContext<TPayload, TInput, TMeta>) => Promise<void> | void;

export interface HandleOptions<
  TPayload = unknown,
  TInput = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly id?: string;
  readonly session?: "existing-only";
  readonly retries?: RetryOptions;
  readonly timeout?: number | string;
  readonly handle: EventHandler<TPayload, TInput, TMeta>;
  readonly onSuccess?: (ctx: HandlerContext<TPayload, TInput, TMeta>) => Promise<void> | void;
  readonly onFailure?: (ctx: HandlerContext<TPayload, TInput, TMeta> & { error: unknown; stage: FailureStage }) => Promise<void> | void;
}

export interface ExhaustionContext {
  event: OrchestratorEvent;
  sourceDelivery: Readonly<StoredDelivery>;
  session?: ReadonlySession | undefined;
  stage: FailureStage;
  failure: Readonly<StoredFailureDescriptor>;
  attempt: number;
  signal: AbortSignal;
  project: ProjectContext;
  logger: Logger;
  environment: EnvironmentInstance;
  client: ClientDefinition;
}

export interface ExhaustionOptions {
  readonly retries?: RetryOptions;
  readonly timeout?: number | string;
  readonly handle: (ctx: ExhaustionContext) => Promise<void> | void;
}

export interface RegisteredExhaustionHandler {
  readonly retries: Readonly<RetryOptions>;
  readonly timeout?: number | string | undefined;
  readonly handle: ExhaustionOptions["handle"];
}

export interface RegisteredHandler {
  readonly id: string;
  readonly channelId: string;
  readonly channel: ChannelDefinition;
  readonly session?: "existing-only" | undefined;
  readonly retries: Readonly<RetryOptions>;
  readonly timeout?: number | string | undefined;
  readonly handle: EventHandler;
  readonly onSuccess?: ((ctx: HandlerContext) => Promise<void> | void) | undefined;
  readonly onFailure?: ((ctx: HandlerContext & { error: unknown; stage: FailureStage }) => Promise<void> | void) | undefined;
}

export interface ClientBuilder {
  useEnvironment(environment: EnvironmentDefinition): void;
  capacity(options: CapacityOptions): void;
  concurrency(options: ConcurrencyOptions): void;
  retries(options: RetryOptions): void;
  timeout(value: number | string): void;
  onExhausted(options: ExhaustionOptions): void;
  handle<
    TPayload = unknown,
    TInput = unknown,
    TMeta extends Record<string, unknown> = Record<string, unknown>,
  >(
    channel: ChannelDefinition,
    handler: EventHandler<TPayload, TInput, TMeta> | HandleOptions<TPayload, TInput, TMeta>,
  ): void;
}

export interface ClientDefinition {
  readonly id: string;
  readonly handlers: readonly RegisteredHandler[];
  readonly environment?: EnvironmentDefinition | undefined;
  readonly capacityOptions?: Readonly<CapacityOptions> | undefined;
  readonly concurrencyOptions: Readonly<Required<ConcurrencyOptions>>;
  readonly retryOptions: Readonly<RetryOptions>;
  readonly timeout?: number | string | undefined;
  readonly exhaustion?: RegisteredExhaustionHandler | undefined;
}

export function createClient(id: string, setup: (client: ClientBuilder) => void): ClientDefinition {
  const handlers: RegisteredHandler[] = [];
  let environment: EnvironmentDefinition | undefined;
  let capacityOptions: CapacityOptions | undefined;
  let concurrencyOptions: Required<ConcurrencyOptions> = { workers: 1, perSession: false };
  let retryOptions: RetryOptions = {};
  let timeout: number | string | undefined;
  let exhaustion: RegisteredExhaustionHandler | undefined;

  const builder: ClientBuilder = {
    useEnvironment(next) {
      environment = next;
    },
    capacity(options) {
      if (!Number.isSafeInteger(options.maxActiveSessions) || options.maxActiveSessions < 1) {
        throw new Error("Capacity maxActiveSessions must be a positive integer");
      }
      capacityOptions = { maxActiveSessions: options.maxActiveSessions };
    },
    concurrency(options) {
      concurrencyOptions = {
        workers: Math.max(1, options.workers ?? concurrencyOptions.workers),
        perSession: options.perSession ?? concurrencyOptions.perSession,
      };
    },
    retries(options) {
      retryOptions = {
        ...retryOptions,
        ...(options.attempts !== undefined ? { attempts: Math.max(1, options.attempts) } : {}),
        ...(options.delay !== undefined ? { delay: options.delay } : {}),
      };
    },
    timeout(value) {
      timeout = value;
    },
    onExhausted(options) {
      if (exhaustion) throw new Error(`Client ${id} already has an exhaustion handler`);
      exhaustion = {
        retries: {
          ...(options.retries?.attempts !== undefined ? { attempts: Math.max(1, options.retries.attempts) } : {}),
          ...(options.retries?.delay !== undefined ? { delay: options.retries.delay } : {}),
        },
        timeout: options.timeout,
        handle: options.handle,
      };
    },
    handle(channel, handlerOrOptions) {
      const options = (typeof handlerOrOptions === "function"
        ? { handle: handlerOrOptions }
        : handlerOrOptions) as HandleOptions<any, any, any>;
      const handlerId = options.id ?? `${id}:${channel.id}:${handlers.length + 1}`;
      handlers.push({
        id: handlerId,
        channelId: channel.id,
        channel,
        session: options.session,
        retries: {
          ...retryOptions,
          ...(options.retries?.attempts !== undefined ? { attempts: Math.max(1, options.retries.attempts) } : {}),
          ...(options.retries?.delay !== undefined ? { delay: options.retries.delay } : {}),
        },
        timeout: options.timeout ?? timeout,
        handle: options.handle as EventHandler,
        onSuccess: options.onSuccess as RegisteredHandler["onSuccess"],
        onFailure: options.onFailure as RegisteredHandler["onFailure"],
      });
    },
  };

  setup(builder);

  return {
    id,
    handlers: [...handlers],
    environment,
    capacityOptions,
    concurrencyOptions,
    retryOptions,
    timeout,
    exhaustion,
  };
}
