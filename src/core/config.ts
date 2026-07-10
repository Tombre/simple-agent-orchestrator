import type { ChannelDefinition } from "./channel.js";
import type { ClientDefinition } from "./client.js";
import type { DispatchEvent, Logger, ProjectContext, RetryOptions } from "./types.js";
import type { Store } from "../stores/store.js";
import type { Hono } from "hono";

export interface DefineConfigContext {
  project: ProjectContext;
}

export type HttpDispatch = (
  channelId: string,
  event: DispatchEvent,
) => Promise<{ status: "queued" | "duplicate"; eventId: string }>;

export interface HttpRegistrationContext {
  app: Hono;
  project: ProjectContext;
  logger: Logger;
  signal: AbortSignal;
  dispatch: HttpDispatch;
}

export type HttpRegistrationHook = (context: HttpRegistrationContext) => void | Promise<void>;

export interface HttpConfig {
  enabled?: boolean;
  hostname?: string;
  port?: number;
  middleware?: HttpRegistrationHook;
  routes?: HttpRegistrationHook;
}

export interface OrchestratorConfig {
  name?: string;
  store?: Store;
  channels?: ChannelDefinition[];
  clients?: ClientDefinition[];
  logger?: Logger;
  retries?: RetryOptions;
  timeout?: number | string;
  http?: HttpConfig;
}

export type ConfigFactory =
  | OrchestratorConfig
  | ((ctx: DefineConfigContext) => OrchestratorConfig | Promise<OrchestratorConfig>);

export function defineConfig(factory: ConfigFactory): ConfigFactory {
  return factory;
}
