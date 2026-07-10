import type { DispatchEvent, Logger, ProjectContext } from "./types.js";

export interface Cursor {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
  delete(key: string): void;
  entries(): Record<string, unknown>;
}

export interface PollContext {
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
  every: number | string;
  immediate?: boolean;
  fetch(ctx: PollContext): Promise<TRaw[]> | TRaw[];
  map?(item: TRaw, ctx: PollContext): Promise<DispatchEvent | null | undefined> | DispatchEvent | null | undefined;
  commit?(ctx: PollCommitContext<TRaw>): Promise<void> | void;
}

export interface ChannelRuntimeApi {
  readonly id: string;
  dispatch(event: DispatchEvent): Promise<{ status: "queued" | "duplicate"; eventId: string }>;
}

export interface ChannelBuilder {
  poll<TRaw = unknown>(definition: PollDefinition<TRaw>): void;
}

export interface ChannelDefinition {
  readonly id: string;
  readonly polls: PollDefinition[];
  dispatch(event: DispatchEvent): Promise<{ status: "queued" | "duplicate"; eventId: string }>;
  __attachDispatch(dispatch: ChannelRuntimeApi["dispatch"]): void;
}

export function createChannel(id: string, setup?: (channel: ChannelBuilder) => void): ChannelDefinition {
  const polls: PollDefinition[] = [];
  let runtimeDispatch: ChannelRuntimeApi["dispatch"] | undefined;

  const builder: ChannelBuilder = {
    poll(definition) {
      polls.push(definition as PollDefinition);
    },
  };

  setup?.(builder);

  return {
    id,
    polls,
    async dispatch(event) {
      if (!runtimeDispatch) {
        throw new Error(
          `Channel ${id} is not attached to a running orchestrator. Use runtime.dispatch(...) or start the orchestrator first.`,
        );
      }
      return runtimeDispatch(event);
    },
    __attachDispatch(dispatch) {
      runtimeDispatch = dispatch;
    },
  };
}

export function createManualChannel(id = "manual"): ChannelDefinition {
  return createChannel(id);
}

export class CursorImpl implements Cursor {
  constructor(private readonly state: Record<string, unknown>) {}

  get<T = unknown>(key: string): T | undefined {
    return this.state[key] as T | undefined;
  }

  set<T = unknown>(key: string, value: T): void {
    this.state[key] = value;
  }

  delete(key: string): void {
    delete this.state[key];
  }

  entries(): Record<string, unknown> {
    return { ...this.state };
  }
}
