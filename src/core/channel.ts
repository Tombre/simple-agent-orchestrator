import type { DispatchEvent, DispatchResult, KeyLike, Logger, ProjectContext } from "./types.js";
import { keyName } from "./types.js";
import { getChannelRuntimeBindings } from "./channel-bindings.js";

export interface Cursor {
  get<T = unknown>(key: KeyLike<T>): T | undefined;
  set<T = unknown>(key: KeyLike<T>, value: T): void;
  delete(key: KeyLike): void;
  entries(): Record<string, unknown>;
}

export interface PollContext {
  pollStartedAt: string;
  channel: ChannelRuntimeApi;
  cursor: Cursor;
  project: ProjectContext;
  logger: Logger;
  signal: AbortSignal;
}

export interface PollCommitContext<TRaw = unknown> extends PollContext {
  items: TRaw[];
  events: DispatchEvent[];
}

export interface PollDefinition<TRaw = unknown> {
  readonly id?: string;
  readonly every: number | string;
  readonly immediate?: boolean;
  readonly fetch: (ctx: PollContext) => Promise<TRaw[]> | TRaw[];
  readonly map?: (
    item: TRaw,
    ctx: PollContext,
  ) => Promise<DispatchEvent | readonly DispatchEvent[] | null | undefined>
    | DispatchEvent
    | readonly DispatchEvent[]
    | null
    | undefined;
  readonly commit?: (ctx: PollCommitContext<TRaw>) => Promise<void> | void;
}

export function pollCursorId(channelId: string, poll: PollDefinition, index: number): string {
  return `${channelId}:${poll.id ?? index}`;
}

export interface ChannelRuntimeApi {
  readonly id: string;
  readonly dispatch: (event: DispatchEvent) => Promise<DispatchResult>;
}

export interface ChannelBuilder {
  poll<TRaw = unknown>(definition: PollDefinition<TRaw>): void;
}

export interface ChannelDefinition {
  readonly id: string;
  readonly polls: readonly PollDefinition[];
  readonly dispatch: (event: DispatchEvent) => Promise<DispatchResult>;
}

export function createChannel(id: string, setup?: (channel: ChannelBuilder) => void): ChannelDefinition {
  const polls: PollDefinition[] = [];

  const builder: ChannelBuilder = {
    poll(definition) {
      polls.push(definition as PollDefinition);
    },
  };

  setup?.(builder);

  const definition: ChannelDefinition = {
    id,
    polls: [...polls],
    async dispatch(event) {
      const bindings = getChannelRuntimeBindings(definition);
      if (!bindings || bindings.size === 0) {
        throw new Error(
          `Channel ${id} is not bound to an initialized orchestrator runtime. Use runtime.dispatch(...) or initialize the runtime first.`,
        );
      }
      if (bindings.size > 1) {
        throw new Error(
          `Channel ${id} is bound to multiple initialized orchestrator runtimes. Use runtime.dispatch(...) to select one explicitly.`,
        );
      }
      return [...bindings.values()][0]!(event);
    },
  };

  return definition;
}

export function createManualChannel(id = "manual"): ChannelDefinition {
  return createChannel(id);
}

export class CursorImpl implements Cursor {
  constructor(private readonly state: Record<string, unknown>) {}

  get<T = unknown>(key: KeyLike<T>): T | undefined {
    return this.state[keyName(key)] as T | undefined;
  }

  set<T = unknown>(key: KeyLike<T>, value: T): void {
    this.state[keyName(key)] = value;
  }

  delete(key: KeyLike): void {
    delete this.state[keyName(key)];
  }

  entries(): Record<string, unknown> {
    return { ...this.state };
  }
}
