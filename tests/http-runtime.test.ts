import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannel, createClient, createEnvironment, jsonFileStore, type Logger } from "../src/index.js";
import { createRuntime, deferred, waitFor } from "./helpers.js";

const runtimes: Array<Awaited<ReturnType<typeof createRuntime>>> = [];

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function occupy(port: number) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

async function occupyRange(length: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const base = await availablePort();
    if (base + length > 65_536) continue;
    const servers = [];
    try {
      for (let offset = 0; offset < length; offset += 1) servers.push(await occupy(base + offset));
      return { base, servers };
    } catch {
      await Promise.allSettled(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    }
  }
  throw new Error(`Could not reserve ${length} consecutive test ports`);
}

afterEach(async () => {
  delete process.env.SAO_HTTP_PORT;
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.stop()));
});

describe("HTTP runtime", () => {
  it("serves health with middleware before built-ins and custom routes after them", async () => {
    const port = await availablePort();
    const originalRequest = globalThis.Request;
    const originalResponse = globalThis.Response;
    const runtime = await createRuntime({
      http: {
        port,
        middleware({ app, project, logger, signal, dispatch }) {
          expect(project.root).toBe(process.cwd());
          expect(logger).toBeDefined();
          expect(signal.aborted).toBe(false);
          expect(dispatch).toBeTypeOf("function");
          app.use("*", async (context, next) => {
            await next();
            context.header("x-project-middleware", "yes");
          });
        },
        routes({ app }) {
          app.get("/custom", (context) => context.json({ custom: true }));
          app.get("/health", (context) => context.text("replaced"));
          app.get("/webhooks/custom", (context) => context.text("replaced"));
          app.get("/api/v1/custom", (context) => context.text("replaced"));
        },
      },
    });
    runtimes.push(runtime);

    await runtime.start({ prettyStartupLog: false });

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect(health.headers.get("x-project-middleware")).toBe("yes");
    expect(await fetch(`http://127.0.0.1:${port}/custom`).then((response) => response.json())).toEqual({ custom: true });
    expect((await fetch(`http://127.0.0.1:${port}/webhooks/custom`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/api/v1/custom`)).status).toBe(404);
    expect(globalThis.Request).toBe(originalRequest);
    expect(globalThis.Response).toBe(originalResponse);
  });

  it("uses SAO_HTTP_PORT before config and falls back sequentially on EADDRINUSE", async () => {
    const requestedPort = await availablePort();
    const occupied = await occupy(requestedPort);
    process.env.SAO_HTTP_PORT = String(requestedPort);
    const logger: Logger = {
      debug() {},
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const runtime = await createRuntime({ logger, http: { port: requestedPort + 20 } });
    runtimes.push(runtime);

    try {
      await runtime.start({ prettyStartupLog: false });
      expect((await fetch(`http://127.0.0.1:${requestedPort + 1}/health`)).status).toBe(200);
      expect(logger.info).toHaveBeenCalledWith("HTTP server listening on fallback port", expect.objectContaining({
        requestedPort,
        port: requestedPort + 1,
        url: `http://127.0.0.1:${requestedPort + 1}`,
      }));
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("validates configured and environment ports as base-10 integers", async () => {
    for (const port of [0, 65_536, 1.5, Number.NaN]) {
      await expect(createRuntime({ http: { port } }).then((runtime) => runtime.init())).rejects.toThrow("Invalid HTTP port");
    }

    process.env.SAO_HTTP_PORT = " 3000";
    const runtime = await createRuntime({ http: { port: await availablePort() } });
    runtimes.push(runtime);
    await expect(runtime.start({ prettyStartupLog: false })).rejects.toThrow("Invalid HTTP port in SAO_HTTP_PORT");
  });

  it("bounds occupied-port fallback and rolls back without changing global web constructors", async () => {
    const originalRequest = globalThis.Request;
    const originalResponse = globalThis.Response;
    const { base, servers } = await occupyRange(10);
    const events: string[] = [];
    const environment = createEnvironment("fallback-rollback", (builder) => {
      builder.onMount(() => {
        events.push("mount");
      });
      builder.onUnmount(() => {
        events.push("unmount");
      });
    });
    const channel = createChannel("fallback-channel");
    const client = createClient("fallback-client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, () => {});
    });
    const runtime = await createRuntime({
      channels: [channel],
      clients: [client],
      http: { port: base },
    });

    try {
      await expect(runtime.start({ prettyStartupLog: false })).rejects.toThrow(
        `Unable to bind HTTP server after 10 attempts from port ${base}`,
      );
    } finally {
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    }
    expect(events).toEqual(["mount", "unmount"]);
    expect(globalThis.Request).toBe(originalRequest);
    expect(globalThis.Response).toBe(originalResponse);
  });

  it("does not fall back for non-EADDRINUSE listener errors", async () => {
    const runtime = await createRuntime({ http: { hostname: "invalid hostname" } });
    await expect(runtime.start({ prettyStartupLog: false })).rejects.toMatchObject({ code: expect.not.stringMatching("EADDRINUSE") });
  });

  it("does not wrap fallback beyond port 65535", async () => {
    let occupied: Awaited<ReturnType<typeof occupy>> | undefined;
    try {
      occupied = await occupy(65_535);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
    }
    const runtime = await createRuntime({ http: { port: 65_535 } });
    try {
      await expect(runtime.start({ prettyStartupLog: false })).rejects.toThrow(
        "Unable to bind HTTP server after 1 attempts from port 65535",
      );
    } finally {
      if (occupied) await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it("warns from the actual non-loopback bound address", async () => {
    const port = await availablePort();
    const logger: Logger = {
      debug() {},
      info() {},
      warn: vi.fn(),
      error() {},
    };
    const runtime = await createRuntime({ logger, http: { hostname: "0.0.0.0", port } });
    runtimes.push(runtime);
    await runtime.start({ prettyStartupLog: false });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("non-loopback"),
      expect.objectContaining({ hostname: "0.0.0.0", address: "0.0.0.0", port }),
    );
  });

  it("does not set up HTTP when disabled, draining, offline, or initializing", async () => {
    const hook = vi.fn();
    const disabled = await createRuntime({ http: { routes: hook } });
    runtimes.push(disabled);
    await disabled.start({ http: false, prettyStartupLog: false });
    expect(hook).not.toHaveBeenCalled();

    process.env.SAO_HTTP_PORT = "invalid";
    const configDisabled = await createRuntime({ http: { enabled: false, routes: hook } });
    runtimes.push(configDisabled);
    await configDisabled.start({ prettyStartupLog: false });
    expect(hook).not.toHaveBeenCalled();
    delete process.env.SAO_HTTP_PORT;

    const draining = await createRuntime({ http: { routes: hook } });
    await draining.start({ drain: true, prettyStartupLog: false });
    expect(hook).not.toHaveBeenCalled();

    const directDrain = await createRuntime({ http: { routes: hook } });
    runtimes.push(directDrain);
    await directDrain.drain();
    expect(hook).not.toHaveBeenCalled();

    const offline = await createRuntime({ http: { routes: hook } });
    await offline.runOffline(async () => undefined);
    expect(hook).not.toHaveBeenCalled();
  });

  it("rolls back mounted environments when route setup fails", async () => {
    const events: string[] = [];
    const environment = createEnvironment("http-rollback", (builder) => {
      builder.onMount(() => {
        events.push("mount");
      });
      builder.onUnmount(() => {
        events.push("unmount");
      });
    });
    const channel = createChannel("unused");
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, () => {});
    });
    const runtime = await createRuntime({
      channels: [channel],
      clients: [client],
      http: {
        routes() {
          throw new Error("route setup failed");
        },
      },
    });

    await expect(runtime.start({ prettyStartupLog: false })).rejects.toThrow("route setup failed");
    expect(events).toEqual(["mount", "unmount"]);
  });

  it("releases JSON store ownership after HTTP setup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-http-rollback-"));
    const statePath = join(root, "state.json");
    const failing = await createRuntime({
      store: jsonFileStore(statePath),
      http: {
        routes() {
          throw new Error("route setup failed");
        },
      },
    });
    await expect(failing.start({ prettyStartupLog: false })).rejects.toThrow("route setup failed");

    const replacement = await createRuntime({ store: jsonFileStore(statePath) });
    runtimes.push(replacement);
    await replacement.start({ http: false, prettyStartupLog: false });
  });

  it("stops accepting requests and lets accepted dispatch work settle before cleanup", async () => {
    const port = await availablePort();
    const requestAccepted = deferred();
    const continueRequest = deferred();
    const channel = createChannel("http-dispatch");
    const cleanup = vi.fn();
    const environment = createEnvironment("cleanup", (builder) => builder.onUnmount(cleanup));
    const client = createClient("client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, () => {});
    });
    const runtime = await createRuntime({
      channels: [channel],
      clients: [client],
      http: {
        port,
        routes({ app, dispatch }) {
          app.post("/dispatch", async (context) => {
            requestAccepted.resolve();
            await continueRequest.promise;
            return context.json(await dispatch("http-dispatch", { id: "accepted" }));
          });
        },
      },
    });
    runtimes.push(runtime);
    await runtime.start({ prettyStartupLog: false });

    const request = fetch(`http://127.0.0.1:${port}/dispatch`, { method: "POST" });
    await requestAccepted.promise;
    const stopping = runtime.stop();
    await waitFor(async () => {
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    });
    expect(cleanup).not.toHaveBeenCalled();

    continueRequest.resolve();
    expect((await request).status).toBe(200);
    await stopping;
    expect(cleanup).toHaveBeenCalledOnce();
    expect((await runtime.listEvents()).map(({ event }) => event.sourceId)).toContain("accepted");
  });

  it("rejects detached request work after its response has settled", async () => {
    const port = await availablePort();
    const detachedResult = deferred<unknown>();
    const channel = createChannel("detached");
    const runtime = await createRuntime({
      channels: [channel],
      http: {
        port,
        routes({ app, dispatch }) {
          app.post("/detached", (context) => {
            setTimeout(() => {
              void dispatch("detached", { id: "too-late" }).then(detachedResult.resolve, detachedResult.resolve);
            }, 20);
            return context.json({ accepted: true });
          });
        },
      },
    });
    runtimes.push(runtime);
    await runtime.start({ prettyStartupLog: false });
    expect((await fetch(`http://127.0.0.1:${port}/detached`, { method: "POST" })).status).toBe(200);

    await runtime.stop();

    await expect(detachedResult.promise).resolves.toMatchObject({ message: "HTTP server is not accepting requests" });
    expect(await runtime.listEvents()).toEqual([]);
  });

  it("rejects new route work when listener close fails", async () => {
    const port = await availablePort();
    const channel = createChannel("close-failure");
    const runtime = await createRuntime({
      channels: [channel],
      http: {
        port,
        routes({ app, dispatch }) {
          app.post("/dispatch-after-close", async (context) => context.json(
            await dispatch("close-failure", { id: "must-not-write" }),
          ));
        },
      },
    });
    runtimes.push(runtime);
    await runtime.start({ prettyStartupLog: false });
    const internal = runtime as unknown as { httpServer: ReturnType<typeof createServer> };
    const server = internal.httpServer;
    const close = server.close.bind(server);
    let closes = 0;
    server.close = ((callback?: (error?: Error) => void) => {
      closes += 1;
      if (closes === 1) {
        queueMicrotask(() => callback?.(new Error("simulated close failure")));
        return server;
      }
      return close(callback);
    }) as typeof server.close;

    await expect(runtime.stop()).rejects.toThrow("simulated close failure");
    const response = await fetch(`http://127.0.0.1:${port}/dispatch-after-close`, { method: "POST" });
    expect(response.status).toBe(503);
    expect(await runtime.listEvents()).toEqual([]);
    await runtime.stop();
  });

  it("aggregates HTTP, environment, and ownership cleanup failures and retries unresolved work", async () => {
    let unmounts = 0;
    const environment = createEnvironment("retry-cleanup", (builder) => {
      builder.onUnmount(() => {
        unmounts += 1;
        if (unmounts === 1) throw new Error("unmount failed");
      });
    });
    const channel = createChannel("cleanup-channel");
    const client = createClient("cleanup-client", (builder) => {
      builder.useEnvironment(environment);
      builder.handle(channel, () => {});
    });
    const runtime = await createRuntime({ channels: [channel], clients: [client] });
    runtimes.push(runtime);
    await runtime.start({ http: false, prettyStartupLog: false });

    let closes = 0;
    let releases = 0;
    const internal = runtime as unknown as {
      httpServer: {
        close(callback: (error?: Error) => void): void;
        closeIdleConnections(): void;
      };
      ownership: { release(): Promise<void> };
    };
    internal.httpServer = {
      close(callback) {
        closes += 1;
        callback(closes === 1 ? new Error("HTTP close failed") : undefined);
      },
      closeIdleConnections() {},
    };
    internal.ownership = {
      async release() {
        releases += 1;
        if (releases === 1) throw new Error("ownership release failed");
      },
    };

    const firstStop = runtime.stop().catch((error: unknown) => error);
    const concurrentStop = runtime.stop().catch((error: unknown) => error);
    const [firstError, concurrentError] = await Promise.all([firstStop, concurrentStop]);
    expect(firstError).toBe(concurrentError);
    expect(firstError).toBeInstanceOf(AggregateError);
    expect((firstError as AggregateError).errors.map((error) => (error as Error).message)).toEqual([
      "HTTP close failed",
      "unmount failed",
      "ownership release failed",
    ]);

    await runtime.stop();
    expect({ closes, unmounts, releases }).toEqual({ closes: 2, unmounts: 2, releases: 2 });
    await runtime.stop();
    expect({ closes, unmounts, releases }).toEqual({ closes: 2, unmounts: 2, releases: 2 });
  });

  it("does not retry a listener that closed when idle cleanup failed", async () => {
    const port = await availablePort();
    const runtime = await createRuntime({ http: { port } });
    runtimes.push(runtime);
    await runtime.start({ prettyStartupLog: false });
    const internal = runtime as unknown as { httpServer: ReturnType<typeof createServer> };
    const realServer = internal.httpServer;
    await new Promise<void>((resolve, reject) => realServer.close((error) => error ? reject(error) : resolve()));
    let closes = 0;
    let idleCloses = 0;
    internal.httpServer = {
      close(callback?: (error?: Error) => void) {
        closes += 1;
        callback?.();
        return this;
      },
      closeIdleConnections() {
        idleCloses += 1;
        if (idleCloses === 1) throw new Error("idle cleanup failed");
      },
    } as ReturnType<typeof createServer>;

    await expect(runtime.stop()).rejects.toThrow("idle cleanup failed");
    await runtime.stop();
    expect(closes).toBe(1);
  });
});
