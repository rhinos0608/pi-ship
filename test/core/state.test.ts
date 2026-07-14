import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadState, saveState, statePath } from "../../src/core/state.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pi-ship-state-"));
});

describe("loadState", () => {
  it("returns default when state missing", async () => {
    const s = await loadState(tmp);
    expect(s.version).toBe(1);
    expect(s.provider).toBe("railway");
    expect(s.serviceIds).toEqual({});
    expect(s.history).toEqual([]);
  });

  it("round-trips values", async () => {
    const state = {
      version: 1 as const,
      provider: "railway" as const,
      projectId: "proj-123",
      serviceIds: { app: "svc-1", postgres: "svc-2" },
      lastRelease: { id: "rel-1", digest: "abc", url: "https://x.railway.app", at: new Date().toISOString() },
      history: [{ planId: "p1", digest: "abc", at: new Date().toISOString(), status: "ok" }],
    };
    await saveState(tmp, state);
    const loaded = await loadState(tmp);
    expect(loaded).toEqual(state);
  });

  it("atomic write does not leave partial state", async () => {
    await saveState(tmp, { version: 1, provider: "railway", serviceIds: { app: "svc" }, history: [] });
    const content = await readFile(statePath(tmp), "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.serviceIds.app).toBe("svc");
  });

  it("rejects malformed JSON", async () => {
    await mkdir(join(tmp, ".pi-ship"), { recursive: true });
    await writeFile(statePath(tmp), "{bad");
    await expect(loadState(tmp)).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });
});
