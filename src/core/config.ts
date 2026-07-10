import type { ChannelDefinition } from "./channel.js";
import type { ClientDefinition } from "./client.js";
import type { Logger, ProjectContext, RetryOptions } from "./types.js";
import type { Store } from "../stores/store.js";

export interface DefineConfigContext {
  project: ProjectContext;
}

export interface OrchestratorConfig {
  name?: string;
  store?: Store;
  channels?: ChannelDefinition[];
  clients?: ClientDefinition[];
  logger?: Logger;
  retries?: RetryOptions;
  timeout?: number | string;
}

export type ConfigFactory =
  | OrchestratorConfig
  | ((ctx: DefineConfigContext) => OrchestratorConfig | Promise<OrchestratorConfig>);

export function defineConfig(factory: ConfigFactory): ConfigFactory {
  return factory;
}
