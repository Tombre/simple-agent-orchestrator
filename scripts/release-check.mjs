import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmExecPath = process.env.npm_execpath;
if (process.platform === "win32" && !npmExecPath) {
  throw new Error("Run this check through npm run release:check on Windows.");
}
const npmCommand = npmExecPath ? process.execPath : "npm";
const npmArgs = npmExecPath ? [npmExecPath] : [];

function displayCommand(command, args) {
  return [command, ...args].join(" ");
}

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: { ...process.env, NO_COLOR: "1" },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    const output = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(
      `${displayCommand(command, args)} failed${output ? `:\n${output}` : ""}`,
      { cause: error },
    );
  }
}

function runNpm(args, options) {
  return run(npmCommand, [...npmArgs, ...args], options);
}

async function assertRejectsCommand(operation, pattern) {
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof Error, "Expected command to fail");
  assert.match(failure.message, pattern);
}

function parsePackResult(stdout) {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim() !== "[") continue;
    try {
      const parsed = JSON.parse(lines.slice(index).join("\n"));
      if (Array.isArray(parsed) && parsed.length === 1) return parsed[0];
    } catch {
      // npm lifecycle output may precede the final JSON payload.
    }
  }
  throw new Error(`Could not parse npm pack output:\n${stdout}`);
}

async function listFiles(root, directory = root) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, path)));
    } else if (entry.isFile()) {
      files.push(relative(root, path).split(sep).join("/"));
    }
  }
  return files.sort();
}

function assertPackageContents(packResult, shippedFiles) {
  const packaged = new Map(packResult.files.map((file) => [file.path, file]));
  const required = [
    "LICENSE",
    "README.md",
    "package.json",
    "dist/cli.js",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/runtime/index.js",
    "dist/runtime/index.d.ts",
    "dist/node/index.js",
    "dist/node/index.d.ts",
    "dist/testing/index.js",
    "dist/testing/index.d.ts",
    ...shippedFiles,
  ];

  const missing = required.filter((path) => !packaged.has(path));
  assert.deepEqual(missing, [], `Package is missing required files:\n${missing.join("\n")}`);
  if (process.platform !== "win32") {
    assert.ok((packaged.get("dist/cli.js").mode & 0o111) !== 0, "Packaged CLI is not executable");
  }
}

async function verifyConsumer(consumerRoot, archive) {
  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify({
      name: "release-check-consumer",
      private: true,
      type: "module",
      scripts: { sao: "simple-agent-orchestrator" },
    }, null, 2)}\n`,
    "utf8",
  );

  console.log("Installing the package artifact in a clean consumer...");
  await runNpm(["install", "--no-audit", "--no-fund", archive], { cwd: consumerRoot });

  const cliShim = join(
    consumerRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "simple-agent-orchestrator.cmd" : "simple-agent-orchestrator",
  );
  await access(cliShim);
  const installedCliPath = join(
    consumerRoot,
    "node_modules",
    "simple-agent-orchestrator",
    "dist",
    "cli.js",
  );
  const runCli = (args) => runNpm(["run", "--silent", "sao", "--", ...args], { cwd: consumerRoot });
  const runCliFrom = (cwd, args) => run(process.execPath, [installedCliPath, ...args], { cwd });

  console.log("Initializing and validating the packaged template...");
  const packageJsonBeforeInit = await readFile(join(consumerRoot, "package.json"), "utf8");
  const initialized = await runCli(["init"]);
  assert.match(initialized.stdout, /Created .*\.simple-agent-orchestrator/);
  assert.equal(await readFile(join(consumerRoot, "package.json"), "utf8"), packageJsonBeforeInit);
  assert.deepEqual(
    await listFiles(join(consumerRoot, ".simple-agent-orchestrator")),
    [".gitignore", "channels/manual.ts", "clients/example.ts", "orchestrator.ts", "package.json", "tsconfig.json"],
  );
  assert.equal(
    await readFile(join(consumerRoot, ".simple-agent-orchestrator", ".gitignore"), "utf8"),
    "state/\ntmp/\nlogs/\n",
  );
  const exampleSource = await readFile(
    join(consumerRoot, ".simple-agent-orchestrator", "clients", "example.ts"),
    "utf8",
  );
  assert.doesNotMatch(exampleSource, /messageCount|session\.note|event\.(?:input|payload|meta)/);

  await assertRejectsCommand(() => runCli(["dev"]), /Unknown command: dev/);
  await assertRejectsCommand(
    () => runCli(["dispatch", "manual"]),
    /Missing required option: --id/,
  );

  const doctor = await runCli(["doctor"]);
  assert.match(doctor.stdout, /Doctor completed\./);
  const nestedDoctor = await runCliFrom(
    join(consumerRoot, ".simple-agent-orchestrator", "clients"),
    ["doctor"],
  );
  assert.match(nestedDoctor.stdout, /Doctor completed\./);
  const explicitConfigDoctor = await runCli([
    "doctor",
    "--config",
    ".simple-agent-orchestrator/orchestrator.ts",
  ]);
  assert.match(explicitConfigDoctor.stdout, /Doctor completed\./);
  const stateValidation = await runCli(["state", "validate"]);
  assert.match(stateValidation.stdout, /State is valid and compatible\./);

  await writeFile(
    join(consumerRoot, "verify-types.ts"),
    `import { CURRENT_STATE_VERSION, createClient, createManualChannel, defineConfig, memoryStore, validateAndMigrateState } from "simple-agent-orchestrator";
import type { DispatchResult, HttpRegistrationContext, OrchestratorState, ReadonlySession, StateValidationErrorCode, StoredDeliveryEffects, WorkStatus } from "simple-agent-orchestrator";
import { createRuntime, loadProjectOrchestrator } from "simple-agent-orchestrator/runtime";
import type { OfflineOperationContext } from "simple-agent-orchestrator/runtime";
import { spawnManagedProcess } from "simple-agent-orchestrator/node";
import type { ManagedProcess } from "simple-agent-orchestrator/node";
import { createTestRuntime } from "simple-agent-orchestrator/testing";
import type { TestRuntime } from "simple-agent-orchestrator/testing";

const channel = createManualChannel("types");
const client = createClient("types", (builder) => builder.handle(channel, () => {}));
const registerRoutes = ({ app }: HttpRegistrationContext) => {
  app.get("/typed", (context) => context.text("ok"));
};
const config = { channels: [channel], clients: [client], http: { enabled: false, routes: registerRoutes } };
void defineConfig(config);
const runtimePromise = createRuntime({ ...config, store: memoryStore() }, { root: "." });
const testRuntimePromise: Promise<TestRuntime> = createTestRuntime(config, { root: "." });
const managedProcess: ManagedProcess = spawnManagedProcess("node", ["-e", "process.exit(0)"]);
declare const offline: OfflineOperationContext;
const dispatchResult: Promise<DispatchResult> = offline.dispatch(channel, { id: "typed" });
declare const readonlySession: ReadonlySession;
const workStatus: WorkStatus = "pending";
const effects: StoredDeliveryEffects = { mutations: [], notes: [], releaseCapacity: false };
// @ts-expect-error Exhaustion sessions do not expose mutations.
readonlySession.set("key", "value");
// @ts-expect-error Public channel definitions are readonly.
channel.id = "changed";
// @ts-expect-error Public poll collections are readonly.
channel.polls.push({ every: 1, fetch: () => [] });
// @ts-expect-error Public handler collections are readonly.
client.handlers.push(client.handlers[0]!);
const state: OrchestratorState = validateAndMigrateState({ version: CURRENT_STATE_VERSION, sessions: [], events: [], deliveries: [], notes: [], cursors: {} });
const validationCode: StateValidationErrorCode = "invalid-state";
void runtimePromise;
void testRuntimePromise;
void managedProcess.exit;
void dispatchResult;
void readonlySession.id;
void workStatus;
void effects;
void state;
void validationCode;
void loadProjectOrchestrator({ root: "." });
`,
    "utf8",
  );
  await writeFile(
    join(consumerRoot, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ["verify-types.ts"],
    }, null, 2)}\n`,
    "utf8",
  );

  console.log("Checking public package subpaths and declarations...");
  const tsc = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
  await run(process.execPath, [tsc, "-p", join(consumerRoot, "tsconfig.json")], { cwd: consumerRoot });
  await run(
    process.execPath,
    [tsc, "-p", join(consumerRoot, ".simple-agent-orchestrator", "tsconfig.json")],
    { cwd: consumerRoot },
  );

  await writeFile(
    join(consumerRoot, "verify-runtime.mjs"),
    `import assert from "node:assert/strict";
import { createClient, createManualChannel, memoryStore } from "simple-agent-orchestrator";
import { createRuntime } from "simple-agent-orchestrator/runtime";
import { createTestRuntime } from "simple-agent-orchestrator/testing";

const channel = createManualChannel("programmatic");
const client = createClient("programmatic", (builder) => builder.handle(channel, () => {}));
const config = { channels: [channel], clients: [client], http: { enabled: false } };

const runtime = await createRuntime({ ...config, store: memoryStore() }, { root: process.cwd() });
await runtime.init();
try {
  const result = await runtime.dispatch(channel, { id: "runtime-event" });
  assert.equal(result.status, "queued");
  await runtime.drain();
} finally {
  await runtime.stop();
}

const test = await createTestRuntime(config, { root: process.cwd() });
const testResult = await test.dispatch(channel, { id: "test-event" });
assert.equal(testResult.status, "queued");
await test.stop();
await assert.rejects(() => test.dispatch(channel, { id: "after-stop" }), /stopped/);
await assert.rejects(() => channel.dispatch({ id: "after-stop" }), /not bound/);
`,
    "utf8",
  );
  console.log("Exercising installed runtime and testing subpaths...");
  await run(process.execPath, [join(consumerRoot, "verify-runtime.mjs")], { cwd: consumerRoot });

  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

  console.log("Running the installed CLI webhook and operational API smoke test...");
  const child = spawn(process.execPath, [installedCliPath, "start"], {
    cwd: consumerRoot,
    env: { ...process.env, NO_COLOR: "1", SAO_HTTP_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let childOutput = "";
  child.stdout.on("data", (chunk) => {
    childOutput += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    childOutput += chunk.toString();
  });
  let childExit;
  const exited = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => {
      childExit = { code, signal };
      resolveExit(childExit);
    });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  let acceptedEventId;
  try {
    const deadline = Date.now() + 10_000;
    while (true) {
      if (childExit) throw new Error(`Installed CLI exited before readiness:\n${childOutput}`);
      try {
        const health = await fetch(`${baseUrl}/health`);
        if (health.status === 200) break;
      } catch {
        // The listener may not be bound yet.
      }
      if (Date.now() >= deadline) throw new Error(`Installed CLI did not become ready:\n${childOutput}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }

    const webhook = await fetch(`${baseUrl}/webhooks/manual`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "smoke-1", sessionKey: "smoke", input: "DISPATCHED_INPUT_MUST_NOT_BE_LOGGED" }),
    });
    assert.equal(webhook.status, 202);
    const accepted = await webhook.json();
    assert.equal(accepted.status, "queued");
    assert.equal(typeof accepted.eventId, "string");
    acceptedEventId = accepted.eventId;

    const status = await fetch(`${baseUrl}/api/v1/status`).then((response) => response.json());
    assert.equal(status.http.port, port);
    assert.equal(status.totals.events, 1);

    const processingDeadline = Date.now() + 10_000;
    while (true) {
      const body = await fetch(`${baseUrl}/api/v1/events`).then((response) => response.json());
      assert.equal(body.events[0].input, undefined);
      assert.equal(body.events[0].payload, undefined);
      if (body.events[0].deliveries.processed === 1) break;
      if (Date.now() >= processingDeadline) throw new Error("Installed CLI did not process the webhook delivery");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    const sessions = await fetch(`${baseUrl}/api/v1/sessions`).then((response) => response.json());
    assert.equal(sessions.sessions[0].key, "smoke");
    assert.equal(sessions.sessions[0].state, undefined);
  } finally {
    if (!childExit) child.send("shutdown");
    const cleanExit = await Promise.race([
      exited,
      new Promise((resolveExit) => setTimeout(() => resolveExit(undefined), 10_000)),
    ]);
    if (!cleanExit) {
      child.kill();
      await exited;
      throw new Error(`Installed CLI did not stop cleanly:\n${childOutput}`);
    }
  }
  assert.deepEqual(childExit, { code: 0, signal: null }, childOutput);
  assert.doesNotMatch(childOutput, /DISPATCHED_INPUT_MUST_NOT_BE_LOGGED/);

  console.log("Inspecting persisted package state with the installed CLI...");
  const session = JSON.parse((await runCli(["sessions", "show", "smoke"])).stdout);
  assert.equal(session.key, "smoke");
  assert.deepEqual(session.state, {});
  assert.deepEqual(session.notes, []);
  const sessions = JSON.parse((await runCli(["sessions", "list", "--json"])).stdout);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].key, "smoke");

  const events = JSON.parse((await runCli(["events", "list", "--json"])).stdout);
  assert.equal(events.length, 1);
  assert.equal(events[0].event.sourceId, "smoke-1");
  assert.equal(events[0].deliveries[0].status, "processed");
  const shownEvent = JSON.parse((await runCli(["events", "show", acceptedEventId])).stdout);
  assert.equal(shownEvent.event.id, acceptedEventId);
  assert.equal(shownEvent.event.sourceId, "smoke-1");
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "sao-release-check-"));
try {
  console.log("Building and inspecting the npm package artifact...");
  await rm(join(repositoryRoot, "dist"), { recursive: true, force: true });
  const { stdout } = await runNpm(["pack", "--json", "--pack-destination", temporaryRoot]);
  const packResult = parsePackResult(stdout);
  const shippedFiles = (await Promise.all(
    ["docs", "skills", "templates"].map(async (directory) =>
      (await listFiles(join(repositoryRoot, directory))).map((path) => `${directory}/${path}`),
    ),
  )).flat();
  assertPackageContents(packResult, shippedFiles);

  const archive = join(temporaryRoot, packResult.filename);
  await access(archive);
  const consumerRoot = join(temporaryRoot, "consumer");
  await mkdir(consumerRoot);
  await verifyConsumer(consumerRoot, archive);

  console.log("Release package verification passed.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
