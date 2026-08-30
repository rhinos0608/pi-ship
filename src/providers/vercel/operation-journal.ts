import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  createOperationJournal,
  computeEntryHash as genericComputeEntryHash,
  validateHashChain as genericValidateHashChain,
} from "../../deployment/operation-journal.js";

const Strict = { additionalProperties: false } as const;
const Base = {
  version: Type.Literal(2), ts: Type.String({ minLength: 1 }), planId: Type.String({ minLength: 1 }), planDigest: Type.String({ minLength: 1 }),
  provider: Type.Literal("vercel"), domain: Type.Literal("app"), operationId: Type.String({ minLength: 1 }),
  kind: Type.Union([Type.Literal("ensure_project"), Type.Literal("upsert_secrets"), Type.Literal("deploy"), Type.Literal("rollback")]),
  targetFingerprint: Type.String({ minLength: 1 }), requestFingerprint: Type.String({ minLength: 1 }), expectedStateFingerprint: Type.String({ minLength: 1 }),
  attempt: Type.Integer({ minimum: 1 }), previousHash: Type.Union([Type.String(), Type.Null()]), entryHash: Type.String({ minLength: 1 }),
};
const ErrorSchema = Type.Object({ code: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1 }), retryable: Type.Boolean() }, Strict);
const Reason = Type.Union([Type.Literal("transport"), Type.Literal("rate_limited"), Type.Literal("unauthorized"), Type.Literal("forbidden"), Type.Literal("malformed"), Type.Literal("missing_payload"), Type.Literal("conflict")]);
const ReleaseStatus = Type.Union([
  Type.Literal("queued"),
  Type.Literal("initializing"),
  Type.Literal("building"),
  Type.Literal("ready"),
  Type.Literal("error"),
  Type.Literal("canceled"),
  Type.Literal("blocked"),
]);
const ReleaseMetadata = {
  releaseStatus: Type.Optional(ReleaseStatus),
  releaseUrl: Type.Optional(Type.String({ minLength: 1 })),
};
export const OperationJournalEntrySchema = Type.Union([
  Type.Object({ ...Base, status: Type.Literal("start") }, Strict),
  Type.Object({ ...Base, status: Type.Literal("ok"), resourceRef: Type.String({ minLength: 1 }), observedStateFingerprint: Type.String({ minLength: 1 }), providerRequestId: Type.Optional(Type.String()), ...ReleaseMetadata }, Strict),
  Type.Object({ ...Base, status: Type.Literal("fail"), error: ErrorSchema }, Strict),
  Type.Object({ ...Base, status: Type.Literal("ambiguous"), reason: Reason, safeMessage: Type.String({ minLength: 1 }), resourceRef: Type.Optional(Type.String({ minLength: 1 })) }, Strict),
  Type.Object({ ...Base, status: Type.Literal("reconciled"), outcome: Type.Literal("matches_expected"), resourceRef: Type.String({ minLength: 1 }), observedStateFingerprint: Type.String({ minLength: 1 }), ...ReleaseMetadata }, Strict),
  Type.Object({ ...Base, status: Type.Literal("reconciled"), outcome: Type.Union([Type.Literal("not_applied"), Type.Literal("conflict")]), resourceRef: Type.Optional(Type.String({ minLength: 1 })), observedStateFingerprint: Type.String({ minLength: 1 }) }, Strict),
  Type.Object({ ...Base, status: Type.Literal("reconciled"), outcome: Type.Literal("unverified"), reason: Reason, safeMessage: Type.String({ minLength: 1 }) }, Strict),
]);
export type OperationJournalEntry = Static<typeof OperationJournalEntrySchema>;
type WithoutChain<T> = T extends unknown ? Omit<T, "entryHash" | "previousHash"> : never;
export type NewOperationJournalEntry = WithoutChain<OperationJournalEntry>;

/** Provider-specific journal path (new). */
function vcPath(cwd: string): string {
  return join(cwd, ".pi-ship", "vercel-operation-journal.jsonl");
}

/** Legacy shared path (also used by Cloudflare). */
function legacyPath(cwd: string): string {
  return join(cwd, ".pi-ship", "operation-journal.jsonl");
}

const vcJournal = createOperationJournal<OperationJournalEntry>(OperationJournalEntrySchema, vcPath);

export const operationJournalPath = vcJournal.path;
export const appendOperationEntry = vcJournal.append;

/**
 * Read Vercel journal entries from both the new provider-specific path and the
 * legacy shared path. Entries with matching entryHash are deduplicated.
 *
 * The legacy shared file may contain entries from another provider (Cloudflare).
 * Only entries with `provider: "vercel"` are adopted. The full legacy chain is
 * validated for integrity before filtering by provider.
 */
export async function readOperationJournal(cwd: string, filter?: { planId?: string }): Promise<OperationJournalEntry[]> {
  // 1. Read new provider-specific path (schema-validated, chain-validated)
  let newEntries: OperationJournalEntry[];
  try {
    newEntries = await vcJournal.read(cwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      newEntries = [];
    } else {
      throw error;
    }
  }

  // 2. Read legacy shared path, filter by provider
  let legacyEntries: OperationJournalEntry[] = [];
  try {
    const legacyRaw = await readFile(legacyPath(cwd), "utf8");
    const allParsed: unknown[] = [];
    const chainEntries: Array<{ entryHash: string; previousHash: string | null }> = [];
    for (const line of legacyRaw.split("\n")) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      allParsed.push(parsed);
      chainEntries.push(parsed as { entryHash: string; previousHash: string | null });
    }
    // Validate hash chain integrity across ALL legacy entries (both providers)
    genericValidateHashChain(chainEntries);
    // Filter by this provider's schema
    for (const parsed of allParsed) {
      if (Value.Check(OperationJournalEntrySchema, parsed)) {
        legacyEntries.push(parsed as OperationJournalEntry);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // 3. Merge and dedupe by entryHash
  const seen = new Set<string>();
  const merged: OperationJournalEntry[] = [];
  for (const entry of [...newEntries, ...legacyEntries]) {
    if (!seen.has(entry.entryHash)) {
      seen.add(entry.entryHash);
      merged.push(entry);
    }
  }

  if (filter?.planId) {
    return merged.filter((entry) => entry.planId === filter.planId);
  }
  return merged;
}

/** Re-exported generic helpers for internal use. */
export { genericComputeEntryHash as computeEntryHash, genericValidateHashChain as validateHashChain };
