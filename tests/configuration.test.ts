import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChannel, createClient } from "../src/index.js";
import { MAX_RETRY_DELAY_MS, MAX_TIMER_DURATION_MS } from "../src/utils/time.js";
import { findConfigFile, findProjectRoot, loadProjectConfig } from "../src/runtime/project.js";
import { createRuntime } from "./helpers.js";

describe("configuration validation", () => {
  it("rejects ambiguous channel, client, and per-client handler identifiers", async () => {
    const channel = createChannel("same");
    const duplicateChannel = createChannel("same");
    await expect(createRuntime({ channels: [channel, duplicateChannel] }).then((runtime) => runtime.init())).rejects.toThrow(
      "Duplicate channel id: same",
    );

    const firstClient = createClient("same", () => {});
    const secondClient = createClient("same", () => {});
    await expect(createRuntime({ clients: [firstClient, secondClient] }).then((runtime) => runtime.init())).rejects.toThrow(
      "Duplicate client id: same",
    );

    const duplicateHandlers = createClient("client", (builder) => {
      builder.handle(channel, { id: "same", handle() {} });
      builder.handle(channel, { id: "same", handle() {} });
    });
    await expect(createRuntime({ channels: [channel], clients: [duplicateHandlers] }).then((runtime) => runtime.init())).rejects.toThrow(
      "Duplicate handler id for client client: same",
    );
  });

  it("rejects duplicate and ambiguous poll identifiers within a channel", async () => {
    const duplicatePolls = createChannel("polls", (builder) => {
      builder.poll({ id: "reviews", every: "1m", fetch: () => [] });
      builder.poll({ id: "reviews", every: "5m", fetch: () => [] });
    });
    await expect(createRuntime({ channels: [duplicatePolls] }).then((runtime) => runtime.init())).rejects.toThrow(
      "Duplicate poll id for channel polls: reviews",
    );

    const positionalCollision = createChannel("polls", (builder) => {
      builder.poll({ id: "1", every: "1m", fetch: () => [] });
      builder.poll({ every: "5m", fetch: () => [] });
    });
    await expect(createRuntime({ channels: [positionalCollision] }).then((runtime) => runtime.init())).rejects.toThrow(
      "Duplicate poll id for channel polls: 1",
    );

    const firstAmbiguousChannel = createChannel("polls", (builder) => {
      builder.poll({ id: "reviews:0", every: "1m", fetch: () => [] });
    });
    const secondAmbiguousChannel = createChannel("polls:reviews", (builder) => {
      builder.poll({ every: "5m", fetch: () => [] });
    });
    await expect(
      createRuntime({ channels: [firstAmbiguousChannel, secondAmbiguousChannel] }).then((runtime) => runtime.init()),
    ).rejects.toThrow("Duplicate poll cursor id: polls:reviews:0");
  });

  it("rejects invalid retry delays before runtime work starts", async () => {
    const channel = createChannel("retry");
    const client = createClient("client", (builder) => {
      builder.handle(channel, { retries: { delay: "later" }, handle() {} });
    });

    await expect(createRuntime({ channels: [channel], clients: [client] }).then((runtime) => runtime.init())).rejects.toThrow(
      "Invalid duration string: later",
    );
    await expect(createRuntime({ retries: { delay: -1 } }).then((runtime) => runtime.init())).rejects.toThrow(
      "Invalid duration: -1",
    );
    await expect(createRuntime({ retries: { delay: MAX_RETRY_DELAY_MS + 1 } }).then((runtime) => runtime.init())).rejects.toThrow(
      "exceeds the supported range",
    );
    await expect(createRuntime({ retries: { delay: `${MAX_RETRY_DELAY_MS}.1ms` } }).then((runtime) => runtime.init())).rejects.toThrow(
      "exceeds the supported range",
    );
  });

  it("rejects invalid handler timeouts before runtime work starts", async () => {
    const channel = createChannel("timeout");
    const client = createClient("client", (builder) => {
      builder.timeout("later");
      builder.handle(channel, { timeout: -1, handle() {} });
    });

    await expect(createRuntime({ timeout: "later" }).then((runtime) => runtime.init())).rejects.toThrow(
      "Invalid duration string: later",
    );
    await expect(createRuntime({ timeout: MAX_TIMER_DURATION_MS + 1 }).then((runtime) => runtime.init())).rejects.toThrow(
      "Invalid handler timeout",
    );
    await expect(createRuntime({ channels: [channel], clients: [client] }).then((runtime) => runtime.init())).rejects.toThrow(
      "Invalid duration string: later",
    );

    const handlerOnly = createClient("handler-only", (builder) => {
      builder.handle(channel, { timeout: -1, handle() {} });
    });
    await expect(
      createRuntime({ channels: [channel], clients: [handlerOnly] }).then((runtime) => runtime.init()),
    ).rejects.toThrow("Invalid duration: -1");
  });

  it("keeps the repository root when an explicit config is inside the orchestrator directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-project-"));
    const orchestratorDir = join(root, ".simple-agent-orchestrator");
    const configFile = join(orchestratorDir, "orchestrator.ts");
    await mkdir(orchestratorDir, { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }), "utf8");
    await writeFile(configFile, "export default { channels: [], clients: [] };", "utf8");

    expect(await findProjectRoot({ config: configFile })).toBe(root);
    const loaded = await loadProjectConfig({ config: configFile });
    expect(loaded.project.root).toBe(root);
    expect(loaded.project.orchestratorDir).toBe(orchestratorDir);
  });

  it("prefers the nearest package boundary over a distant orchestrator directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-project-"));
    const packageRoot = join(root, "packages", "api");
    const sourceDirectory = join(packageRoot, "src");
    await mkdir(join(root, ".simple-agent-orchestrator"), { recursive: true });
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "workspace" }), "utf8");
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "api" }), "utf8");

    expect(await findProjectRoot({ cwd: sourceDirectory })).toBe(packageRoot);
  });

  it("treats the conventional orchestrator directory as part of its parent project", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-project-"));
    const orchestratorDir = join(root, ".simple-agent-orchestrator");
    const clientDirectory = join(orchestratorDir, "clients");
    const configFile = join(orchestratorDir, "orchestrator.ts");
    await mkdir(clientDirectory, { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
    await writeFile(join(orchestratorDir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    await writeFile(configFile, "export default {};", "utf8");

    expect(await findProjectRoot({ cwd: clientDirectory })).toBe(root);
    expect(await findProjectRoot({ config: configFile })).toBe(root);
  });

  it("prefers the conventional config before a package.json pointer", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-project-"));
    const orchestratorDir = join(root, ".simple-agent-orchestrator");
    await mkdir(orchestratorDir, { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ simpleAgentOrchestrator: { config: "custom.ts" } }),
      "utf8",
    );
    await writeFile(join(orchestratorDir, "orchestrator.ts"), "export default {};", "utf8");
    await writeFile(join(root, "custom.ts"), "export default {};", "utf8");

    const project = (await loadProjectConfig({ root })).project;
    expect(await findConfigFile(project)).toBe(join(orchestratorDir, "orchestrator.ts"));
  });

  it("does not create an orchestrator directory while reporting a missing config", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-project-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");

    await expect(loadProjectConfig({ root })).rejects.toThrow("Could not find");
    await expect(readFile(join(root, ".simple-agent-orchestrator"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
