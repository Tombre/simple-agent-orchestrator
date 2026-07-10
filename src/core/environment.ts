import type { DispatchEvent, KeyLike, Logger, ProjectContext } from "./types.js";
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

export interface SandboxContext extends EnvironmentHookContext {
  session: Session;
  event: DispatchEvent;
}

export interface SandboxDefinition {
  create(ctx: SandboxContext): Promise<void> | void;
  cleanup?(ctx: SandboxContext): Promise<void> | void;
}

export interface EnvironmentBuilder {
  onMount(hook: (ctx: EnvironmentHookContext) => Promise<void> | void): void;
  onUnmount(hook: (ctx: EnvironmentHookContext) => Promise<void> | void): void;
  useSandbox(sandbox: SandboxDefinition): void;
}

export interface EnvironmentDefinition {
  readonly id: string;
  readonly mountHooks: ((ctx: EnvironmentHookContext) => Promise<void> | void)[];
  readonly unmountHooks: ((ctx: EnvironmentHookContext) => Promise<void> | void)[];
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
  const mountHooks: EnvironmentDefinition["mountHooks"] = [];
  const unmountHooks: EnvironmentDefinition["unmountHooks"] = [];
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
    mountHooks,
    unmountHooks,
    sandbox,
  };
}

export function createEmptyEnvironment(): EnvironmentDefinition {
  return createEnvironment("default", () => {});
}
