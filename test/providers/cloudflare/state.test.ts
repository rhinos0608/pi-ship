import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultCloudflareState,
  isCloudflareState,
  loadCloudflareState,
  saveCloudflareState,
} from "../../../src/providers/cloudflare/state.js";
import { statePath } from "../../../src/persistence/state-store.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pi-ship-cf-state-"));
});

describe("defaultCloudflareState", () => {
  it("has correct shape", () => {
    const state = defaultCloudflareState();
    expect(state.provider).toBe("cloudflare");
    expect(state.version).toBe(1);
    expect(state.deployments).toEqual([]);
    expect(state.history).toEqual([]);
    expect(state.accountId).toBeUndefined();
    expect(state.worker).toBeUndefined();
  });
});

describe("isCloudflareState", () => {
  it("validates correct state", () => {
    expect(isCloudflareState(defaultCloudflareState())).toBe(true);
  });

  it("validates full state with all fields", () => {
    const state = {
      provider: "cloudflare" as const,
      version: 1 as const,
      accountId: "acc-123",
      worker: { name: "my-worker", etag: "abc123" },
      deployments: [
        { id: "d1", versionId: "v1", planId: "p1", digest: "abc", at: new Date().toISOString() },
      ],
      history: [
        { planId: "p1", digest: "abc", status: "ok" as const, at: new Date().toISOString() },
      ],
    };
    expect(isCloudflareState(state)).toBe(true);
  });

  it("rejects wrong provider", () => {
    expect(isCloudflareState({ ...defaultCloudflareState(), provider: "railway" })).toBe(false);
  });

  it("rejects missing deployments field", () => {
    const { deployments: _, ...rest } = defaultCloudflareState();
    expect(isCloudflareState(rest)).toBe(false);
  });

  it("rejects missing history field", () => {
    const { history: _, ...rest } = defaultCloudflareState();
    expect(isCloudflareState(rest)).toBe(false);
  });

  it("rejects extra fields", () => {
    expect(isCloudflareState({ ...defaultCloudflareState(), extra: true })).toBe(false);
  });

  it("rejects wrong version", () => {
    expect(isCloudflareState({ ...defaultCloudflareState(), version: 2 })).toBe(false);
  });

  it("rejects invalid deployment entry", () => {
    expect(isCloudflareState({
      ...defaultCloudflareState(),
      deployments: [{ id: "d1" }], // missing required fields
    })).toBe(false);
  });

  it("rejects invalid history entry", () => {
    expect(isCloudflareState({
      ...defaultCloudflareState(),
      history: [{ planId: "p1" }], // missing required fields
    })).toBe(false);
  });

  it("rejects non-string worker name", () => {
    expect(isCloudflareState({
      ...defaultCloudflareState(),
      worker: { name: 123 },
    })).toBe(false);
  });
});

describe("loadCloudflareState", () => {
  it("returns default when state file is absent", async () => {
    const state = await loadCloudflareState(tmp);
    expect(state).toEqual(defaultCloudflareState());
  });

  it("loads existing valid state", async () => {
    const saved = {
      provider: "cloudflare" as const,
      version: 1 as const,
      accountId: "acc-123",
      worker: { name: "my-worker", etag: "etag-1" },
      deployments: [
        { id: "d1", versionId: "v1", planId: "p1", digest: "abc", at: new Date().toISOString() },
      ],
      history: [
        { planId: "p1", digest: "abc", status: "ok" as const, at: new Date().toISOString() },
      ],
    };
    await saveCloudflareState(tmp, saved);
    const loaded = await loadCloudflareState(tmp);
    expect(loaded).toEqual(saved);
  });

  it("rejects malformed JSON", async () => {
    await mkdir(join(tmp, ".pi-ship"), { recursive: true });
    await writeFile(statePath(tmp), "{bad");
    await expect(loadCloudflareState(tmp)).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rejects state with wrong provider", async () => {
    await mkdir(join(tmp, ".pi-ship"), { recursive: true });
    await writeFile(statePath(tmp), JSON.stringify({ provider: "railway", version: 1, deployments: [], history: [] }));
    await expect(loadCloudflareState(tmp)).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });
});

describe("saveCloudflareState", () => {
  it("round-trips values", async () => {
    const state = {
      provider: "cloudflare" as const,
      version: 1 as const,
      accountId: "acc-123",
      worker: { name: "my-worker" },
      deployments: [
        { id: "d1", versionId: "v1", planId: "p1", digest: "abc", at: new Date().toISOString() },
      ],
      history: [
        { planId: "p1", digest: "abc", status: "ok" as const, at: new Date().toISOString() },
      ],
    };
    await saveCloudflareState(tmp, state);
    const loaded = await loadCloudflareState(tmp);
    expect(loaded).toEqual(state);
  });

  it("rejects invalid state", async () => {
    await expect(saveCloudflareState(tmp, { provider: "cloudflare", version: 1 } as never))
      .rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rejects extra fields", async () => {
    await expect(saveCloudflareState(tmp, { ...defaultCloudflareState(), extra: true } as never))
      .rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("atomic write persists correctly", async () => {
    const state = {
      provider: "cloudflare" as const,
      version: 1 as const,
      deployments: [{ id: "d1", versionId: "v1", planId: "p1", digest: "abc", at: new Date().toISOString() }],
      history: [],
    };
    await saveCloudflareState(tmp, state);
    const content = await readFile(statePath(tmp), "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.deployments).toHaveLength(1);
    expect(parsed.deployments[0].id).toBe("d1");
  });

  it("failed atomic write preserves previous valid state", async () => {
    const original = {
      provider: "cloudflare" as const,
      version: 1 as const,
      deployments: [{ id: "orig-d", versionId: "v1", planId: "p1", digest: "abc", at: new Date().toISOString() }],
      history: [],
    };
    await saveCloudflareState(tmp, original);

    // Read back to confirm original was saved
    const beforeContent = await readFile(statePath(tmp), "utf8");
    const before = JSON.parse(beforeContent);
    expect(before.deployments[0].id).toBe("orig-d");

    // Make statePath's parent dir non-writable so the next atomic write fails
    const { chmod } = await import("node:fs/promises");
    const stateDir = dirname(statePath(tmp));
    await chmod(stateDir, 0o444);
    try {
      // saveCloudflareState should throw because temp file write fails
      const badState = {
        provider: "cloudflare" as const,
        version: 1 as const,
        deployments: [{ id: "should-not-persist", versionId: "v2", planId: "p2", digest: "xyz", at: new Date().toISOString() }],
        history: [],
      };
      await expect(saveCloudflareState(tmp, badState)).rejects.toThrow();
    } finally {
      // Always restore permissions so cleanup can proceed
      await chmod(stateDir, 0o755);
    }

    // Verify original state is intact
    const survived = JSON.parse(await readFile(statePath(tmp), "utf8"));
    expect(survived.deployments).toHaveLength(1);
    expect(survived.deployments[0].id).toBe("orig-d");
  });
});
