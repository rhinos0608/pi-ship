import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultNeonState,
  isNeonState,
  loadNeonState,
  saveNeonState,
  redactConnectionUri,
} from "../../../src/providers/neon/state.js";
import { statePath } from "../../../src/persistence/state-store.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pi-ship-neon-state-"));
});

describe("defaultNeonState", () => {
  it("has correct shape", () => {
    const s = defaultNeonState();
    expect(s.version).toBe(1);
    expect(s.provider).toBe("neon");
    expect(s.projectId).toBeUndefined();
    expect(s.projectName).toBeUndefined();
    expect(s.branchIds).toEqual({});
    expect(s.connectionUris).toEqual({});
    expect(s.history).toEqual([]);
  });
});

describe("isNeonState", () => {
  it("validates correct state", () => {
    expect(isNeonState(defaultNeonState())).toBe(true);
  });

  it("rejects null", () => {
    expect(isNeonState(null)).toBe(false);
  });

  it("rejects wrong provider", () => {
    expect(isNeonState({ ...defaultNeonState(), provider: "railway" })).toBe(false);
  });

  it("rejects wrong version", () => {
    expect(isNeonState({ ...defaultNeonState(), version: 2 })).toBe(false);
  });

  it("rejects extra fields", () => {
    expect(isNeonState({ ...defaultNeonState(), extra: true })).toBe(false);
  });

  it("accepts state with optional fields", () => {
    const s = {
      ...defaultNeonState(),
      projectId: "proj-123",
      projectName: "my-project",
      branchIds: { main: "branch-1" },
      connectionUris: { main: "postgresql://user:[REDACTED]@host:5432/db" },
      history: [{ planId: "p1", digest: "abc", at: new Date().toISOString(), status: "ok" }],
    };
    expect(isNeonState(s)).toBe(true);
  });

  it("rejects invalid history entry", () => {
    const s = { ...defaultNeonState(), history: [{ planId: "p1" }] };
    expect(isNeonState(s)).toBe(false);
  });
});

describe("redactConnectionUri", () => {
  it("replaces password with [REDACTED]", () => {
    const uri = "postgresql://user:secret123@ep-restless-forest-123456.us-east-2.aws.neon.tech/neondb";
    expect(redactConnectionUri(uri)).toBe(
      "postgresql://user:[REDACTED]@ep-restless-forest-123456.us-east-2.aws.neon.tech/neondb",
    );
  });

  it("returns original URI when no password", () => {
    const uri = "postgresql://user@host:5432/db";
    expect(redactConnectionUri(uri)).toBe(uri);
  });

  it("returns [REDACTED] when URI has no @", () => {
    expect(redactConnectionUri("not-a-uri")).toBe("[REDACTED]");
  });

  it("returns [REDACTED] when URI has no ://", () => {
    expect(redactConnectionUri("user:pass@host:5432/db")).toBe("[REDACTED]");
  });

  it("handles empty string", () => {
    expect(redactConnectionUri("")).toBe("[REDACTED]");
  });
});

describe("loadNeonState", () => {
  it("returns default when state file missing", async () => {
    const s = await loadNeonState(tmp);
    expect(s).toEqual(defaultNeonState());
  });

  it("round-trips state", async () => {
    const state = {
      ...defaultNeonState(),
      projectId: "proj-1",
      projectName: "my-project",
      branchIds: { main: "br-1" },
      connectionUris: { main: "postgresql://user:[REDACTED]@host/db" },
      history: [{ planId: "p1", digest: "abc", at: new Date().toISOString(), status: "ok" }],
    };
    await saveNeonState(tmp, state);
    const loaded = await loadNeonState(tmp);
    expect(loaded).toEqual(state);
  });

  it("rejects malformed JSON", async () => {
    await mkdir(join(tmp, ".pi-ship"), { recursive: true });
    await writeFile(statePath(tmp), "{bad");
    await expect(loadNeonState(tmp)).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });
});

describe("saveNeonState", () => {
  it("saves state atomically", async () => {
    await saveNeonState(tmp, defaultNeonState());
    const content = await readFile(statePath(tmp), "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.provider).toBe("neon");
    expect(parsed.version).toBe(1);
  });

  it("rejects invalid state shape", async () => {
    await expect(saveNeonState(tmp, { invalid: true } as never)).rejects.toMatchObject({
      code: "E_CONFIG_INVALID",
    });
  });

  it("rejects when existing state has invalid shape", async () => {
    await mkdir(join(tmp, ".pi-ship"), { recursive: true });
    await writeFile(statePath(tmp), '{"bad": true}');
    await expect(saveNeonState(tmp, defaultNeonState())).rejects.toMatchObject({
      code: "E_CONFIG_INVALID",
    });
  });
});
