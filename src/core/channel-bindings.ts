import type { ChannelDefinition, ChannelRuntimeApi } from "./channel.js";

const runtimeBindings = new WeakMap<ChannelDefinition, Map<object, ChannelRuntimeApi["dispatch"]>>();

export function bindChannelRuntime(
  channel: ChannelDefinition,
  runtime: object,
  dispatch: ChannelRuntimeApi["dispatch"],
): void {
  const bindings = runtimeBindings.get(channel) ?? new Map();
  bindings.set(runtime, dispatch);
  runtimeBindings.set(channel, bindings);
}

export function getChannelRuntimeBindings(
  channel: ChannelDefinition,
): ReadonlyMap<object, ChannelRuntimeApi["dispatch"]> | undefined {
  return runtimeBindings.get(channel);
}

export function unbindChannelRuntime(channel: ChannelDefinition, runtime: object): void {
  const bindings = runtimeBindings.get(channel);
  if (!bindings) return;
  bindings.delete(runtime);
  if (bindings.size === 0) runtimeBindings.delete(channel);
}
