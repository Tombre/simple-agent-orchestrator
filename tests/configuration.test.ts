import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChannel, createClient } from "../src/index.js";
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
