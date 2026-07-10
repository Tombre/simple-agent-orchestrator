#!/usr/bin/env node
import { access, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectOrchestrator } from "./runtime/project.js";
import { env } from "./utils/env.js";

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith("--")) {
      const [rawName, inlineValue] = arg.slice(2).split("=", 2);
      const name = rawName!;
      if (inlineValue !== undefined) {
        flags[name] = inlineValue;
      } else {
        const next = argv[index + 1];
        if (next && !next.startsWith("--")) {
          flags[name] = next;
          index += 1;
        } else {
          flags[name] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function hasFlag(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || typeof flags[name] === "string";
}

function usage(): void {
  console.log(`Simple Agent Orchestrator

Usage:
  Project setup:
  simple-agent-orchestrator init [--force]

  Runtime commands:
  simple-agent-orchestrator start [--root <path>] [--config <path>] [--drain]
  simple-agent-orchestrator dev [--root <path>] [--config <path>]

  Inspection commands (safe while start is active):
  simple-agent-orchestrator doctor [--root <path>] [--config <path>]
  simple-agent-orchestrator print-config [--root <path>] [--config <path>]
  simple-agent-orchestrator sessions list
  simple-agent-orchestrator sessions show <id-or-key>
  simple-agent-orchestrator events list

  Offline mutation commands (require start to be stopped):
  simple-agent-orchestrator dispatch <channel> --id <id> --session <sessionKey> --input <text>
  simple-agent-orchestrator sessions end <id-or-key> [--reason <reason>]
  simple-agent-orchestrator events retry <delivery-id>
`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function initProject(flags: Record<string, string | boolean>): Promise<void> {
  const root = resolve(flagString(flags, "root") ?? process.cwd());
  const target = join(root, ".simple-agent-orchestrator");
  const force = hasFlag(flags, "force");
  if ((await exists(target)) && !force) {
    throw new Error(`${target} already exists. Re-run with --force to overwrite template files.`);
  }

  const templateRoot = fileURLToPath(new URL("../templates/default/.simple-agent-orchestrator", import.meta.url));
  await mkdir(dirname(target), { recursive: true });
  await cp(templateRoot, target, { recursive: true, force: true });
  await Promise.all(
    ["logs", "state", "tmp"].map(async (directory) => {
      const packagedPath = join(target, directory, "gitignore");
      await copyFile(packagedPath, join(target, directory, ".gitignore"));
      await rm(packagedPath);
    }),
  );

  const packageJsonPath = join(root, "package.json");
  if (await exists(packageJsonPath)) {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
    const scripts = { ...((packageJson.scripts as Record<string, string> | undefined) ?? {}) };
    scripts.agents ??= "simple-agent-orchestrator start";
    scripts["agents:dev"] ??= "simple-agent-orchestrator dev";
    scripts["agents:doctor"] ??= "simple-agent-orchestrator doctor";
    packageJson.scripts = scripts;
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  }

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

async function start(flags: Record<string, string | boolean>, dev = false): Promise<void> {
  const { runtime } = await loadRuntime(flags);
  const drain = hasFlag(flags, "drain");
  await runtime.start({ drain, prettyStartupLog: true });
  if (drain) return;

  const shutdown = async () => {
    console.log("\nStopping Simple Agent Orchestrator...");
    await runtime.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  if (dev) {
    console.log("Development mode is running. Press Ctrl+C to stop.");
  }
}

async function doctor(flags: Record<string, string | boolean>): Promise<void> {
  try {
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
  } catch (error) {
    console.error("Doctor failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

async function printConfig(flags: Record<string, string | boolean>): Promise<void> {
  const { runtime, configFile } = await loadRuntime(flags);
  const config = await runtime.printConfig();
  console.log(JSON.stringify({ ...config, configFile }, null, 2));
}

async function dispatchCommand(args: ParsedArgs): Promise<void> {
  const channelId = args.positional[1];
  if (!channelId) throw new Error("Usage: simple-agent-orchestrator dispatch <channel> --id <id> --session <sessionKey> --input <text>");
  const { runtime } = await loadRuntime(args.flags);
  const input = flagString(args.flags, "input");
  const payloadJson = flagString(args.flags, "payload-json");
  const metaJson = flagString(args.flags, "meta-json");
  const result = await runtime.runOffline(async ({ drain }) => {
    const dispatched = await runtime.dispatch(channelId, {
      id: flagString(args.flags, "id") ?? `manual-${Date.now()}`,
      type: flagString(args.flags, "type"),
      sessionKey: flagString(args.flags, "session") ?? flagString(args.flags, "session-key"),
      input,
      payload: payloadJson ? JSON.parse(payloadJson) : undefined,
      meta: metaJson ? JSON.parse(metaJson) : undefined,
    });
    await drain();
    return dispatched;
  });
  console.log(JSON.stringify(result, null, 2));
}

async function sessionsCommand(args: ParsedArgs): Promise<void> {
  const action = args.positional[1];
  const { runtime } = await loadRuntime(args.flags);
  if (action === "list") {
    const sessions = await runtime.listSessions();
    console.table(sessions.map((session) => ({ id: session.id, key: session.key, status: session.status, updatedAt: session.updatedAt })));
    return;
  }
  if (action === "show") {
    const id = args.positional[2];
    if (!id) throw new Error("Usage: simple-agent-orchestrator sessions show <id-or-key>");
    const session = await runtime.getSession(id);
    const notes = session ? await runtime.listSessionNotes(session.id) : [];
    console.log(JSON.stringify(session ? { ...session, notes } : null, null, 2));
    return;
  }
  if (action === "end") {
    const id = args.positional[2];
    if (!id) throw new Error("Usage: simple-agent-orchestrator sessions end <id-or-key>");
    const ended = await runtime.runOffline(() => runtime.endSession(id, flagString(args.flags, "reason") ?? "manual"));
    console.log(ended ? "ended" : "not found");
    return;
  }
  throw new Error("Usage: simple-agent-orchestrator sessions <list|show|end>");
}

async function eventsCommand(args: ParsedArgs): Promise<void> {
  const action = args.positional[1];
  const { runtime } = await loadRuntime(args.flags);
  if (action === "list") {
    const events = await runtime.listEvents();
    console.table(
      events.flatMap(({ event, deliveries }) =>
        deliveries.length
          ? deliveries.map((delivery) => ({
              eventId: event.id,
              sourceId: event.sourceId,
              channel: event.channelId,
              sessionKey: event.sessionKey,
              deliveryId: delivery.id,
              client: delivery.clientId,
              status: delivery.status,
              attempts: delivery.attempts,
            }))
          : [{ eventId: event.id, sourceId: event.sourceId, channel: event.channelId, sessionKey: event.sessionKey, deliveryId: "", client: "", status: "no-delivery", attempts: 0 }],
      ),
    );
    return;
  }
  if (action === "retry") {
    const id = args.positional[2];
    if (!id) throw new Error("Usage: simple-agent-orchestrator events retry <delivery-id>");
    const retried = await runtime.runOffline(async ({ drain }) => {
      const pending = await runtime.retryDelivery(id);
      if (pending) {
        await drain();
      }
      return pending;
    });
    console.log(retried ? "retried" : "not found");
    return;
  }
  throw new Error("Usage: simple-agent-orchestrator events <list|retry>");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  switch (command) {
    case "init":
      await initProject(args.flags);
      break;
    case "start":
      await start(args.flags);
      break;
    case "dev":
      await start(args.flags, true);
      break;
    case "doctor":
      await doctor(args.flags);
      break;
    case "print-config":
      await printConfig(args.flags);
      break;
    case "dispatch":
      await dispatchCommand(args);
      break;
    case "sessions":
      await sessionsCommand(args);
      break;
    case "events":
      await eventsCommand(args);
      break;
    default:
      usage();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
