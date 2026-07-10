import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

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
  builder.handle(manual, ({ event, session }) => {
    session.set("lastInput", event.input);
    session.note("Echoed input", { input: event.input });
  });
});
export default defineConfig({ channels: [manual], clients: [client] });
`,
      "utf8",
    );

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
});
