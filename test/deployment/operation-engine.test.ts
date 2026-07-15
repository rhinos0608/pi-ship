import { describe, expect, it, vi } from "vitest";
import { err } from "../../src/core/errors.js";
import {
  filterPriorEntries,
  latestResourceRef,
  providerStatusCode,
  type PriorEntry,
  type GenericOperation,
  type OperationRunHooks,
} from "../../src/deployment/operation-engine.js";
import type { OperationResult, Verification, ReconciliationState, UnverifiedReason } from "../../src/deployment/contracts.js";

// ── filterPriorEntries ──────────────────────────────────────────────────────

describe("generic operation engine filterPriorEntries", () => {
  const entries: PriorEntry[] = [
    { planId: "p1", planDigest: "d1", operationId: "o1", requestFingerprint: "r1", expectedStateFingerprint: "e1", attempt: 1, status: "start" },
    { planId: "p1", planDigest: "d1", operationId: "o1", requestFingerprint: "r1", expectedStateFingerprint: "e1", attempt: 1, status: "ok", resourceRef: "res-1" },
    { planId: "p1", planDigest: "d1", operationId: "o2", requestFingerprint: "r2", expectedStateFingerprint: "e2", attempt: 1, status: "start" },
    { planId: "p2", planDigest: "d2", operationId: "o1", requestFingerprint: "r1", expectedStateFingerprint: "e1", attempt: 1, status: "start" },
  ];

  it("filters by plan and operation identity", () => {
    const result = filterPriorEntries(entries, "p1", "d1", { operationId: "o1", requestFingerprint: "r1", expectedStateFingerprint: "e1" });
    expect(result).toHaveLength(2);
    expect(result[0].status).toBe("start");
    expect(result[1].status).toBe("ok");
  });

  it("returns empty for no match", () => {
    const result = filterPriorEntries(entries, "p1", "d1", { operationId: "o1", requestFingerprint: "wrong", expectedStateFingerprint: "e1" });
    expect(result).toHaveLength(0);
  });

  it("separates different operations", () => {
    const result = filterPriorEntries(entries, "p1", "d1", { operationId: "o2", requestFingerprint: "r2", expectedStateFingerprint: "e2" });
    expect(result).toHaveLength(1);
  });

  it("separates different plans", () => {
    const result = filterPriorEntries(entries, "p2", "d2", { operationId: "o1", requestFingerprint: "r1", expectedStateFingerprint: "e1" });
    expect(result).toHaveLength(1);
  });
});

// ── latestResourceRef ───────────────────────────────────────────────────────

describe("generic operation engine latestResourceRef", () => {
  it("returns undefined when no resourceRef", () => {
    const entries: PriorEntry[] = [
      { planId: "p", planDigest: "d", operationId: "o", requestFingerprint: "r", expectedStateFingerprint: "e", attempt: 1, status: "start" },
    ];
    expect(latestResourceRef(entries)).toBeUndefined();
  });

  it("returns the last entry with resourceRef", () => {
    const entries: PriorEntry[] = [
      { planId: "p", planDigest: "d", operationId: "o", requestFingerprint: "r", expectedStateFingerprint: "e", attempt: 1, status: "ambiguous", resourceRef: "old-res" },
      { planId: "p", planDigest: "d", operationId: "o", requestFingerprint: "r", expectedStateFingerprint: "e", attempt: 2, status: "ambiguous", resourceRef: "new-res" },
    ];
    expect(latestResourceRef(entries)).toBe("new-res");
  });

  it("skips entries without resourceRef", () => {
    const entries: PriorEntry[] = [
      { planId: "p", planDigest: "d", operationId: "o", requestFingerprint: "r", expectedStateFingerprint: "e", attempt: 1, status: "ambiguous" },
      { planId: "p", planDigest: "d", operationId: "o", requestFingerprint: "r", expectedStateFingerprint: "e", attempt: 2, status: "ok", resourceRef: "resolved" },
    ];
    expect(latestResourceRef(entries)).toBe("resolved");
  });
});

// ── providerStatusCode ──────────────────────────────────────────────────────

describe("generic operation engine providerStatusCode", () => {
  it("passes through valid ship error codes", () => {
    expect(providerStatusCode("E_CONFIG_INVALID")).toBe("E_CONFIG_INVALID");
    expect(providerStatusCode("E_PROVIDER")).toBe("E_PROVIDER");
    expect(providerStatusCode("E_AUTH_MISSING")).toBe("E_AUTH_MISSING");
  });

  it("maps unknown code to E_PROVIDER", () => {
    expect(providerStatusCode("UNKNOWN_ERROR")).toBe("E_PROVIDER");
    expect(providerStatusCode("INTERNAL")).toBe("E_PROVIDER");
  });
});

// ── runOperationPlan integration ────────────────────────────────────────────
// (Uses a simplified fake setup to validate loop mechanics)

import { runOperationPlan } from "../../src/deployment/operation-engine.js";

interface TestOp extends GenericOperation {
  kind: string;
}

function makeOp(id: string, deps: string[] = []): TestOp {
  return {
    operationId: id,
    dependsOn: deps,
    targetFingerprint: "tf",
    requestFingerprint: `rf-${id}`,
    expectedStateFingerprint: `esf-${id}`,
    kind: "test",
  };
}

function executeOk(id: string): OperationResult {
  return { status: "succeeded" as const, observedStateFingerprint: `esf-${id}`, resourceRef: `res-${id}` };
}

function executeAmbiguous(id: string): OperationResult {
  return { status: "ambiguous" as const, reason: "transport" as UnverifiedReason, safeMessage: "timeout" };
}

function simpleVerify<T>(value: T): Verification<T> {
  return { status: "verified" as const, value, observedAt: new Date().toISOString() };
}

describe("generic operation engine runOperationPlan", () => {
  it("executes operations in order", async () => {
    const executed: string[] = [];
    const hooks: OperationRunHooks<TestOp, string[], string> = {
      signal: undefined,
      loadState: async () => [],
      saveState: async () => {},
      readPriorEntries: async () => [],
      appendStart: async () => { executed.push("start"); },
      appendOk: async () => { executed.push("ok"); },
      appendFail: async () => { executed.push("fail"); },
      appendAmbiguous: async () => { executed.push("ambiguous"); },
      appendReconciled: async () => { executed.push("reconciled"); },
      appendReconciledUnverified: async () => { executed.push("reconciled-unverified"); },
      execute: async (op) => executeOk(op.operationId),
      reconcile: async () => simpleVerify({ outcome: "not_applied", observedStateFingerprint: "absent" }),
      applyVerifiedState: (state) => [...state, "done"],
      requireResource: () => {},
    };
    const result = await runOperationPlan<TestOp, string[], string>(
      { planId: "p", planDigest: "d" },
      [makeOp("o1"), makeOp("o2", ["o1"])],
      hooks,
    );
    expect(result).toContain("done");
    expect(result).toHaveLength(2);
  });

  it("throws on unmet dependency", async () => {
    const hooks: OperationRunHooks<TestOp, unknown, string> = {
      signal: undefined,
      loadState: async () => ({}),
      saveState: async () => {},
      readPriorEntries: async () => [],
      appendStart: async () => {},
      appendOk: async () => {},
      appendFail: async () => {},
      appendAmbiguous: async () => {},
      appendReconciled: async () => {},
      appendReconciledUnverified: async () => {},
      execute: async () => executeOk("o2"),
      reconcile: async () => simpleVerify({ outcome: "not_applied", observedStateFingerprint: "absent" }),
      applyVerifiedState: (s) => s,
      requireResource: () => {},
    };
    await expect(runOperationPlan({ planId: "p", planDigest: "d" }, [makeOp("o2", ["o1"])], hooks)).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("reconciles prior entry and skips on matches_expected", async () => {
    const execute = vi.fn();
    const hooks: OperationRunHooks<TestOp, unknown, string> = {
      signal: undefined,
      loadState: async () => ({}),
      saveState: async () => {},
      readPriorEntries: async () => [
        { planId: "p", planDigest: "d", operationId: "o1", requestFingerprint: "rf-o1", expectedStateFingerprint: "esf-o1", attempt: 1, status: "start" },
      ],
      appendStart: async () => {},
      appendOk: async () => {},
      appendFail: async () => {},
      appendAmbiguous: async () => {},
      appendReconciled: async () => {},
      appendReconciledUnverified: async () => {},
      execute,
      reconcile: async () => simpleVerify({ outcome: "matches_expected", observedStateFingerprint: "esf-o1", resourceRef: "existing-res" }),
      applyVerifiedState: (s) => s,
      requireResource: () => {},
    };
    await runOperationPlan({ planId: "p", planDigest: "d" }, [makeOp("o1")], hooks);
    expect(execute).not.toHaveBeenCalled();
  });

  it("retries once after not_applied reconciliation", async () => {
    let calls = 0;
    const hooks: OperationRunHooks<TestOp, unknown, string> = {
      signal: undefined,
      loadState: async () => ({}),
      saveState: async () => {},
      readPriorEntries: async () => [
        { planId: "p", planDigest: "d", operationId: "o1", requestFingerprint: "rf-o1", expectedStateFingerprint: "esf-o1", attempt: 1, status: "start" },
      ],
      appendStart: async () => {},
      appendOk: async () => {},
      appendFail: async () => {},
      appendAmbiguous: async () => {},
      appendReconciled: async () => {},
      appendReconciledUnverified: async () => {},
      execute: async () => { calls++; return executeOk("o1"); },
      reconcile: async () => simpleVerify({ outcome: "not_applied", observedStateFingerprint: "absent" }),
      applyVerifiedState: (s) => s,
      requireResource: () => {},
    };
    await runOperationPlan({ planId: "p", planDigest: "d" }, [makeOp("o1")], hooks);
    expect(calls).toBe(1); // retried once after prior not_applied
  });

  it("throws conflict when ambiguous followed by conflict reconciliation", async () => {
    let calls = 0;
    const hooks: OperationRunHooks<TestOp, unknown, string> = {
      signal: undefined,
      loadState: async () => ({}),
      saveState: async () => {},
      readPriorEntries: async () => [],
      appendStart: async () => {},
      appendOk: async () => {},
      appendFail: async () => {},
      appendAmbiguous: async () => {},
      appendReconciled: async () => {},
      appendReconciledUnverified: async () => {},
      execute: async () => { calls++; return executeAmbiguous("o1"); },
      reconcile: async () => simpleVerify({ outcome: "conflict", observedStateFingerprint: "other" }),
      applyVerifiedState: (s) => s,
      requireResource: () => {},
    };
    await expect(runOperationPlan({ planId: "p", planDigest: "d" }, [makeOp("o1")], hooks)).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
    expect(calls).toBe(1);
  });

  it("handles cancelled execution", async () => {
    const ac = new AbortController();
    ac.abort();
    const hooks: OperationRunHooks<TestOp, unknown, string> = {
      signal: ac.signal,
      loadState: async () => ({}),
      saveState: async () => {},
      readPriorEntries: async () => [],
      appendStart: async () => {},
      appendOk: async () => {},
      appendFail: async () => {},
      appendAmbiguous: async () => {},
      appendReconciled: async () => {},
      appendReconciledUnverified: async () => {},
      execute: async () => executeOk("o1"),
      reconcile: async () => simpleVerify({ outcome: "not_applied", observedStateFingerprint: "absent" }),
      applyVerifiedState: (s) => s,
      requireResource: () => {},
    };
    await expect(runOperationPlan({ planId: "p", planDigest: "d" }, [makeOp("o1")], hooks)).rejects.toMatchObject({ code: "E_CANCELLED" });
  });

  it("throws on fingerprint mismatch after execution", async () => {
    const hooks: OperationRunHooks<TestOp, unknown, string> = {
      signal: undefined,
      loadState: async () => ({}),
      saveState: async () => {},
      readPriorEntries: async () => [],
      appendStart: async () => {},
      appendOk: async () => {},
      appendFail: async () => {},
      appendAmbiguous: async () => {},
      appendReconciled: async () => {},
      appendReconciledUnverified: async () => {},
      execute: async () => ({ status: "succeeded" as const, observedStateFingerprint: "wrong", resourceRef: "r" }),
      reconcile: async () => simpleVerify({ outcome: "not_applied", observedStateFingerprint: "absent" }),
      applyVerifiedState: (s) => s,
      requireResource: () => {},
    };
    await expect(runOperationPlan({ planId: "p", planDigest: "d" }, [makeOp("o1")], hooks)).rejects.toMatchObject({ code: "E_STATE_CONFLICT" });
  });

  it("requires resource after succeeded execution", async () => {
    const requireFn = vi.fn();
    const hooks: OperationRunHooks<TestOp, unknown, string> = {
      signal: undefined,
      loadState: async () => ({}),
      saveState: async () => {},
      readPriorEntries: async () => [],
      appendStart: async () => {},
      appendOk: async () => {},
      appendFail: async () => {},
      appendAmbiguous: async () => {},
      appendReconciled: async () => {},
      appendReconciledUnverified: async () => {},
      execute: async () => executeOk("o1"),
      reconcile: async () => simpleVerify({ outcome: "not_applied", observedStateFingerprint: "absent" }),
      applyVerifiedState: (s) => s,
      requireResource: (op, ref) => { requireFn(op.operationId, ref); },
    };
    await runOperationPlan({ planId: "p", planDigest: "d" }, [makeOp("o1")], hooks);
    expect(requireFn).toHaveBeenCalledWith("o1", "res-o1");
  });
});
