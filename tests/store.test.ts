import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURRENT_STATE_VERSION,
  StateValidationError,
  jsonFileStore,
  memoryStore,
  validateAndMigrateState,
} from "../src/index.js";
import { emptyState } from "../src/stores/store.js";
import { initializeJsonStateFile } from "../src/stores/json-file.js";
import { MAX_RETRY_DELAY_MS } from "../src/utils/time.js";

describe("stores", () => {
  it("isolates reads and writes in memory", async () => {
    const store = memoryStore();
    const first = await store.read();
    first.events.push({
      id: "internal",
      sourceId: "source",
      channelId: "channel",
      dedupeKey: "dedupe",
      sessionKey: "session",
      receivedAt: new Date(0).toISOString(),
    });
    expect((await store.read()).events).toHaveLength(0);

    await store.write(first);
    const second = await store.read();
    second.events.length = 0;
    expect((await store.read()).events).toHaveLength(1);
  });

  it("persists JSON state across store instances without overwriting existing data", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-store-"));
    const path = join(root, "nested", "state.json");
    const state = emptyState();
    state.cursors.poll = { page: 3 };
    const first = jsonFileStore(path);
    await first.init();
    await first.write(state);

    const second = jsonFileStore(path);
    await second.init();

    expect((await second.read()).cursors).toEqual({ poll: { page: 3 } });
  });

  it("reports malformed JSON instead of replacing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-store-"));
    const path = join(root, "state.json");
    await writeFile(path, "not json", "utf8");
    const store = jsonFileStore(path);

    await expect(store.read()).rejects.toMatchObject({
      code: "invalid-json",
    });
    expect(await readFile(path, "utf8")).toBe("not json");
  });

  it("creates a current empty snapshot only when the state file is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-store-"));
    const path = join(root, "nested", "state.json");

    await jsonFileStore(path).init();

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(emptyState());
    expect(emptyState().version).toBe(CURRENT_STATE_VERSION);
  });

  it("initializes one complete snapshot when first-run callers race", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-store-"));
    const path = join(root, "nested", "state.json");

    await Promise.all(Array.from({ length: 20 }, () => jsonFileStore(path).init()));

    expect(await jsonFileStore(path).read()).toEqual(emptyState());
  });

  it("does not overwrite state when a delayed initializer publishes after another caller", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-store-"));
    const path = join(root, "state.json");
    const winner = emptyState();
    winner.cursors.poll = { page: 4 };
    const raw = JSON.stringify(winner, null, 2);
    await writeFile(path, raw, "utf8");

    await initializeJsonStateFile(path);

    expect(await readFile(path, "utf8")).toBe(raw);
  });

  it("deterministically upgrades historical fixtures with immediate retry defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-store-"));
    const fixturePath = join(import.meta.dirname, "fixtures", "state", "version-1.json");
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
    const historicalDeliveries = fixture.deliveries as Record<string, unknown>[];

    for (const version of [1, 2]) {
      const path = join(root, `state-v${version}.json`);
      const historical = { ...fixture, version };
      const raw = JSON.stringify(historical, null, 2);
      await writeFile(path, raw, "utf8");

      const migrated = await jsonFileStore(path).read();

      expect(migrated).toEqual({
        ...historical,
        version: CURRENT_STATE_VERSION,
        capacityReservations: [],
        sandboxes: [],
        exhaustions: [],
        deliveries: historicalDeliveries.map((delivery) => ({
          ...delivery,
          retryDelayMs: 0,
          phase: delivery.status === "processed" ? "completed" : "sandbox",
        })),
      });
      expect(await jsonFileStore(path).read()).toEqual(migrated);
      expect(await readFile(path, "utf8")).toBe(raw);

      await jsonFileStore(path).write(migrated);
      expect((JSON.parse(await readFile(path, "utf8")) as { version: number }).version).toBe(CURRENT_STATE_VERSION);
    }
  });

  it("upgrades version 3 without reinterpreting its retry fields", async () => {
    const fixturePath = join(import.meta.dirname, "fixtures", "state", "version-1.json");
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
    const deliveries = (fixture.deliveries as Record<string, unknown>[]).map((delivery) => ({
      ...delivery,
      retryDelayMs: 250,
    }));
    const versionThree = { ...fixture, version: 3, deliveries };

    expect(validateAndMigrateState(versionThree)).toEqual({
      ...versionThree,
      version: CURRENT_STATE_VERSION,
      capacityReservations: [],
      sandboxes: [],
      exhaustions: [],
      deliveries: deliveries.map((delivery) => ({
        ...delivery,
        phase: (delivery as Record<string, unknown>).status === "processed" ? "completed" : "sandbox",
      })),
    });
  });

  it("upgrades version 4 state and validates terminal ignored deliveries", () => {
    const time = new Date(0).toISOString();
    const { sandboxes: _sandboxes, exhaustions: _exhaustions, ...versionFourBase } = emptyState();
    const versionFour = {
      ...versionFourBase,
      version: 4,
      events: [{
        id: "event",
        channelId: "manual",
        sourceId: "source",
        dedupeKey: "manual:source",
        sessionKey: "work",
        receivedAt: time,
      }],
      deliveries: [{
        id: "delivery",
        eventId: "event",
        channelId: "manual",
        clientId: "client",
        handlerId: "handler",
        status: "processed" as const,
        attempts: 1,
        maxAttempts: 1,
        retryDelayMs: 0,
        createdAt: time,
        updatedAt: time,
        processedAt: time,
      }],
    };
    expect(validateAndMigrateState(versionFour)).toMatchObject({
      version: CURRENT_STATE_VERSION,
      deliveries: [{ status: "processed", phase: "completed" }],
    });

    const ignored = {
      ...emptyState(),
      events: versionFour.events,
      deliveries: [{
        ...versionFour.deliveries[0],
        status: "ignored",
        phase: "completed",
        attempts: 0,
        ignoredReason: "session-missing",
      }],
    };
    expect(validateAndMigrateState(ignored)).toEqual(ignored);
    expect(validateAndMigrateState({
      ...ignored,
      deliveries: [{
        ...ignored.deliveries[0],
        ignoredReason: "session-ended",
        sessionId: "removed-session",
      }],
    })).toMatchObject({
      deliveries: [{ ignoredReason: "session-ended", sessionId: "removed-session" }],
    });
    expect(() => validateAndMigrateState({
      ...ignored,
      deliveries: [{ ...ignored.deliveries[0], ignoredReason: undefined }],
    })).toThrow("ignoredReason");
    expect(() => validateAndMigrateState({
      ...ignored,
      deliveries: [{ ...ignored.deliveries[0], startedAt: time }],
    })).toThrow("startedAt");
    expect(() => validateAndMigrateState({
      ...ignored,
      deliveries: [{ ...ignored.deliveries[0], lastError: "should not run" }],
    })).toThrow("lastError");
  });

  it("upgrades version 5 without guessing sandbox ownership from legacy session flags", () => {
    const versionFive = {
      ...emptyState(),
      version: 5,
      sessions: [{
        id: "session",
        key: "work",
        status: "active" as const,
        state: { "__sao.sandbox.workspace.created": true },
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }],
    };
    const { sandboxes: _sandboxes, exhaustions: _exhaustions, ...historical } = versionFive;

    expect(validateAndMigrateState(historical)).toEqual({
      ...historical,
      version: CURRENT_STATE_VERSION,
      sandboxes: [],
      exhaustions: [],
    });
  });

  it("upgrades version 6 deliveries to conservative next phases", () => {
    const time = new Date(0).toISOString();
    const { exhaustions: _exhaustions, ...base } = emptyState();
    const versionSix = {
      ...base,
      version: 6,
      events: ["pending", "processed"].map((id) => ({
        id: `event-${id}`,
        channelId: "manual",
        sourceId: id,
        dedupeKey: `manual:${id}`,
        sessionKey: id,
        receivedAt: time,
      })),
      deliveries: [
        {
          id: "delivery-pending",
          eventId: "event-pending",
          channelId: "manual",
          clientId: "client",
          handlerId: "handler",
          status: "pending",
          attempts: 0,
          maxAttempts: 1,
          retryDelayMs: 0,
          createdAt: time,
          updatedAt: time,
        },
        {
          id: "delivery-processed",
          eventId: "event-processed",
          channelId: "manual",
          clientId: "client",
          handlerId: "handler",
          status: "processed",
          attempts: 1,
          maxAttempts: 1,
          retryDelayMs: 0,
          createdAt: time,
          updatedAt: time,
          processedAt: time,
        },
      ],
    };

    expect(validateAndMigrateState(versionSix)).toMatchObject({
      version: CURRENT_STATE_VERSION,
      exhaustions: [],
      deliveries: [
        { id: "delivery-pending", phase: "sandbox" },
        { id: "delivery-processed", phase: "completed" },
      ],
    });
  });

  it("upgrades version 7 sandboxes with absent resources and empty cleanup steps", () => {
    const timestamp = new Date(0).toISOString();
    const current = emptyState();
    current.sessions.push({
      id: "session",
      key: "work",
      status: "active",
      state: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    current.sandboxes.push({
      sessionId: "session",
      clientId: "client",
      environmentId: "workspace",
      status: "active",
      checkpoint: {},
      cleanupSteps: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const historicalSandbox = { ...current.sandboxes[0] } as Record<string, unknown>;
    delete historicalSandbox.cleanupSteps;
    const versionSeven = {
      ...current,
      version: 7,
      sandboxes: [historicalSandbox],
    };

    expect(validateAndMigrateState(versionSeven)).toEqual({
      ...versionSeven,
      version: CURRENT_STATE_VERSION,
      sandboxes: [{ ...historicalSandbox, cleanupSteps: {} }],
    });
  });

  it("validates durable sandbox identities, statuses, references, and JSON-safe checkpoints", () => {
    const state = {
      ...emptyState(),
      sessions: [{
        id: "session",
        key: "work",
        status: "active" as const,
        state: {},
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }],
      sandboxes: [{
        sessionId: "session",
        clientId: "agent",
        environmentId: "workspace",
        status: "active" as const,
        checkpoint: { workspaceId: "ws-1" },
        cleanupSteps: {},
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }],
    };

    expect(validateAndMigrateState(state)).toEqual(state);
    expect(() => validateAndMigrateState({
      ...state,
      sandboxes: [...state.sandboxes, { ...state.sandboxes[0]!, status: "cleaned" }],
    })).toThrow("duplicates a sessionId, clientId, and environmentId identity");
    expect(() => validateAndMigrateState({
      ...state,
      sandboxes: [{ ...state.sandboxes[0]!, sessionId: "missing" }],
    })).toThrow("references missing session");
    expect(() => validateAndMigrateState({
      ...state,
      sandboxes: [{ ...state.sandboxes[0]!, status: "lost" }],
    })).toThrow("status must be creating, active, cleaning, cleaned, or unknown");
    expect(() => validateAndMigrateState({
      ...state,
      sandboxes: [{ ...state.sandboxes[0]!, checkpoint: { invalid: undefined } }],
    })).toThrow("must be JSON-safe");
  });

  it("validates sandbox resources and cleanup step state relationships", () => {
    const timestamp = new Date(0).toISOString();
    const state = {
      ...emptyState(),
      sessions: [{
        id: "session",
        key: "work",
        status: "active" as const,
        state: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
      sandboxes: [{
        sessionId: "session",
        clientId: "agent",
        environmentId: "workspace",
        status: "cleaning" as const,
        checkpoint: {},
        resource: { workspace: { id: "ws-1" } },
        cleanupSteps: {
          remove: {
            status: "completed" as const,
            attempts: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
            startedAt: timestamp,
            completedAt: timestamp,
          },
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
    };

    expect(validateAndMigrateState(state)).toEqual(state);
    expect(() => validateAndMigrateState({
      ...state,
      sandboxes: [{ ...state.sandboxes[0]!, resource: { invalid: Number.NaN } }],
    })).toThrow("resource.invalid must be JSON-safe");
    expect(() => validateAndMigrateState({
      ...state,
      sandboxes: [{ ...state.sandboxes[0]!, cleanupSteps: { "": state.sandboxes[0]!.cleanupSteps.remove } }],
    })).toThrow("empty step id");
    expect(() => validateAndMigrateState({
      ...state,
      sandboxes: [{
        ...state.sandboxes[0]!,
        cleanupSteps: {
          remove: {
            ...state.sandboxes[0]!.cleanupSteps.remove,
            status: "failed",
            completedAt: undefined,
            lastError: undefined,
          },
        },
      }],
    })).toThrow("lastError is required");
    expect(() => validateAndMigrateState({
      ...state,
      sandboxes: [{
        ...state.sandboxes[0]!,
        cleanupSteps: { remove: { ...state.sandboxes[0]!.cleanupSteps.remove, completedAt: new Date(-1).toISOString() } },
      }],
    })).toThrow("completedAt cannot precede startedAt");
  });

  it("clones nested sandbox resources and cleanup steps on memory-store reads", async () => {
    const timestamp = new Date(0).toISOString();
    const state = emptyState();
    state.sessions.push({
      id: "session",
      key: "work",
      status: "active",
      state: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    state.sandboxes.push({
      sessionId: "session",
      clientId: "client",
      environmentId: "workspace",
      status: "active",
      checkpoint: {},
      resource: { nested: { value: "original" } },
      cleanupSteps: {
        remove: {
          status: "running",
          attempts: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          startedAt: timestamp,
        },
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const store = memoryStore(state);

    const inspected = await store.read();
    (inspected.sandboxes[0]!.resource as { nested: { value: string } }).nested.value = "changed";
    inspected.sandboxes[0]!.cleanupSteps.remove!.attempts = 99;

    expect((await store.read()).sandboxes[0]).toMatchObject({
      resource: { nested: { value: "original" } },
      cleanupSteps: { remove: { attempts: 1 } },
    });
  });

  it("validates durable capacity reservation identities and session references", () => {
    const state = {
      ...emptyState(),
      sessions: [{
        id: "session",
        key: "work",
        status: "active" as const,
        state: {},
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }],
      capacityReservations: [{
        id: "capacity",
        clientId: "agent",
        sessionId: "session",
        acquiredAt: new Date(0).toISOString(),
      }],
    };

    expect(validateAndMigrateState(state)).toEqual(state);
    expect(() => validateAndMigrateState({
      ...state,
      capacityReservations: [...state.capacityReservations, { ...state.capacityReservations[0]!, id: "other" }],
    })).toThrow("duplicates a clientId and sessionId identity");
    expect(() => validateAndMigrateState({
      ...state,
      capacityReservations: [{ ...state.capacityReservations[0]!, sessionId: "missing" }],
    })).toThrow("references missing session");
    expect(() => validateAndMigrateState({
      ...state,
      sessions: [{ ...state.sessions[0]!, status: "ended" }],
    })).toThrow("must reference an active session");
  });

  it("accepts historical exhaustion work after its source delivery is manually retried", () => {
    const time = new Date(0).toISOString();
    const state = {
      ...emptyState(),
      events: [{
        id: "event",
        channelId: "manual",
        sourceId: "source",
        dedupeKey: "source",
        sessionKey: "session",
        receivedAt: time,
      }],
      deliveries: [{
        id: "delivery",
        eventId: "event",
        channelId: "manual",
        clientId: "client",
        handlerId: "handler",
        status: "processed" as const,
        phase: "completed" as const,
        attempts: 2,
        maxAttempts: 2,
        retryDelayMs: 0,
        createdAt: time,
        updatedAt: time,
        processedAt: time,
      }],
      exhaustions: [{
        id: "exhaustion",
        sourceDeliveryId: "delivery",
        eventId: "event",
        clientId: "client",
        stage: "handling" as const,
        failure: { name: "Error", message: "Operation failed." },
        status: "processed" as const,
        attempts: 1,
        maxAttempts: 1,
        retryDelayMs: 0,
        createdAt: time,
        updatedAt: time,
        processedAt: time,
      }],
    };

    expect(validateAndMigrateState(state)).toEqual(state);
  });

  it.each([
    ["negative retry delay", { retryDelayMs: -1 }, "retryDelayMs must be an integer"],
    ["fractional retry delay", { retryDelayMs: 0.5 }, "retryDelayMs must be an integer"],
    ["retry delay outside the supported range", { retryDelayMs: MAX_RETRY_DELAY_MS + 1 }, "exceeds the supported range"],
    ["invalid eligibility timestamp", { retryDelayMs: 1, nextAttemptAt: "later" }, "nextAttemptAt must be a valid timestamp"],
    ["eligibility on terminal work", { status: "failed", attempts: 2, retryDelayMs: 1, nextAttemptAt: new Date(0).toISOString() }, "only valid for pending"],
  ])("rejects %s", async (_name, overrides, message) => {
    const root = await mkdtemp(join(tmpdir(), "sao-store-"));
    const path = join(root, "state.json");
    const state = {
      ...emptyState(),
      events: [{
        id: "event",
        channelId: "manual",
        sourceId: "source",
        dedupeKey: "manual:source",
        sessionKey: "session",
        receivedAt: "now",
      }],
      deliveries: [{
        id: "delivery",
        eventId: "event",
        channelId: "manual",
        clientId: "client",
        handlerId: "handler",
        status: "pending",
        phase: "sandbox",
        attempts: 1,
        maxAttempts: 2,
        createdAt: "now",
        updatedAt: "now",
        ...overrides,
      }],
    };

    await writeFile(path, JSON.stringify(state), "utf8");
    await expect(jsonFileStore(path).read()).rejects.toThrow(message);
  });

  it.each([
    ["top-level null", "null", "state must be an object"],
    ["missing version", JSON.stringify({ sessions: [], events: [], deliveries: [], notes: [], cursors: {} }), "state.version is required"],
    ["future version", JSON.stringify({ ...emptyState(), version: CURRENT_STATE_VERSION + 1 }), "newer than this package supports"],
    ["obsolete version", JSON.stringify({ ...emptyState(), version: 0 }), "older than the minimum supported version"],
    ["invalid collection", JSON.stringify({ ...emptyState(), sessions: null }), "state.sessions must be an array"],
    [
      "invalid nested field",
      JSON.stringify({
        ...emptyState(),
        deliveries: [{
          id: "delivery",
          eventId: "event",
          channelId: "manual",
          clientId: "client",
          handlerId: "handler",
          status: "waiting",
          phase: "sandbox",
          attempts: 0,
          maxAttempts: 1,
          retryDelayMs: 0,
          createdAt: "now",
          updatedAt: "now",
        }],
      }),
      "state.deliveries[0].status",
    ],
    [
      "dangling reference",
      JSON.stringify({
        ...emptyState(),
        notes: [{ id: "note", sessionId: "missing", message: "message", createdAt: "now" }],
      }),
      "references missing session",
    ],
    [
      "exhausted pending delivery",
      JSON.stringify({
        ...emptyState(),
        events: [{
          id: "event",
          channelId: "manual",
          sourceId: "source",
          dedupeKey: "manual:source",
          sessionKey: "session",
          receivedAt: "now",
        }],
        deliveries: [{
          id: "delivery",
          eventId: "event",
          channelId: "manual",
          clientId: "client",
          handlerId: "handler",
          status: "pending",
          phase: "sandbox",
          attempts: 1,
          maxAttempts: 1,
          retryDelayMs: 0,
          createdAt: "now",
          updatedAt: "now",
        }],
      }),
      "has no retry attempts remaining",
    ],
    [
      "duplicate event dedupe identity",
      JSON.stringify({
        ...emptyState(),
        events: ["first", "second"].map((id) => ({
          id,
          channelId: "manual",
          sourceId: id,
          dedupeKey: "manual:same",
          sessionKey: id,
          receivedAt: "now",
        })),
      }),
      "duplicates a channelId and dedupeKey identity",
    ],
    [
      "duplicate delivery route identity",
      JSON.stringify({
        ...emptyState(),
        events: [{
          id: "event",
          channelId: "manual",
          sourceId: "source",
          dedupeKey: "manual:source",
          sessionKey: "session",
          receivedAt: "now",
        }],
        deliveries: ["first", "second"].map((id) => ({
          id,
          eventId: "event",
          channelId: "manual",
          clientId: "client",
          handlerId: "handler",
          status: "pending",
          phase: "sandbox",
          attempts: 0,
          maxAttempts: 1,
          retryDelayMs: 0,
          createdAt: "now",
          updatedAt: "now",
        })),
      }),
      "duplicates an eventId, clientId, and handlerId identity",
    ],
    [
      "mismatched delivery session",
      JSON.stringify({
        ...emptyState(),
        sessions: [{ id: "session", key: "other", status: "active", state: {}, createdAt: "now", updatedAt: "now" }],
        events: [{
          id: "event",
          channelId: "manual",
          sourceId: "source",
          dedupeKey: "manual:source",
          sessionKey: "expected",
          receivedAt: "now",
        }],
        deliveries: [{
          id: "delivery",
          eventId: "event",
          channelId: "manual",
          clientId: "client",
          handlerId: "handler",
          status: "pending",
          phase: "sandbox",
          attempts: 0,
          maxAttempts: 1,
          retryDelayMs: 0,
          createdAt: "now",
          updatedAt: "now",
          sessionId: "session",
        }],
      }),
      "does not match its event sessionKey",
    ],
    [
      "unknown nested field",
      JSON.stringify({
        ...emptyState(),
        sessions: [{ id: "session", key: "key", status: "active", state: {}, createdAt: "now", updatedAt: "now", extra: true }],
      }),
      "state.sessions[0].extra is not recognized",
    ],
  ])("rejects %s with an actionable error and preserves the file", async (_name, raw, message) => {
    const root = await mkdtemp(join(tmpdir(), "sao-store-"));
    const path = join(root, "state.json");
    await writeFile(path, raw, "utf8");

    const error = await jsonFileStore(path).read().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StateValidationError);
    expect(String(error)).toContain(path);
    expect(String(error)).toContain(message);
    expect(String(error)).toContain("not modified");
    expect(await readFile(path, "utf8")).toBe(raw);
  });

  it("validates JSON-safe values before replacing existing state", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-store-"));
    const path = join(root, "state.json");
    const store = jsonFileStore(path);
    await store.init();
    const original = await readFile(path, "utf8");
    const invalid = emptyState();
    invalid.cursors.poll = { value: Number.NaN };

    await expect(store.write(invalid)).rejects.toThrow("state.cursors.poll.value must be JSON-safe");
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("rejects excessive JSON nesting on reads and writes without replacing state", async () => {
    const root = await mkdtemp(join(tmpdir(), "sao-store-"));
    const path = join(root, "state.json");
    let nested: unknown = "value";
    for (let depth = 0; depth < 102; depth += 1) nested = { nested };
    const invalid = emptyState();
    invalid.cursors.poll = { nested };
    const invalidRaw = JSON.stringify(invalid);
    await writeFile(path, invalidRaw, "utf8");

    await expect(jsonFileStore(path).read()).rejects.toThrow("maximum JSON nesting depth of 100");
    expect(await readFile(path, "utf8")).toBe(invalidRaw);

    const original = JSON.stringify(emptyState(), null, 2);
    await writeFile(path, original, "utf8");
    await expect(jsonFileStore(path).write(invalid)).rejects.toThrow("maximum JSON nesting depth of 100");
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it.each([
    ["sparse arrays", () => {
      const value: unknown[] = [];
      value.length = 1;
      return value;
    }],
    ["array properties", () => Object.assign([1], { extra: true })],
    ["custom array serialization", () => Object.assign([1], { toJSON: () => "changed" })],
  ])("rejects %s before JSON serialization changes them", async (_name, createValue) => {
    const root = await mkdtemp(join(tmpdir(), "sao-store-"));
    const path = join(root, "state.json");
    const store = jsonFileStore(path);
    await store.init();
    const original = await readFile(path, "utf8");
    const invalid = emptyState();
    invalid.cursors.poll = { value: createValue() };

    await expect(store.write(invalid)).rejects.toThrow(/JSON array/);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it.each([
    ["sparse collections", () => {
      const value = [] as ReturnType<typeof emptyState>["sessions"];
      value.length = 1;
      return value;
    }],
    [
      "custom collection serialization",
      () => Object.assign([] as ReturnType<typeof emptyState>["sessions"], { toJSON: () => [] }),
    ],
  ])("rejects %s before replacing state", async (_name, createSessions) => {
    const root = await mkdtemp(join(tmpdir(), "sao-store-"));
    const path = join(root, "state.json");
    const store = jsonFileStore(path);
    await store.init();
    const original = await readFile(path, "utf8");
    const invalid = emptyState();
    invalid.sessions = createSessions();

    await expect(store.write(invalid)).rejects.toThrow(/JSON array/);
    expect(await readFile(path, "utf8")).toBe(original);
  });
});
