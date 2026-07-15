import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { describe, expect, it } from "vitest";
import { canonicalize, computeEntryHash, createOperationJournal, validateHashChain } from "../../src/deployment/operation-journal.js";

// ── Canonicalization ────────────────────────────────────────────────────────

describe("generic operation journal canonicalize", () => {
  it("sorts keys deterministically", () => {
    expect(canonicalize({ b: 2, a: 1, c: 3 })).toBe('{"a":1,"b":2,"c":3}');
  });

  it("sorts nested keys", () => {
    expect(canonicalize({ z: { n: 1, m: 2 }, a: 0 })).toBe('{"a":0,"z":{"m":2,"n":1}}');
  });

  it("handles arrays without sorting", () => {
    expect(canonicalize({ items: ["z", "a", "m"] })).toBe('{"items":["z","a","m"]}');
  });

  it("produces identical output for same input", () => {
    const a = canonicalize({ foo: "bar", num: 42 });
    const b = canonicalize({ num: 42, foo: "bar" });
    expect(a).toBe(b);
  });
});

// ── Entry hash ──────────────────────────────────────────────────────────────

describe("generic operation journal computeEntryHash", () => {
  it("produces deterministic hash", () => {
    const entry = { planId: "p", operationId: "o", attempt: 1, status: "start" };
    const h1 = computeEntryHash(entry);
    const h2 = computeEntryHash({ ...entry, attempt: 1 }); // same content
    expect(h1).toBe(h2);
  });

  it("different content produces different hash", () => {
    const h1 = computeEntryHash({ planId: "a", status: "start" });
    const h2 = computeEntryHash({ planId: "b", status: "start" });
    expect(h1).not.toBe(h2);
  });
});

// ── Chain validation ────────────────────────────────────────────────────────

describe("generic operation journal validateHashChain", () => {
  it("validates a correct chain", () => {
    const raw1 = { previousHash: null as string | null };
    const e1 = { ...raw1, entryHash: computeEntryHash(raw1) };
    const raw2 = { previousHash: e1.entryHash };
    const e2 = { ...raw2, entryHash: computeEntryHash(raw2) };
    expect(() => validateHashChain([e1, e2])).not.toThrow();
  });

  it("detects broken previousHash link", () => {
    const raw1 = { previousHash: null as string | null };
    const e1 = { ...raw1, entryHash: computeEntryHash(raw1) };
    const raw2 = { previousHash: "garbage" };
    const e2 = { ...raw2, entryHash: computeEntryHash(raw2) };
    expect(() => validateHashChain([e1, e2])).toThrow("hash chain broken");
  });

  it("detects entry hash mismatch after tampering", () => {
    const raw = { previousHash: null as string | null };
    const entry = { ...raw, entryHash: computeEntryHash(raw) };
    // Tamper content (planId) without updating entryHash
    const tampered = { ...entry, planId: "tampered" };
    expect(() => validateHashChain([tampered])).toThrow("hash mismatch");
  });
});

// ── createOperationJournal factory ──────────────────────────────────────────

describe("generic operation journal createOperationJournal", () => {
  const Schema = Type.Object({
    planId: Type.String({ minLength: 1 }),
    operationId: Type.String({ minLength: 1 }),
    attempt: Type.Integer({ minimum: 1 }),
    status: Type.String({ minLength: 1 }),
    previousHash: Type.Union([Type.String(), Type.Null()]),
    entryHash: Type.String({ minLength: 1 }),
  }, { additionalProperties: false });

  function journalPath(cwd: string) {
    return join(cwd, ".pi-ship", "test-ops.jsonl");
  }

  it("returns empty array when file missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-ops-"));
    const journal = createOperationJournal<Static<typeof Schema>>(Schema, journalPath);
    await expect(journal.read(cwd)).resolves.toEqual([]);
  });

  it("appends and reads entries", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-ops-"));
    const journal = createOperationJournal<Static<typeof Schema>>(Schema, journalPath);
    const entry = await journal.append(cwd, { planId: "p1", operationId: "o1", attempt: 1, status: "start" });
    expect(entry.entryHash).toBeDefined();
    expect(entry.previousHash).toBeNull();
    const all = await journal.read(cwd);
    expect(all).toHaveLength(1);
    expect(all[0].planId).toBe("p1");
  });

  it("rejects entry missing required field", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-ops-"));
    const journal = createOperationJournal<Static<typeof Schema>>(Schema, journalPath);
    await expect(journal.append(cwd, { planId: "p1", operationId: "o1", attempt: 0, status: "start" } as never)).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rejects entry with extra field", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-ops-"));
    const journal = createOperationJournal<Static<typeof Schema>>(Schema, journalPath);
    await expect(journal.append(cwd, { planId: "p1", operationId: "o1", attempt: 1, status: "start", extra: true } as never)).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("validates chain on every read", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-ops-"));
    const journal = createOperationJournal<Static<typeof Schema>>(Schema, journalPath);
    await journal.append(cwd, { planId: "p1", operationId: "o1", attempt: 1, status: "start" });
    await journal.append(cwd, { planId: "p2", operationId: "o2", attempt: 1, status: "start" });
    // Tamper first entry
    const path = journalPath(cwd);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    first.planId = "tampered";
    lines[0] = JSON.stringify(first);
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
    await expect(journal.read(cwd)).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("validates chain before filter", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-ops-"));
    const journal = createOperationJournal<Static<typeof Schema>>(Schema, journalPath);
    await journal.append(cwd, { planId: "p1", operationId: "o1", attempt: 1, status: "start" });
    await journal.append(cwd, { planId: "p2", operationId: "o2", attempt: 1, status: "start" });
    // Tamper first entry
    const path = journalPath(cwd);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    first.planId = "tampered";
    lines[0] = JSON.stringify(first);
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
    await expect(journal.read(cwd, { planId: "p2" })).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("filters by planId", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-ops-"));
    const journal = createOperationJournal<Static<typeof Schema>>(Schema, journalPath);
    await journal.append(cwd, { planId: "p1", operationId: "o1", attempt: 1, status: "start" });
    await journal.append(cwd, { planId: "p2", operationId: "o2", attempt: 1, status: "start" });
    const filtered = await journal.read(cwd, { planId: "p1" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].planId).toBe("p1");
  });

  it("different planDigest produces different hash", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-ops-"));
    const journal = createOperationJournal<Static<typeof Schema>>(Schema, journalPath);
    const e1 = await journal.append(cwd, { planId: "p1", operationId: "o1", attempt: 1, status: "start" });
    expect(e1.entryHash).toBeDefined();
    // Append with different planId produces different chain
    const e2 = await journal.append(cwd, { planId: "p2", operationId: "o2", attempt: 1, status: "start" });
    expect(e2.entryHash).not.toBe(e1.entryHash);
  });
});
