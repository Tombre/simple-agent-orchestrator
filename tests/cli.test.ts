import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { loadProjectOrchestrator } from "../src/runtime/index.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliFile = join(repositoryRoot, "src", "cli.ts");

async function runCli(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", cliFile, ...args], {
    cwd: repositoryRoot,
    timeout: 10_000,
  });
  return stdout;
}

async function runCliResult(...args: string[]): Promise<{ failed: boolean; stdout: string; stderr: string }> {
  try {
    return { failed: false, stdout: await runCli(...args), stderr: "" };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { failed: true, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function createFixture(): Promise<{ root: string; stateFile: string }> {
  const root = await mkdtemp(join(tmpdir(), "sao-cli-"));
  const configFile = join(root, ".simple-agent-orchestrator", "orchestrator.ts");
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }), "utf8");
  const sourceImport = pathToFileURL(join(repositoryRoot, "src", "index.ts")).href;
  await writeFile(
    configFile,
    `import { createManualChannel, createClient, defineConfig } from ${JSON.stringify(sourceImport)};
const manual = createManualChannel("manual");
const client = createClient("echo", (builder) => {
  builder.handle(manual, { retries: { attempts: 1 }, handle({ event, session }) {
    if (event.input === "fail") throw new Error("fixture failure");
    session.set("lastInput", event.input);
    session.note("Echoed input", { input: event.input });
  }});
});
export default defineConfig({ channels: [manual], clients: [client] });
`,
    "utf8",
  );
  return { root, stateFile: join(root, ".simple-agent-orchestrator", "state", "state.json") };
}

describe("CLI", () => {
  it("initializes a project without replacing existing npm scripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-cli-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "existing" } }), "utf8");

    const output = await runCli("init", "--root", root);

    expect(output).toContain(`Created ${join(root, ".simple-agent-orchestrator")}`);
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts).toMatchObject({
      test: "existing",
      agents: "simple-agent-orchestrator start",
      "agents:dev": "simple-agent-orchestrator dev",
      "agents:doctor": "simple-agent-orchestrator doctor",
    });
    expect(await readFile(join(root, ".simple-agent-orchestrator", "orchestrator.ts"), "utf8")).toContain(
      "defineConfig",
    );
    for (const directory of ["logs", "state", "tmp"]) {
      expect(await readFile(join(root, ".simple-agent-orchestrator", directory, ".gitignore"), "utf8")).toBe(
        "*\n!.gitignore\n",
      );
    }
  });

  it("persists a dispatch across CLI processes and supports inspection and ending", async () => {
    const { root } = await createFixture();

    expect(await runCli("doctor", "--root", root)).toContain("Doctor completed.");
    const dispatch = await runCli(
      "dispatch",
      "manual",
      "--root",
      root,
      "--id",
      "event-1",
      "--session",
      "work-1",
      "--input",
      "hello",
    );
    expect(dispatch).toContain('"status": "queued"');
    const shown = JSON.parse(await runCli("sessions", "show", "work-1", "--root", root)) as {
      state: Record<string, unknown>;
      notes: { message: string }[];
    };
    expect(shown.state.lastInput).toBe("hello");
    expect(shown.notes).toMatchObject([{ message: "Echoed input" }]);
    expect(await runCli("events", "list", "--root", root)).toContain("processed");
    expect(await runCli("sessions", "end", "work-1", "--root", root, "--reason", "operator")).toContain("ended");
    expect(await runCli("sessions", "show", "work-1", "--root", root)).toContain('"endReason": "operator"');
  });

  it("validates current and supported persisted state without rewriting it", async () => {
    const { root, stateFile } = await createFixture();
    await runCli("doctor", "--root", root);
    const state = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, unknown>;
    const versionOne = `${JSON.stringify({ ...state, version: 1 }, null, 2)}\n`;
    await writeFile(stateFile, versionOne, "utf8");

    expect(await runCli("state", "validate", "--root", root)).toContain("State is valid and compatible");
    expect(await readFile(stateFile, "utf8")).toBe(versionOne);

    const malformed = "not json";
    await writeFile(stateFile, malformed, "utf8");
    const failure = await runCliResult("state", "validate", "--root", root);
    expect(failure.failed).toBe(true);
    expect(failure.stderr).toContain("contains invalid JSON");
    expect(failure.stderr).toContain("not modified");
    expect(await readFile(stateFile, "utf8")).toBe(malformed);
  });

  it("shows retry budgets and delayed eligibility in event inspection", async () => {
    const { root, stateFile } = await createFixture();
    await runCli("dispatch", "manual", "--root", root, "--id", "failure", "--input", "fail");
    const state = JSON.parse(await readFile(stateFile, "utf8")) as {
      deliveries: { status: string; maxAttempts: number; retryDelayMs: number; nextAttemptAt?: string }[];
    };
    const nextAttemptAt = new Date(Date.now() + 60_000).toISOString();
    Object.assign(state.deliveries[0]!, {
      status: "pending",
      maxAttempts: 2,
      retryDelayMs: 60_000,
      nextAttemptAt,
    });
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const output = await runCli("events", "list", "--root", root);

    expect(output).toContain("1/2");
    expect(output).toContain(nextAttemptAt);
  });

  it("rejects offline mutations before writing while allowing inspection during an active runtime", async () => {
    const { root, stateFile } = await createFixture();
    await runCli("dispatch", "manual", "--root", root, "--id", "success", "--session", "work-1", "--input", "hello");
    await runCli("dispatch", "manual", "--root", root, "--id", "failure", "--session", "work-2", "--input", "fail");
    const seededState = JSON.parse(await readFile(stateFile, "utf8")) as {
      deliveries: { id: string; status: string }[];
    };
    const failedDelivery = seededState.deliveries.find(({ status }) => status === "failed");
    expect(failedDelivery).toBeDefined();

    const { runtime } = await loadProjectOrchestrator({ root });
    await runtime.start({ prettyStartupLog: false });
    try {
      expect(await runCli("doctor", "--root", root)).toContain("Doctor completed.");
      expect(await runCli("print-config", "--root", root)).toContain('"events": 2');
      expect(await runCli("state", "validate", "--root", root)).toContain("State is valid and compatible");
      expect(await runCli("sessions", "list", "--root", root)).toContain("work-1");
      expect(await runCli("sessions", "show", "work-1", "--root", root)).toContain('"lastInput": "hello"');
      expect(await runCli("events", "list", "--root", root)).toContain("failed");

      const failures = await Promise.all([
        runCliResult("dispatch", "manual", "--root", root, "--id", "blocked", "--session", "blocked", "--input", "blocked"),
        runCliResult("sessions", "end", "work-1", "--root", root),
        runCliResult("events", "retry", failedDelivery!.id, "--root", root),
      ]);
      for (const failure of failures) {
        expect(failure.failed).toBe(true);
        expect(failure.stderr).toMatch(new RegExp(`active orchestrator runtime.*PID ${process.pid}`, "i"));
      }
      expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual(seededState);
    } finally {
      await runtime.stop();
    }

    expect(await runCli("sessions", "end", "work-1", "--root", root)).toContain("ended");
    expect(await runCli("events", "retry", failedDelivery!.id, "--root", root)).toContain("retried");
  });

  it("previews state pruning without writing and requires offline ownership to apply it", async () => {
    const { root, stateFile } = await createFixture();
    await runCli("dispatch", "manual", "--root", root, "--id", "old", "--session", "old", "--input", "hello");
    await runCli("sessions", "end", "old", "--root", root);
    const seeded = JSON.parse(await readFile(stateFile, "utf8")) as {
      sessions: { endedAt?: string; updatedAt: string }[];
      deliveries: { processedAt?: string; updatedAt: string }[];
    };
    const old = "2020-01-01T00:00:00.000Z";
    Object.assign(seeded.sessions[0]!, { endedAt: old, updatedAt: old });
    Object.assign(seeded.deliveries[0]!, { processedAt: old, updatedAt: old });
    await writeFile(stateFile, `${JSON.stringify(seeded, null, 2)}\n`, "utf8");
    const beforePreview = await readFile(stateFile, "utf8");

    const falseFlags = JSON.parse(await runCli(
      "state", "prune", "--root", root, "--before", "2021-01-01T00:00:00.000Z", "--apply=false", "--drop-dedupe=false",
    )) as { applied: boolean; dropDedupe: boolean };
    expect(falseFlags).toMatchObject({ applied: false, dropDedupe: false });
    expect(await readFile(stateFile, "utf8")).toBe(beforePreview);
    const ambiguousFlag = await runCliResult(
      "state", "prune", "--root", root, "--before", "2021-01-01T00:00:00.000Z", "--apply=no",
    );
    expect(ambiguousFlag.failed).toBe(true);
    expect(ambiguousFlag.stderr).toContain("--apply must be a bare flag, true, or false");
    expect(await readFile(stateFile, "utf8")).toBe(beforePreview);

    const { runtime } = await loadProjectOrchestrator({ root });
    await runtime.start({ prettyStartupLog: false });
    try {
      const preview = JSON.parse(await runCli("state", "prune", "--root", root, "--before", "2021-01-01T00:00:00.000Z")) as {
        applied: boolean;
        deliveryIds: string[];
        sessionIds: string[];
      };
      expect(preview).toMatchObject({ applied: false });
      expect(preview.deliveryIds).toHaveLength(1);
      expect(preview.sessionIds).toHaveLength(1);
      expect(await readFile(stateFile, "utf8")).toBe(beforePreview);

      const failure = await runCliResult(
        "state", "prune", "--root", root, "--before", "2021-01-01T00:00:00.000Z", "--apply",
      );
      expect(failure.failed).toBe(true);
      expect(failure.stderr).toMatch(new RegExp(`active orchestrator runtime.*PID ${process.pid}`, "i"));
      expect(await readFile(stateFile, "utf8")).toBe(beforePreview);
    } finally {
      await runtime.stop();
    }

    const applied = JSON.parse(await runCli(
      "state", "prune", "--root", root, "--before", "2021-01-01T00:00:00.000Z", "--apply", "--drop-dedupe=false",
    )) as { applied: boolean };
    expect(applied.applied).toBe(true);
    const pruned = JSON.parse(await readFile(stateFile, "utf8")) as {
      sessions: unknown[];
      events: unknown[];
      deliveries: unknown[];
      notes: unknown[];
    };
    expect(pruned).toMatchObject({ sessions: [], deliveries: [], notes: [] });
    expect(pruned.events).toHaveLength(1);
  });

  it("classifies inspection and offline mutation commands in help", async () => {
    const output = await runCli("help");
    const inspectionHeading = output.indexOf("Inspection commands (safe while start is active)");
    const mutationHeading = output.indexOf("Offline mutation commands (require start to be stopped)");
    expect(inspectionHeading).toBeGreaterThan(-1);
    expect(mutationHeading).toBeGreaterThan(inspectionHeading);
    for (const command of ["doctor", "print-config", "state validate", "sessions list", "sessions show", "events list"]) {
      expect(output.indexOf(`simple-agent-orchestrator ${command}`)).toBeGreaterThan(inspectionHeading);
      expect(output.indexOf(`simple-agent-orchestrator ${command}`)).toBeLessThan(mutationHeading);
    }
    for (const command of ["dispatch", "sessions end", "events retry"]) {
      expect(output.indexOf(`simple-agent-orchestrator ${command}`)).toBeGreaterThan(mutationHeading);
    }
    expect(output).toContain("simple-agent-orchestrator state prune --before <timestamp> [--apply] [--drop-dedupe]");
  });
});
