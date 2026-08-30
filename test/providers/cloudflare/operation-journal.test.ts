import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendOperationEntry,
  computeEntryHash,
  operationJournalPath,
  readOperationJournal,
  type OperationJournalEntry,
} from "../../../src/providers/cloudflare/operation-journal.js";

describe("Cloudflare operation journal", () => {
  const base = {
    version: 1 as const,
    ts: "2026-01-01T00:00:00.000Z",
    planId: "plan-1",
    planDigest: "digest-abc",
    provider: "cloudflare" as const,
    operationId: "op-1",
    kind: "deploy" as const,
    targetFingerprint: "tf-1",
    requestFingerprint: "rf-1",
    expectedStateFingerprint: "esf-1",
    attempt: 1,
    status: "start" as const,
  };

  it("round-trips a start entry", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-cf-journal-"));
    const entry = await appendOperationEntry(cwd, base);
    expect(entry.entryHash).toBeDefined();
    expect(entry.previousHash).toBeNull();
    expect(entry.planId).toBe("plan-1");

    const loaded = await readOperationJournal(cwd);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].entryHash).toBe(entry.entryHash);
    expect(loaded[0].previousHash).toBeNull();
  });

  it("round-trips multiple entries with hash chain", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-cf-journal-"));
    const e1 = await appendOperationEntry(cwd, base);
    const e2 = await appendOperationEntry(cwd, { ...base, operationId: "op-2" });
    const e3 = await appendOperationEntry(cwd, { ...base, operationId: "op-3" });

    expect(e2.previousHash).toBe(e1.entryHash);
    expect(e3.previousHash).toBe(e2.entryHash);

    const loaded = await readOperationJournal(cwd);
    expect(loaded).toHaveLength(3);
  });

  it("accepts every journal entry variant", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-cf-journal-"));
    const variants = [
      { status: "start" as const },
      { status: "ok" as const, resourceRef: "release-1", observedStateFingerprint: "osf-1" },
      { status: "fail" as const, error: { code: "E_PROVIDER", message: "failed", retryable: false } },
      { status: "ambiguous" as const, reason: "transport" as const, safeMessage: "unknown error" },
      { status: "reconciled" as const, outcome: "matches_expected" as const, resourceRef: "release-1", observedStateFingerprint: "osf-1" },
      { status: "reconciled" as const, outcome: "not_applied" as const, observedStateFingerprint: "absent" },
      { status: "reconciled" as const, outcome: "conflict" as const, observedStateFingerprint: "other" },
      { status: "reconciled" as const, outcome: "unverified" as const, reason: "rate_limited" as const, safeMessage: "try later" },
    ];

    for (let i = 0; i < variants.length; i++) {
      await appendOperationEntry(cwd, {
        ...base,
        operationId: `op-${i}`,
        ...variants[i],
      } as never);
    }

    const loaded = await readOperationJournal(cwd);
    expect(loaded).toHaveLength(variants.length);
  });

  it("rejects unknown fields", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-cf-journal-"));
    await expect(
      appendOperationEntry(cwd, { ...base, extra: true } as never)
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rejects invalid attempt (zero)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-cf-journal-"));
    await expect(
      appendOperationEntry(cwd, { ...base, attempt: 0 })
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("hash chain validation detects tampering with entry content", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-cf-journal-"));
    await appendOperationEntry(cwd, { ...base, planId: "p1", operationId: "o1" });
    await appendOperationEntry(cwd, { ...base, planId: "p2", operationId: "o2" });

    const path = operationJournalPath(cwd);
    const content = await readFile(path, "utf8");
    const lines = content.trim().split("\n");
    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    first.planDigest = "tampered";
    lines[0] = JSON.stringify(first);
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");

    await expect(readOperationJournal(cwd)).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("chain validation detects previousHash tampering", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-cf-journal-"));
    await appendOperationEntry(cwd, { ...base, planId: "p1", operationId: "o1" });
    await appendOperationEntry(cwd, { ...base, planId: "p2", operationId: "o2" });

    const path = operationJournalPath(cwd);
    const content = await readFile(path, "utf8");
    const lines = content.trim().split("\n");
    const second = JSON.parse(lines[1]) as Record<string, unknown>;
    second.previousHash = "badhash";
    lines[1] = JSON.stringify(second);
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");

    await expect(readOperationJournal(cwd)).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("different planDigest produces different entry hash", async () => {
    const baseEntry: Omit<OperationJournalEntry, "entryHash" | "previousHash"> = {
      ...base, previousHash: null,
    } as unknown as Omit<OperationJournalEntry, "entryHash" | "previousHash">;

    const hashA = computeEntryHash({ ...baseEntry, planDigest: "a" });
    const hashB = computeEntryHash({ ...baseEntry, planDigest: "b" });
    expect(hashA).not.toBe(hashB);
  });

  it("filters by planId", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-cf-journal-"));
    await appendOperationEntry(cwd, { ...base, planId: "plan-a", operationId: "o1" });
    await appendOperationEntry(cwd, { ...base, planId: "plan-b", operationId: "o2" });
    await appendOperationEntry(cwd, { ...base, planId: "plan-a", operationId: "o3" });

    const filtered = await readOperationJournal(cwd, { planId: "plan-a" });
    expect(filtered).toHaveLength(2);
    expect(filtered[0].planId).toBe("plan-a");
    expect(filtered[1].planId).toBe("plan-a");
  });
});

// ── Legacy path migration tests ─────────────────────────────────────────────
describe("Cloudflare legacy path migration", () => {
  const LEGACY_PATH = ".pi-ship/operation-journal.jsonl";

  function makeCloudflareEntry(
    overrides: Record<string, unknown> & { operationId: string; planId: string },
    previousHash: string | null,
  ): Record<string, unknown> {
    const base = {
      version: 1, ts: "2026-01-01T00:00:00.000Z", planDigest: "d1",
      provider: "cloudflare", kind: "deploy",
      targetFingerprint: "tf1", requestFingerprint: "rf1",
      expectedStateFingerprint: "esf1", attempt: 1, status: "start",
      ...overrides, previousHash,
    };
    const entryHash = computeEntryHash(base);
    return { ...base, entryHash };
  }

  function makeVercelEntry(
    overrides: Record<string, unknown> & { operationId: string; planId: string },
    previousHash: string | null,
  ): Record<string, unknown> {
    const base = {
      version: 2, ts: "2026-01-01T00:00:00.000Z", planDigest: "d2",
      provider: "vercel", domain: "app", kind: "deploy",
      targetFingerprint: "vt1", requestFingerprint: "vr1",
      expectedStateFingerprint: "vesf1", attempt: 1, status: "start",
      ...overrides, previousHash,
    };
    const entryHash = computeEntryHash(base);
    return { ...base, entryHash };
  }

  it("reads entries from legacy shared path when new provider-specific path does not exist", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-cf-legacy-"));
    await mkdir(join(cwd, ".pi-ship"), { recursive: true });

    const entry1 = makeCloudflareEntry({ planId: "p1", operationId: "o1" }, null);

    // Write ONLY to legacy path — no new cloudflare-operation-journal.jsonl
    await writeFile(join(cwd, LEGACY_PATH), JSON.stringify(entry1) + "\n", "utf8");

    const entries = await readOperationJournal(cwd);
    expect(entries).toHaveLength(1);
    expect(entries[0].planId).toBe("p1");
    expect(entries[0].operationId).toBe("o1");
  });

  it("filters own entries from mixed-provider legacy file (Cloudflare + Vercel interleaved)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-cf-mixed-"));
    await mkdir(join(cwd, ".pi-ship"), { recursive: true });

    // Entry 1: Cloudflare
    const cf1 = makeCloudflareEntry({ planId: "cf-p1", operationId: "cf-o1" }, null);
    // Entry 2: Vercel (interleaved — chain valid across providers)
    const vc1 = makeVercelEntry({ planId: "vc-p1", operationId: "vc-o1" }, cf1.entryHash as string);
    // Entry 3: Cloudflare
    const cf2 = makeCloudflareEntry({ planId: "cf-p2", operationId: "cf-o2" }, vc1.entryHash as string);

    await writeFile(
      join(cwd, LEGACY_PATH),
      [JSON.stringify(cf1), JSON.stringify(vc1), JSON.stringify(cf2)].join("\n") + "\n",
      "utf8"
    );

    const entries = await readOperationJournal(cwd);
    // Cloudflare reader validates full chain, then filters by Cloudflare schema only
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.provider === "cloudflare")).toBe(true);
    expect(entries.map((e) => e.planId)).toEqual(["cf-p1", "cf-p2"]);
  });

  it("returns empty array for fresh install (no legacy or new-path file)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-cf-fresh-"));
    await expect(readOperationJournal(cwd)).resolves.toEqual([]);
  });
});
