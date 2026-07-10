import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
  const runCli = (args) => runNpm(["run", "--silent", "sao", "--", ...args], { cwd: consumerRoot });

  console.log("Initializing and validating the packaged template...");
  const initialized = await runCli(["init"]);
  assert.match(initialized.stdout, /Created .*\.simple-agent-orchestrator/);
  for (const path of [
    ".simple-agent-orchestrator/orchestrator.ts",
    ".simple-agent-orchestrator/logs/.gitignore",
    ".simple-agent-orchestrator/state/.gitignore",
    ".simple-agent-orchestrator/tmp/.gitignore",
  ]) {
    await access(join(consumerRoot, ...path.split("/")));
  }

  const doctor = await runCli(["doctor"]);
  assert.match(doctor.stdout, /Doctor completed\./);
  const stateValidation = await runCli(["state", "validate"]);
  assert.match(stateValidation.stdout, /State is valid and compatible\./);

  await writeFile(
    join(consumerRoot, "verify-types.ts"),
    `import { CURRENT_STATE_VERSION, createClient, createManualChannel, defineConfig, validateAndMigrateState } from "simple-agent-orchestrator";
import type { OrchestratorState, StateValidationErrorCode } from "simple-agent-orchestrator";
import { loadProjectOrchestrator } from "simple-agent-orchestrator/runtime";
import { createTestRuntime } from "simple-agent-orchestrator/testing";

const channel = createManualChannel("types");
const client = createClient("types", (builder) => builder.handle(channel, () => {}));
const config = { channels: [channel], clients: [client] };
void defineConfig(config);
const state: OrchestratorState = validateAndMigrateState({ version: CURRENT_STATE_VERSION, sessions: [], events: [], deliveries: [], notes: [], cursors: {} });
const validationCode: StateValidationErrorCode = "invalid-state";
void state;
void validationCode;
void loadProjectOrchestrator({ root: "." });
void createTestRuntime({ config });
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

  await writeFile(
    join(consumerRoot, "dispatch.mjs"),
    `import assert from "node:assert/strict";
import * as api from "simple-agent-orchestrator";
import { loadProjectOrchestrator } from "simple-agent-orchestrator/runtime";
import * as testing from "simple-agent-orchestrator/testing";

assert.equal(typeof api.createClient, "function");
assert.equal(api.CURRENT_STATE_VERSION, 3);
assert.equal(typeof api.HandlerTimeoutError, "function");
assert.equal(typeof api.validateAndMigrateState, "function");
assert.equal(typeof testing.createTestRuntime, "function");
const { runtime } = await loadProjectOrchestrator({ root: process.cwd() });
const result = await runtime.dispatch("manual", {
  id: "smoke-1",
  sessionKey: "smoke",
  input: "Smoke test",
});
assert.equal(result.status, "queued");
const [{ deliveries }] = await runtime.listEvents();
assert.equal(deliveries[0]?.status, "pending");
`,
    "utf8",
  );
  await run(process.execPath, [join(consumerRoot, "dispatch.mjs")], { cwd: consumerRoot });

  console.log("Running the installed CLI against persisted package state...");
  await runCli(["start", "--drain"]);
  const session = JSON.parse((await runCli(["sessions", "show", "smoke"])).stdout);
  assert.equal(session.key, "smoke");
  assert.equal(session.state["example.messageCount"], 1);
  assert.equal(session.notes[0]?.message, "Handled manual event");

  const events = (await runCli(["events", "list"])).stdout;
  assert.match(events, /smoke-1/);
  assert.match(events, /processed/);
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
