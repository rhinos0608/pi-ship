import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { resetLocalDatabase } from "../../src/database/reset.js";
import * as instanceCache from "../../src/database/local/instance-cache.js";

describe("resetLocalDatabase", () => {
  // Integration-like: uses real filesystem with a mock PGlite
  it("deletes the datadir and re-initializes instance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-ship-reset-"));
    try {
      // Create some content in the datadir
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "test-file"), "content");

      // Mock instance cache to avoid real PGlite
      vi.spyOn(instanceCache, "resetPGliteInstance").mockImplementation(async (dataDir: string) => {
        await rm(dataDir, { recursive: true, force: true });
      });
      vi.spyOn(instanceCache, "getPGliteInstance").mockResolvedValue({} as any);

      await resetLocalDatabase(dir);

      // Verify reset was called
      expect(instanceCache.resetPGliteInstance).toHaveBeenCalledWith(dir);
      expect(instanceCache.getPGliteInstance).toHaveBeenCalledWith(dir);
    } finally {
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws E_PROVIDER when re-initialization fails", async () => {
    vi.spyOn(instanceCache, "resetPGliteInstance").mockResolvedValue(undefined);
    vi.spyOn(instanceCache, "getPGliteInstance").mockRejectedValue(new Error("PGlite boom"));

    await expect(resetLocalDatabase("/nonexistent/path")).rejects.toMatchObject({
      code: "E_PROVIDER",
    });

    vi.restoreAllMocks();
  });

  it("throws E_PROVIDER when reset itself fails", async () => {
    const origErr = new Error("disk full");
    vi.spyOn(instanceCache, "resetPGliteInstance").mockRejectedValue(origErr);

    let thrown: unknown;
    try {
      await resetLocalDatabase("/nonexistent/path");
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toMatchObject({
      code: "E_PROVIDER",
    });
    // Original error is preserved as cause
    expect((thrown as Error).cause).toBe(origErr);

    vi.restoreAllMocks();
  });

  it("resetPGliteInstance handles missing directory gracefully", async () => {
    vi.spyOn(instanceCache, "resetPGliteInstance").mockImplementation(async (dir: string) => {
      await rm(dir, { recursive: true, force: true }); // force+recursive handles missing
    });
    vi.spyOn(instanceCache, "getPGliteInstance").mockResolvedValue({} as any);

    await expect(resetLocalDatabase("/nonexistent/path/for/reset")).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });
});
