import { join } from "node:path";
import { Type, type Static } from "typebox";
import {
  createOperationJournal,
  computeEntryHash as genericComputeEntryHash,
  validateHashChain as genericValidateHashChain,
} from "../../deployment/operation-journal.js";

const Strict = { additionalProperties: false } as const;
const NonEmpty = Type.String({ minLength: 1 });

const Base = {
  version: Type.Literal(1),
  ts: Type.String({ minLength: 1 }),
  planId: NonEmpty,
  planDigest: NonEmpty,
  provider: Type.Literal("cloudflare"),
  operationId: NonEmpty,
  kind: Type.Union([
    Type.Literal("ensure_worker"),
    Type.Literal("upload_version"),
    Type.Literal("set_secrets"),
    Type.Literal("deploy"),
    Type.Literal("rollback"),
  ]),
  targetFingerprint: NonEmpty,
  requestFingerprint: NonEmpty,
  expectedStateFingerprint: NonEmpty,
  attempt: Type.Integer({ minimum: 1 }),
  previousHash: Type.Union([Type.String(), Type.Null()]),
  entryHash: Type.String({ minLength: 1 }),
};

const ErrorSchema = Type.Object({
  code: Type.String({ minLength: 1 }),
  message: Type.String({ minLength: 1 }),
  retryable: Type.Boolean(),
}, Strict);

const Reason = Type.Union([
  Type.Literal("transport"),
  Type.Literal("rate_limited"),
  Type.Literal("unauthorized"),
  Type.Literal("forbidden"),
  Type.Literal("malformed"),
  Type.Literal("missing_payload"),
  Type.Literal("conflict"),
]);

export const OperationJournalEntrySchema = Type.Union([
  Type.Object({ ...Base, status: Type.Literal("start") }, Strict),
  Type.Object({ ...Base, status: Type.Literal("ok"), resourceRef: NonEmpty, observedStateFingerprint: NonEmpty, providerRequestId: Type.Optional(Type.String()) }, Strict),
  Type.Object({ ...Base, status: Type.Literal("fail"), error: ErrorSchema }, Strict),
  Type.Object({ ...Base, status: Type.Literal("ambiguous"), reason: Reason, safeMessage: Type.String({ minLength: 1 }), resourceRef: Type.Optional(NonEmpty) }, Strict),
  Type.Object({ ...Base, status: Type.Literal("reconciled"), outcome: Type.Literal("matches_expected"), resourceRef: NonEmpty, observedStateFingerprint: NonEmpty }, Strict),
  Type.Object({ ...Base, status: Type.Literal("reconciled"), outcome: Type.Union([Type.Literal("not_applied"), Type.Literal("conflict")]), resourceRef: Type.Optional(NonEmpty), observedStateFingerprint: NonEmpty }, Strict),
  Type.Object({ ...Base, status: Type.Literal("reconciled"), outcome: Type.Literal("unverified"), reason: Reason, safeMessage: Type.String({ minLength: 1 }) }, Strict),
]);

export type OperationJournalEntry = Static<typeof OperationJournalEntrySchema>;
type WithoutChain<T> = T extends unknown ? Omit<T, "entryHash" | "previousHash"> : never;
export type NewOperationJournalEntry = WithoutChain<OperationJournalEntry>;

function cfPath(cwd: string): string {
  return join(cwd, ".pi-ship", "operation-journal.jsonl");
}

const cfJournal = createOperationJournal<OperationJournalEntry>(OperationJournalEntrySchema, cfPath);

export const operationJournalPath = cfJournal.path;
export const readOperationJournal = cfJournal.read;
export const appendOperationEntry = cfJournal.append;

/** Re-exported generic helpers for internal use. */
export { genericComputeEntryHash as computeEntryHash, genericValidateHashChain as validateHashChain };
