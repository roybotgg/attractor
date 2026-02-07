import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore, FILE_BACKING_THRESHOLD } from "../../src/types/index.js";

function makeSmallData(): string {
  return "small artifact data";
}

function makeLargeData(): string {
  return "x".repeat(FILE_BACKING_THRESHOLD + 1);
}

describe("ArtifactStore file backing", () => {
  test("small artifact stays in memory (isFileBacked: false)", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "artifact-test-"));
    const store = new ArtifactStore({ baseDir });
    const info = await store.store("small-1", "small artifact", makeSmallData());

    expect(info.isFileBacked).toBe(false);
    expect(existsSync(join(baseDir, "artifacts", "small-1.json"))).toBe(false);

    const retrieved = await store.retrieve("small-1");
    expect(retrieved).toBe(makeSmallData());
  });

  test("large artifact writes to disk (isFileBacked: true)", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "artifact-test-"));
    const store = new ArtifactStore({ baseDir });
    const info = await store.store("large-1", "large artifact", makeLargeData());

    expect(info.isFileBacked).toBe(true);
    expect(info.sizeBytes).toBeGreaterThan(FILE_BACKING_THRESHOLD);
    expect(existsSync(join(baseDir, "artifacts", "large-1.json"))).toBe(true);
  });

  test("retrieve reads from disk for file-backed artifact", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "artifact-test-"));
    const store = new ArtifactStore({ baseDir });
    const data = makeLargeData();
    await store.store("large-2", "large artifact", data);

    const retrieved = await store.retrieve("large-2");
    expect(retrieved).toBe(data);
  });

  test("remove deletes file for file-backed artifact", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "artifact-test-"));
    const store = new ArtifactStore({ baseDir });
    await store.store("large-3", "large artifact", makeLargeData());

    const filePath = join(baseDir, "artifacts", "large-3.json");
    expect(existsSync(filePath)).toBe(true);

    store.remove("large-3");
    expect(existsSync(filePath)).toBe(false);
    expect(store.has("large-3")).toBe(false);
  });

  test("clear deletes all file-backed artifacts", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "artifact-test-"));
    const store = new ArtifactStore({ baseDir });
    await store.store("large-4", "large artifact 1", makeLargeData());
    await store.store("large-5", "large artifact 2", makeLargeData());

    const file4 = join(baseDir, "artifacts", "large-4.json");
    const file5 = join(baseDir, "artifacts", "large-5.json");
    expect(existsSync(file4)).toBe(true);
    expect(existsSync(file5)).toBe(true);

    store.clear();
    expect(existsSync(file4)).toBe(false);
    expect(existsSync(file5)).toBe(false);
    expect(store.list()).toEqual([]);
  });

  test("no file backing when baseDir not set", async () => {
    const store = new ArtifactStore();
    const info = await store.store("large-6", "large artifact", makeLargeData());

    expect(info.isFileBacked).toBe(false);
    const retrieved = await store.retrieve("large-6");
    expect(retrieved).toBe(makeLargeData());
  });
});
