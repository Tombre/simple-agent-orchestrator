import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jsonFileStore, memoryStore } from "../src/index.js";
import { emptyState } from "../src/stores/store.js";

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

    await expect(store.read()).rejects.toBeInstanceOf(SyntaxError);
    expect(await readFile(path, "utf8")).toBe("not json");
  });
});
