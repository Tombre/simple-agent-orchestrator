import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ConfigFactory, OrchestratorConfig } from "../core/config.js";
import type { ProjectContext } from "../core/types.js";
import { jsonFileStore } from "../stores/json-file.js";
import { OrchestratorRuntime } from "./runtime.js";

const CONFIG_NAMES = [
  "orchestrator.ts",
  "orchestrator.mts",
  "orchestrator.cts",
  "orchestrator.js",
  "orchestrator.mjs",
  "orchestrator.cjs",
];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function findUp(start: string, predicate: (dir: string) => Promise<boolean>): Promise<string | undefined> {
  let current = resolve(start);
  while (true) {
    if (await predicate(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function findProjectBoundary(start: string): Promise<string | undefined> {
  const boundary = await findUp(start, async (directory) => {
    if (basename(directory) === ".simple-agent-orchestrator") return true;
    return (await exists(join(directory, ".simple-agent-orchestrator"))) ||
      (await exists(join(directory, "package.json")));
  });
  return boundary && basename(boundary) === ".simple-agent-orchestrator"
    ? dirname(boundary)
    : boundary;
}

export async function findProjectRoot(options: { cwd?: string; root?: string; config?: string } = {}): Promise<string> {
  if (options.root) return resolve(options.root);
  if (options.config) {
    const configDir = dirname(resolve(options.cwd ?? process.cwd(), options.config));
    return (await findProjectBoundary(configDir)) ?? configDir;
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  return (await findProjectBoundary(cwd)) ?? cwd;
}

export async function createProjectContext(root: string): Promise<ProjectContext> {
  const projectRoot = resolve(root);
  const packageJson = await readJson(join(projectRoot, "package.json"));
  const orchestratorDir = join(projectRoot, ".simple-agent-orchestrator");

  const ctx: ProjectContext = {
    root: projectRoot,
    orchestratorDir,
    packageJson,
    resolve(...parts: string[]) {
      return resolve(projectRoot, ...parts);
    },
    fromRoot(...parts: string[]) {
      return resolve(projectRoot, ...parts);
    },
    fromOrchestrator(...parts: string[]) {
      return resolve(orchestratorDir, ...parts);
    },
    statePath(...parts: string[]) {
      return resolve(orchestratorDir, "state", ...parts);
    },
    cachePath(...parts: string[]) {
      return resolve(orchestratorDir, "tmp", ...parts);
    },
  };

  return ctx;
}

export async function findConfigFile(project: ProjectContext, explicitConfig?: string): Promise<string> {
  if (explicitConfig) return isAbsolute(explicitConfig) ? explicitConfig : resolve(project.root, explicitConfig);

  for (const name of CONFIG_NAMES) {
    const candidate = join(project.orchestratorDir, name);
    if (await exists(candidate)) return candidate;
  }

  const pointer = project.packageJson.simpleAgentOrchestrator;
  if (typeof pointer === "string") return resolve(project.root, pointer);
  if (pointer && typeof pointer === "object" && "config" in pointer) {
    const config = (pointer as { config?: unknown }).config;
    if (typeof config === "string") return resolve(project.root, config);
  }

  throw new Error(
    `Could not find .simple-agent-orchestrator/orchestrator.ts under ${project.root}. Run: npx simple-agent-orchestrator init`,
  );
}

export async function loadConfigFile(configFile: string, project: ProjectContext): Promise<OrchestratorConfig> {
  const previousCwd = process.cwd();
  process.chdir(project.root);
  try {
    const extension = configFile.split(".").pop();
    let mod: unknown;
    if (extension === "ts" || extension === "mts" || extension === "cts") {
      const tsx = (await import("tsx/esm/api")) as {
        tsImport: (path: string, parentUrl: string) => Promise<unknown>;
      };
      mod = await tsx.tsImport(configFile, import.meta.url);
    } else {
      mod = await import(pathToFileURL(configFile).href);
    }

    const maybeDefault = (mod as { default?: unknown }).default ?? mod;
    const factory = maybeDefault as ConfigFactory;
    const config = typeof factory === "function" ? await factory({ project }) : factory;
    return {
      ...config,
      store: config.store ?? jsonFileStore(project.statePath("state.json")),
    };
  } finally {
    process.chdir(previousCwd);
  }
}

export interface LoadProjectOptions {
  cwd?: string;
  root?: string;
  config?: string;
}

export type CreateRuntimeOptions =
  | { project: ProjectContext; cwd?: never; root?: never }
  | { project?: never; cwd?: string; root?: string };

export async function createRuntime(
  factory: ConfigFactory,
  options: CreateRuntimeOptions = {},
): Promise<OrchestratorRuntime> {
  if (options.project !== undefined && (options.root !== undefined || options.cwd !== undefined)) {
    throw new Error("Runtime options cannot specify project together with root or cwd");
  }
  const project = options.project ?? await createProjectContext(await findProjectRoot(options));
  const config = typeof factory === "function" ? await factory({ project }) : factory;
  return new OrchestratorRuntime({
    project,
    config: {
      ...config,
      store: config.store ?? jsonFileStore(project.statePath("state.json")),
    },
  });
}

export async function loadProjectConfig(options: LoadProjectOptions = {}): Promise<{
  project: ProjectContext;
  configFile: string;
  config: OrchestratorConfig;
}> {
  const explicitConfig = options.config
    ? isAbsolute(options.config)
      ? options.config
      : resolve(options.root ?? options.cwd ?? process.cwd(), options.config)
    : undefined;
  const rootOptions = explicitConfig ? { ...options, config: explicitConfig } : options;
  const root = await findProjectRoot(rootOptions);
  const project = await createProjectContext(root);
  const configFile = await findConfigFile(project, explicitConfig);
  const config = await loadConfigFile(configFile, project);
  return { project, configFile, config };
}

export async function loadProjectOrchestrator(options: LoadProjectOptions = {}): Promise<{
  project: ProjectContext;
  configFile: string;
  runtime: OrchestratorRuntime;
}> {
  const { project, configFile, config } = await loadProjectConfig(options);
  const runtime = new OrchestratorRuntime({ project, config });
  return { project, configFile, runtime };
}
