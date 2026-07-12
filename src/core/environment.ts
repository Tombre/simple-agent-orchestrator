import type { DispatchEvent, JsonRecord, KeyLike, Logger, ProjectContext } from "./types.js";
import { keyName } from "./types.js";
import type { Session } from "./session.js";

export interface EnvironmentInstance {
  readonly id: string;
  get<T = unknown>(key: KeyLike<T>): T;
  getOptional<T = unknown>(key: KeyLike<T>): T | undefined;
  set<T = unknown>(key: KeyLike<T>, value: T): void;
  has(key: KeyLike): boolean;
  delete(key: KeyLike): void;
}

export interface EnvironmentHookContext {
  environment: EnvironmentInstance;
  project: ProjectContext;
  logger: Logger;
  signal: AbortSignal;
}

interface SandboxContextBase extends EnvironmentHookContext {
  session: Session;
  readonly currentCheckpoint: Readonly<JsonRecord>;
  checkpoint(update: JsonRecord): Promise<void>;
}

export interface SandboxDeliveryContext extends SandboxContextBase {
  readonly cause: { readonly type: "delivery" };
  event: DispatchEvent;
}

export interface SandboxCompletionContext extends SandboxContextBase {
  readonly cause: { readonly type: "completion"; readonly reason?: string | undefined };
  event?: undefined;
}

export type SandboxContext = SandboxDeliveryContext | SandboxCompletionContext;
export type SandboxDisposition = "active" | "cleaned" | "unknown";

export interface SandboxDefinition {
  readonly create: (ctx: SandboxDeliveryContext) => Promise<void> | void;
  readonly reconcile?: (ctx: SandboxContext) => Promise<SandboxDisposition> | SandboxDisposition;
  readonly cleanup?: (ctx: SandboxContext) => Promise<void> | void;
}

export interface EnvironmentBuilder {
  onMount(hook: (ctx: EnvironmentHookContext) => Promise<void> | void): void;
  onUnmount(hook: (ctx: EnvironmentHookContext) => Promise<void> | void): void;
  useSandbox(sandbox: SandboxDefinition): void;
}

export interface EnvironmentDefinition {
  readonly id: string;
  readonly mountHooks: readonly ((ctx: EnvironmentHookContext) => Promise<void> | void)[];
  readonly unmountHooks: readonly ((ctx: EnvironmentHookContext) => Promise<void> | void)[];
  readonly sandbox?: SandboxDefinition | undefined;
}

export class EnvironmentInstanceImpl implements EnvironmentInstance {
  private readonly values = new Map<string, unknown>();

  constructor(readonly id: string) {}

  get<T = unknown>(key: KeyLike<T>): T {
    const name = keyName(key);
    if (!this.values.has(name)) throw new Error(`Environment value not found: ${name}`);
    return this.values.get(name) as T;
  }

  getOptional<T = unknown>(key: KeyLike<T>): T | undefined {
    return this.values.get(keyName(key)) as T | undefined;
  }

  set<T = unknown>(key: KeyLike<T>, value: T): void {
    this.values.set(keyName(key), value);
  }

  has(key: KeyLike): boolean {
    return this.values.has(keyName(key));
  }

  delete(key: KeyLike): void {
    this.values.delete(keyName(key));
  }
}

export function createEnvironment(
  id: string,
  setup: (environment: EnvironmentBuilder) => void,
): EnvironmentDefinition {
  const mountHooks: Array<(ctx: EnvironmentHookContext) => Promise<void> | void> = [];
  const unmountHooks: Array<(ctx: EnvironmentHookContext) => Promise<void> | void> = [];
  let sandbox: SandboxDefinition | undefined;

  const builder: EnvironmentBuilder = {
    onMount(hook) {
      mountHooks.push(hook);
    },
    onUnmount(hook) {
      unmountHooks.push(hook);
    },
    useSandbox(next) {
      sandbox = next;
    },
  };

  setup(builder);

  return {
    id,
    mountHooks: [...mountHooks],
    unmountHooks: [...unmountHooks],
    sandbox,
  };
}

export function createEmptyEnvironment(): EnvironmentDefinition {
  return createEnvironment("default", () => {});
}
