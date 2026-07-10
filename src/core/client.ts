import type { ChannelDefinition } from "./channel.js";
import type { EnvironmentDefinition, EnvironmentInstance } from "./environment.js";
import type {
  ConcurrencyOptions,
  Logger,
  OrchestratorEvent,
  ProjectContext,
  RetryOptions,
} from "./types.js";
import type { Session } from "./session.js";

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
  id?: string;
  retries?: RetryOptions;
  handle: EventHandler<TPayload, TInput, TMeta>;
  onSuccess?: (ctx: HandlerContext<TPayload, TInput, TMeta>) => Promise<void> | void;
  onFailure?: (ctx: HandlerContext<TPayload, TInput, TMeta> & { error: unknown }) => Promise<void> | void;
}

export interface RegisteredHandler {
  id: string;
  channelId: string;
  channel: ChannelDefinition;
  retries: RetryOptions;
  handle: EventHandler;
  onSuccess?: ((ctx: HandlerContext) => Promise<void> | void) | undefined;
  onFailure?: ((ctx: HandlerContext & { error: unknown }) => Promise<void> | void) | undefined;
}

export interface ClientBuilder {
  useEnvironment(environment: EnvironmentDefinition): void;
  concurrency(options: ConcurrencyOptions): void;
  retries(options: RetryOptions): void;
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
  readonly handlers: RegisteredHandler[];
  readonly environment?: EnvironmentDefinition | undefined;
  readonly concurrencyOptions: Required<ConcurrencyOptions>;
  readonly retryOptions: RetryOptions;
}

export function createClient(id: string, setup: (client: ClientBuilder) => void): ClientDefinition {
  const handlers: RegisteredHandler[] = [];
  let environment: EnvironmentDefinition | undefined;
  let concurrencyOptions: Required<ConcurrencyOptions> = { workers: 1, perSession: false };
  let retryOptions: RetryOptions = {};

  const builder: ClientBuilder = {
    useEnvironment(next) {
      environment = next;
    },
    concurrency(options) {
      concurrencyOptions = {
        workers: Math.max(1, options.workers ?? concurrencyOptions.workers),
        perSession: options.perSession ?? concurrencyOptions.perSession,
      };
    },
    retries(options) {
      if (options.attempts !== undefined) retryOptions = { attempts: Math.max(1, options.attempts) };
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
        retries: options.retries?.attempts !== undefined
          ? { attempts: Math.max(1, options.retries.attempts) }
          : { ...retryOptions },
        handle: options.handle as EventHandler,
        onSuccess: options.onSuccess as RegisteredHandler["onSuccess"],
        onFailure: options.onFailure as RegisteredHandler["onFailure"],
      });
    },
  };

  setup(builder);

  return {
    id,
    handlers,
    environment,
    concurrencyOptions,
    retryOptions,
  };
}
