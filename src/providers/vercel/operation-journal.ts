import { join } from "node:path";
import { Type, type Static } from "typebox";
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

function vcPath(cwd: string): string {
  return join(cwd, ".pi-ship", "operation-journal.jsonl");
}

const vcJournal = createOperationJournal<OperationJournalEntry>(OperationJournalEntrySchema, vcPath);

export const operationJournalPath = vcJournal.path;
export const readOperationJournal = vcJournal.read;
export const appendOperationEntry = vcJournal.append;

/** Re-exported generic helpers for internal use. */
export { genericComputeEntryHash as computeEntryHash, genericValidateHashChain as validateHashChain };
