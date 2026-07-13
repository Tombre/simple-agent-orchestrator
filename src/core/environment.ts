import type {
  DispatchEvent,
  JsonRecord,
  JsonValue,
  KeyLike,
  Logger,
  ProjectContext,
  SandboxStatus,
} from "./types.js";
import { keyName } from "./types.js";
import type { ReadonlySession, Session } from "./session.js";

const resourceSandboxBrand = Symbol.for("simple-agent-orchestrator.resource-sandbox");
declare const sandboxResourceType: unique symbol;

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
  readonly currentStatus: SandboxStatus;
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
export type SandboxCleanupStepDisposition = "completed" | "incomplete" | "unknown";

export interface SandboxDefinition {
  readonly create: (ctx: SandboxDeliveryContext) => Promise<void> | void;
  readonly reconcile?: (ctx: SandboxContext) => Promise<SandboxDisposition> | SandboxDisposition;
  readonly cleanup?: (ctx: SandboxContext) => Promise<void> | void;
}

export type SandboxResourceCreateContext<TResource extends JsonValue> = SandboxDeliveryContext & {
  publishResource(resource: TResource): Promise<void>;
};

export type SandboxResourcePrepareContext<TResource extends JsonValue> = SandboxDeliveryContext & {
  readonly resource?: Readonly<TResource> | undefined;
  publishResource(resource: TResource): Promise<void>;
};

export type SandboxResourceReconcileContext<TResource extends JsonValue> = SandboxContext & {
  readonly resource?: Readonly<TResource> | undefined;
  publishResource(resource: TResource): Promise<void>;
};

export type SandboxCleanupStepContext<TResource extends JsonValue> =
  | (Omit<SandboxDeliveryContext, "session"> & {
      readonly session: ReadonlySession;
      readonly resource: Readonly<TResource>;
    })
  | (Omit<SandboxCompletionContext, "session"> & {
      readonly session: ReadonlySession;
      readonly resource: Readonly<TResource>;
    });

export type SandboxCleanupStepOptions<TResource extends JsonValue> =
  | {
      readonly retry: "idempotent";
      readonly reconcile?: never;
    }
  | {
      readonly retry?: never;
      readonly reconcile: (
        ctx: SandboxCleanupStepContext<TResource>,
      ) => Promise<SandboxCleanupStepDisposition> | SandboxCleanupStepDisposition;
    };

export interface SandboxCleanup<TResource extends JsonValue> {
  step(
    id: string,
    options: SandboxCleanupStepOptions<TResource>,
    operation: (ctx: SandboxCleanupStepContext<TResource>) => Promise<void> | void,
  ): Promise<void>;
}

export type SandboxResourceCleanupContext<TResource extends JsonValue> = SandboxContext & {
  readonly resource: Readonly<TResource>;
  readonly cleanup: SandboxCleanup<TResource>;
};

export interface ResourceSandboxDefinition<TResource extends JsonValue> {
  readonly [sandboxResourceType]?: TResource;
  readonly create: (
    ctx: SandboxResourceCreateContext<TResource>,
  ) => Promise<TResource | void> | TResource | void;
  readonly prepare?: (
    ctx: SandboxResourcePrepareContext<TResource>,
  ) => Promise<TResource | void> | TResource | void;
  readonly reconcile?: (
    ctx: SandboxResourceReconcileContext<TResource>,
  ) => Promise<SandboxDisposition> | SandboxDisposition;
  readonly cleanup?: (
    ctx: SandboxResourceCleanupContext<TResource>,
  ) => Promise<void> | void;
}

export function createSandbox<TResource extends JsonValue>(
  definition: ResourceSandboxDefinition<TResource>,
): ResourceSandboxDefinition<TResource> {
  Object.defineProperty(definition, resourceSandboxBrand, { value: true });
  return definition;
}

export function isResourceSandboxDefinition(
  definition: SandboxDefinition | ResourceSandboxDefinition<JsonValue>,
): definition is ResourceSandboxDefinition<JsonValue> {
  return (definition as ResourceSandboxDefinition<JsonValue> & { [resourceSandboxBrand]?: unknown })[
    resourceSandboxBrand
  ] === true;
}

export type AnySandboxDefinition = SandboxDefinition | ResourceSandboxDefinition<JsonValue>;

export interface EnvironmentBuilder {
  onMount(hook: (ctx: EnvironmentHookContext) => Promise<void> | void): void;
  onUnmount(hook: (ctx: EnvironmentHookContext) => Promise<void> | void): void;
  useSandbox(sandbox: SandboxDefinition): void;
  useSandbox<TResource extends JsonValue>(sandbox: ResourceSandboxDefinition<TResource>): void;
}

export interface EnvironmentDefinition {
  readonly id: string;
  readonly mountHooks: readonly ((ctx: EnvironmentHookContext) => Promise<void> | void)[];
  readonly unmountHooks: readonly ((ctx: EnvironmentHookContext) => Promise<void> | void)[];
  readonly sandbox?: AnySandboxDefinition | undefined;
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
  let sandbox: AnySandboxDefinition | undefined;

  const builder: EnvironmentBuilder = {
    onMount(hook) {
      mountHooks.push(hook);
    },
    onUnmount(hook) {
      unmountHooks.push(hook);
    },
    useSandbox(next: AnySandboxDefinition) {
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
