#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectOrchestrator } from "./runtime/project.js";
import { env } from "./utils/env.js";

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

interface CommandSchema {
  usage: string;
  minPositionals: number;
  maxPositionals: number;
  stringFlags?: readonly string[];
  booleanFlags?: readonly string[];
  requiredFlags?: readonly string[];
}

const COMMON_FLAGS = ["root", "config"] as const;

const SCHEMAS: Record<string, CommandSchema> = {
  init: schema("init [--root <path>] [--force]", 1, 1, ["root"], ["force"]),
  start: schema("start [--root <path>] [--config <path>] [--drain] [--no-http]", 1, 1, COMMON_FLAGS, ["drain", "no-http"]),
  doctor: schema("doctor [--root <path>] [--config <path>]", 1, 1, COMMON_FLAGS),
  "print-config": schema("print-config [--root <path>] [--config <path>]", 1, 1, COMMON_FLAGS),
  state: schema("state <validate|prune>", 1, 1),
  "state validate": schema("state validate [--root <path>] [--config <path>]", 2, 2, COMMON_FLAGS),
  "state prune": schema("state prune --before <timestamp> [--apply] [--drop-dedupe] [--root <path>] [--config <path>]", 2, 2, [...COMMON_FLAGS, "before"], ["apply", "drop-dedupe"], ["before"]),
  dispatch: schema("dispatch <channel> --id <id> [--session <session-key>] [--input <text>] [--type <type>] [--payload-json <json>] [--meta-json <json>] [--root <path>] [--config <path>]", 2, 2, [...COMMON_FLAGS, "id", "session", "input", "type", "payload-json", "meta-json"], [], ["id"]),
  capacity: schema("capacity <list|release>", 1, 1),
  "capacity list": schema("capacity list [--json] [--limit <count>] [--root <path>] [--config <path>]", 2, 2, [...COMMON_FLAGS, "limit"], ["json"]),
  "capacity release": schema("capacity release <client-id> <session-id-or-key> [--root <path>] [--config <path>]", 4, 4, COMMON_FLAGS),
  sessions: schema("sessions <list|show|end>", 1, 1),
  "sessions list": schema("sessions list [--json] [--limit <count>] [--root <path>] [--config <path>]", 2, 2, [...COMMON_FLAGS, "limit"], ["json"]),
  "sessions show": schema("sessions show <id-or-key> [--root <path>] [--config <path>]", 3, 3, COMMON_FLAGS),
  "sessions end": schema("sessions end <id-or-key> [--reason <reason>] [--root <path>] [--config <path>]", 3, 3, [...COMMON_FLAGS, "reason"]),
  events: schema("events <list|show|retry>", 1, 1),
  "events list": schema("events list [--json] [--limit <count>] [--root <path>] [--config <path>]", 2, 2, [...COMMON_FLAGS, "limit"], ["json"]),
  "events show": schema("events show <internal-event-id> [--root <path>] [--config <path>]", 3, 3, COMMON_FLAGS),
  "events retry": schema("events retry <delivery-id> [--root <path>] [--config <path>]", 3, 3, COMMON_FLAGS),
};

function schema(
  usage: string,
  minPositionals: number,
  maxPositionals: number,
  stringFlags: readonly string[] = [],
  booleanFlags: readonly string[] = [],
  requiredFlags: readonly string[] = [],
): CommandSchema {
  return { usage, minPositionals, maxPositionals, stringFlags, booleanFlags: [...booleanFlags, "help"], requiredFlags };
}

function commandUsage(schema: CommandSchema): string {
  return `Usage: simple-agent-orchestrator ${schema.usage}`;
}

function usage(): void {
  console.log(`Simple Agent Orchestrator

Usage:
  Project setup:
  simple-agent-orchestrator init [--root <path>] [--force]

  Runtime commands:
  simple-agent-orchestrator start [--root <path>] [--config <path>] [--drain] [--no-http]

  Inspection commands (safe while start is active):
  simple-agent-orchestrator doctor [--root <path>] [--config <path>]
  simple-agent-orchestrator print-config [--root <path>] [--config <path>]
  simple-agent-orchestrator state validate [--root <path>] [--config <path>]
  simple-agent-orchestrator sessions list [--json] [--limit <count>]
  simple-agent-orchestrator sessions show <id-or-key>
  simple-agent-orchestrator capacity list [--json] [--limit <count>]
  simple-agent-orchestrator events list [--json] [--limit <count>]
  simple-agent-orchestrator events show <internal-event-id>

  State retention (preview is safe while start is active; --apply requires it to be stopped):
  simple-agent-orchestrator state prune --before <timestamp> [--apply] [--drop-dedupe]

  Offline mutation commands (require start to be stopped):
  simple-agent-orchestrator dispatch <channel> --id <id> [--session <session-key>] [--input <text>]
  simple-agent-orchestrator sessions end <id-or-key> [--reason <reason>]
  simple-agent-orchestrator capacity release <client-id> <session-id-or-key>
  simple-agent-orchestrator events retry <delivery-id>

Run any command or subcommand with --help for its usage.
`);
}

function routeFor(argv: string[]): string | undefined {
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const command = positional[0];
  if (!command) return undefined;
  if (command === "state" || command === "sessions" || command === "events" || command === "capacity") {
    const action = positional[1];
    if (action && SCHEMAS[`${command} ${action}`]) return `${command} ${action}`;
  }
  return command;
}

function parseArgs(argv: string[], schema: CommandSchema): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const stringFlags = new Set(schema.stringFlags);
  const booleanFlags = new Set(schema.booleanFlags);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    const equals = arg.indexOf("=");
    const name = arg.slice(2, equals === -1 ? undefined : equals);
    if (!name || (!stringFlags.has(name) && !booleanFlags.has(name))) {
      throw new Error(`Unknown option: --${name}`);
    }
    if (flags[name] !== undefined) throw new Error(`Option may only be specified once: --${name}`);
    const inlineValue = equals === -1 ? undefined : arg.slice(equals + 1);
    if (stringFlags.has(name)) {
      const value = inlineValue ?? argv[index + 1];
      if (!value || (inlineValue === undefined && value.startsWith("--"))) {
        throw new Error(`Missing value for --${name}`);
      }
      flags[name] = value;
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (inlineValue !== undefined && inlineValue !== "true" && inlineValue !== "false") {
      throw new Error(`--${name} must be a bare flag, true, or false`);
    }
    flags[name] = inlineValue === undefined ? true : inlineValue === "true";
  }

  if (positional.length > schema.maxPositionals) throw new Error(commandUsage(schema));
  if (flags.help !== true) {
    if (positional.length < schema.minPositionals) throw new Error(commandUsage(schema));
    for (const name of schema.requiredFlags ?? []) {
      if (typeof flags[name] !== "string") throw new Error(`Missing required option: --${name}`);
    }
  }
  return { positional, flags };
}

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function booleanFlag(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true;
}

async function pathType(path: string): Promise<"missing" | "file" | "directory" | "other"> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) return "other";
    if (entry.isFile()) return "file";
    if (entry.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function discoverInitRoot(explicitRoot?: string): Promise<string> {
  if (explicitRoot) {
    const root = resolve(explicitRoot);
    if (await pathType(root) !== "directory") throw new Error(`Project root must be an existing directory: ${root}`);
    return root;
  }
  let current = resolve(process.cwd());
  while (true) {
    if (await pathType(join(current, "package.json")) !== "missing") return current;
    const parent = dirname(current);
    if (parent === current) throw new Error("Could not find package.json in this directory or any parent directory");
    current = parent;
  }
}

async function initProject(flags: Record<string, string | boolean>): Promise<void> {
  const root = await discoverInitRoot(flagString(flags, "root"));
  const packageJsonPath = join(root, "package.json");
  if (await pathType(packageJsonPath) !== "file") throw new Error(`package.json must be an existing regular file: ${packageJsonPath}`);
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch {
    throw new Error(`package.json must contain valid JSON: ${packageJsonPath}`);
  }
  if (packageJson === null || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    throw new Error(`package.json must contain a JSON object: ${packageJsonPath}`);
  }

  const target = join(root, ".simple-agent-orchestrator");
  const targetType = await pathType(target);
  const force = booleanFlag(flags, "force");
  if (targetType !== "missing" && targetType !== "directory") {
    throw new Error(`Destination must be a regular directory: ${target}`);
  }
  if (targetType === "directory" && !force) {
    throw new Error(`${target} already exists. Re-run with --force to overwrite template files.`);
  }

  const templateRoot = fileURLToPath(new URL("../templates/default/.simple-agent-orchestrator", import.meta.url));
  const files = [
    { source: "gitignore", destination: ".gitignore" },
    { source: "package.json", destination: "package.json" },
    { source: "tsconfig.json", destination: "tsconfig.json" },
    { source: "orchestrator.ts", destination: "orchestrator.ts" },
    { source: "channels/manual.ts", destination: "channels/manual.ts" },
    { source: "clients/example.ts", destination: "clients/example.ts" },
  ];
  const contents = await Promise.all(files.map(({ source }) => readFile(join(templateRoot, source))));

  for (const directory of [join(target, "channels"), join(target, "clients")]) {
    const type = await pathType(directory);
    if (type !== "missing" && type !== "directory") throw new Error(`Destination must be a regular directory: ${directory}`);
  }
  for (const { destination } of files) {
    const path = join(target, destination);
    const type = await pathType(path);
    if (type !== "missing" && type !== "file") throw new Error(`Destination must be a regular file: ${path}`);
  }

  await mkdir(join(target, "channels"), { recursive: true });
  await mkdir(join(target, "clients"), { recursive: true });
  const transactionId = randomUUID();
  const staged = files.map(({ destination }, index) => {
    const path = join(target, destination);
    return {
      path,
      stagedPath: `${path}.${transactionId}.new`,
      backupPath: `${path}.${transactionId}.bak`,
      content: contents[index]!,
      hadOriginal: false,
      applied: false,
    };
  });

  try {
    await Promise.all(staged.map(({ stagedPath, content }) => writeFile(stagedPath, content, { flag: "wx" })));
    for (const entry of staged) {
      const currentType = await pathType(entry.path);
      if (currentType !== "missing" && currentType !== "file") {
        throw new Error(`Destination must be a regular file: ${entry.path}`);
      }
      if (currentType === "file") {
        await rename(entry.path, entry.backupPath);
        entry.hadOriginal = true;
      }
      await rename(entry.stagedPath, entry.path);
      entry.applied = true;
    }
  } catch (error) {
    for (const entry of [...staged].reverse()) {
      if (entry.applied) await rm(entry.path, { force: true });
      if (entry.hadOriginal && await pathType(entry.backupPath) === "file") {
        await rename(entry.backupPath, entry.path);
      }
      await rm(entry.stagedPath, { force: true });
    }
    throw error;
  }
  await Promise.all(staged.filter(({ hadOriginal }) => hadOriginal).map(({ backupPath }) => rm(backupPath)));
  console.log(`Created ${target}`);
  console.log("Next: npx simple-agent-orchestrator doctor");
}

async function loadRuntime(flags: Record<string, string | boolean>) {
  const options: { root?: string; config?: string } = {};
  const root = flagString(flags, "root");
  const config = flagString(flags, "config");
  if (root) options.root = root;
  if (config) options.config = config;
  return loadProjectOrchestrator(options);
}

async function start(flags: Record<string, string | boolean>): Promise<void> {
  const { runtime } = await loadRuntime(flags);
  const drain = booleanFlag(flags, "drain");
  await runtime.start({ drain, http: !booleanFlag(flags, "no-http"), prettyStartupLog: true });
  if (drain) return;
  const shutdown = async () => {
    console.log("\nStopping Simple Agent Orchestrator...");
    await runtime.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.once("message", (message) => {
    if (message === "shutdown") void shutdown();
  });
  console.log("Simple Agent Orchestrator is running. Press Ctrl+C to stop.");
}

async function doctor(flags: Record<string, string | boolean>): Promise<void> {
  const { project, configFile, runtime } = await loadRuntime(flags);
  await runtime.init();
  const config = await runtime.printConfig();
  console.log("✓ Project root:", project.root);
  console.log("✓ Orchestrator directory:", project.orchestratorDir);
  console.log("✓ Config:", configFile);
  console.log("✓ Store:", config.store);
  console.log("✓ Channels:", (config.channels as string[]).join(", ") || "none");
  console.log("✓ Clients:", (config.clients as string[]).join(", ") || "none");
  const required = env.getRequiredNames();
  if (required.length) console.log("✓ Required env vars declared:", required.join(", "));
  console.log("Doctor completed.");
}

async function printConfig(flags: Record<string, string | boolean>): Promise<void> {
  const { runtime, configFile } = await loadRuntime(flags);
  console.log(JSON.stringify({ ...await runtime.printConfig(), configFile }, null, 2));
}

async function stateCommand(args: ParsedArgs): Promise<void> {
  const action = args.positional[1];
  if (action === "validate") {
    const { runtime } = await loadRuntime(args.flags);
    await runtime.init();
    console.log("State is valid and compatible.");
    return;
  }
  const before = flagString(args.flags, "before")!;
  const { runtime } = await loadRuntime(args.flags);
  const options = { before, dropDedupe: booleanFlag(args.flags, "drop-dedupe") };
  const apply = booleanFlag(args.flags, "apply");
  const plan = apply ? await runtime.runOffline(({ pruneState }) => pruneState(options)) : await runtime.previewStatePrune(options);
  console.log(JSON.stringify({ applied: apply, ...plan }, null, 2));
}

async function dispatchCommand(args: ParsedArgs): Promise<void> {
  const channelId = args.positional[1]!;
  const payloadJson = flagString(args.flags, "payload-json");
  const metaJson = flagString(args.flags, "meta-json");
  const payload = payloadJson ? JSON.parse(payloadJson) : undefined;
  const meta = metaJson ? JSON.parse(metaJson) : undefined;
  const { runtime } = await loadRuntime(args.flags);
  const result = await runtime.runOffline(async ({ dispatch, drain }) => {
    const dispatched = await dispatch(channelId, {
      id: flagString(args.flags, "id")!,
      type: flagString(args.flags, "type"),
      sessionKey: flagString(args.flags, "session"),
      input: flagString(args.flags, "input"),
      payload,
      meta,
    });
    await drain();
    return dispatched;
  });
  console.log(JSON.stringify(result, null, 2));
}

function listLimit(flags: Record<string, string | boolean>): number | undefined {
  const raw = flagString(flags, "limit");
  if (raw === undefined) return undefined;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  return limit;
}

async function sessionsCommand(args: ParsedArgs): Promise<void> {
  const action = args.positional[1];
  const limit = action === "list" ? listLimit(args.flags) : undefined;
  const { runtime } = await loadRuntime(args.flags);
  if (action === "list") {
    const sessions = (await runtime.listSessions()).slice(0, limit);
    if (booleanFlag(args.flags, "json")) console.log(JSON.stringify(sessions, null, 2));
    else if (sessions.length === 0) console.log("No sessions found.");
    else console.table(sessions.map(({ id, key, status, updatedAt }) => ({ id, key, status, updatedAt })));
    return;
  }
  const id = args.positional[2]!;
  if (action === "show") {
    const session = await runtime.getSession(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    console.log(JSON.stringify({ ...session, notes: await runtime.listSessionNotes(session.id) }, null, 2));
    return;
  }
  await runtime.runOffline(async ({ endSession }) => {
    const session = await runtime.getSession(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    if (session.status === "ended") throw new Error(`Session is already ended: ${id}`);
    await endSession(id, flagString(args.flags, "reason") ?? "manual");
  });
  console.log("ended");
}

async function capacityCommand(args: ParsedArgs): Promise<void> {
  const action = args.positional[1];
  const limit = action === "list" ? listLimit(args.flags) : undefined;
  const { runtime } = await loadRuntime(args.flags);
  if (action === "list") {
    const reservations = (await runtime.listCapacityReservations()).slice(0, limit);
    if (booleanFlag(args.flags, "json")) console.log(JSON.stringify(reservations, null, 2));
    else if (reservations.length === 0) console.log("No capacity reservations found.");
    else {
      const sessions = await runtime.listSessions();
      console.table(reservations.map((reservation) => ({
        id: reservation.id,
        client: reservation.clientId,
        session: sessions.find(({ id }) => id === reservation.sessionId)?.key ?? reservation.sessionId,
        acquiredAt: reservation.acquiredAt,
      })));
    }
    return;
  }

  const clientId = args.positional[2]!;
  const sessionIdOrKey = args.positional[3]!;
  await runtime.runOffline(async ({ drain, releaseCapacity }) => {
    if (!await releaseCapacity(clientId, sessionIdOrKey)) {
      throw new Error(`Capacity reservation not found for client ${clientId} and session ${sessionIdOrKey}`);
    }
    await drain();
  });
  console.log("released");
}

async function eventsCommand(args: ParsedArgs): Promise<void> {
  const action = args.positional[1];
  const limit = action === "list" ? listLimit(args.flags) : undefined;
  const { runtime } = await loadRuntime(args.flags);
  if (action === "list") {
    const events = (await runtime.listEvents()).slice(0, limit);
    if (booleanFlag(args.flags, "json")) {
      console.log(JSON.stringify(events, null, 2));
    } else if (events.length === 0) {
      console.log("No events found.");
    } else {
      console.table(events.flatMap(({ event, deliveries }) => deliveries.length
        ? deliveries.map((delivery) => ({
            eventId: event.id,
            sourceId: event.sourceId,
            channel: event.channelId,
            sessionKey: event.sessionKey,
            deliveryId: delivery.id,
            client: delivery.clientId,
            handler: delivery.handlerId,
            status: delivery.status,
            attempts: `${delivery.attempts}/${delivery.maxAttempts}`,
            nextAttemptAt: delivery.nextAttemptAt ?? "",
          }))
        : [{ eventId: event.id, sourceId: event.sourceId, channel: event.channelId, sessionKey: event.sessionKey, deliveryId: "", client: "", handler: "", status: "no-delivery", attempts: "0/0", nextAttemptAt: "" }]));
    }
    return;
  }
  const id = args.positional[2]!;
  if (action === "show") {
    const found = (await runtime.listEvents()).find(({ event }) => event.id === id);
    if (!found) throw new Error(`Event not found: ${id}`);
    console.log(JSON.stringify(found, null, 2));
    return;
  }
  await runtime.runOffline(async ({ drain, retryDelivery }) => {
    const delivery = (await runtime.listEvents()).flatMap(({ deliveries }) => deliveries).find((candidate) => candidate.id === id);
    if (!delivery) throw new Error(`Delivery not found: ${id}`);
    if (delivery.status !== "failed") throw new Error(`Delivery is not failed: ${id}`);
    await retryDelivery(id);
    await drain();
  });
  console.log("retried");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    usage();
    return;
  }
  const route = routeFor(argv);
  const selected = route ? SCHEMAS[route] : undefined;
  if (!selected) throw new Error(`Unknown command: ${argv[0]}`);
  const args = parseArgs(argv, selected);
  if (booleanFlag(args.flags, "help")) {
    console.log(commandUsage(selected));
    return;
  }
  switch (route) {
    case "init": await initProject(args.flags); break;
    case "start": await start(args.flags); break;
    case "doctor": await doctor(args.flags); break;
    case "print-config": await printConfig(args.flags); break;
    case "state validate":
    case "state prune": await stateCommand(args); break;
    case "dispatch": await dispatchCommand(args); break;
    case "capacity list":
    case "capacity release": await capacityCommand(args); break;
    case "sessions list":
    case "sessions show":
    case "sessions end": await sessionsCommand(args); break;
    case "events list":
    case "events show":
    case "events retry": await eventsCommand(args); break;
    default: throw new Error(commandUsage(selected));
  }
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
