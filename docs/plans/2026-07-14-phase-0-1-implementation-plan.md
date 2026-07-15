# Phase 0–1 Production Expansion Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand pi-ship with Phase 0 safety/contract foundation (V2 schemas, validated persistence, fail-closed journal, provider-scoped credentials, provider-rich approval, typed operation journal, reconciliation) and Phase 1 Vercel connector (auth, project discover, write-only secret upsert, preview/production deploy, status, bounded redacted logs, rollback), preserving all V1 Railway behavior and digest compatibility.

**Architecture:** Side-by-side V1/V2 engines. Railway V1 remains untouched. V2 uses strict Typebox discriminated unions with `additionalProperties: false`. Vercel implements separate `AppOperationRuntime` interface, never `ProviderAdapter`. Native injectable `fetch` for all Vercel HTTP. Write-only sensitive env upsert. Fail-closed journal and reconciliation.

**Tech Stack:** TypeScript, Typebox, Vitest, native `fetch`, node crypto (SHA-256/SHA-1), node fs.

## Global Constraints

- V1 Railway manifest, plan, state, journal shape, and digest algorithm remain byte-compatible.
- No new npm dependencies. No `@vercel/sdk`.
- `additionalProperties: false` on every Typebox object in V2 schemas.
- No raw SQL, shell, connection strings, DNS, local backups, restore, deletion, unattended production mutation.
- Secret values never enter plans, state, journals, logs, or tool results.
- V2 plans/state validated at load time; never cast unvalidated JSON.
- All Vercel endpoint paths per refreshed research: events `/v3`, runtime-logs `/v1/projects/{pid}/deployments/{did}/runtime-logs`, cancel `PATCH /v12`, rollback `POST /v1/projects/{pid}/rollback/{did}`.
- Required checks before any commit: `npm test`, `npm run typecheck`, `npm run acceptance`, `git diff --check`.

## File Structure

### Phase 0 — New/Modified Files

| File | Responsibility |
|------|---------------|
| `src/core/types.ts` | Add V2 types: `UnverifiedReason`, `Verification`, `AccountRef`, provider literals |
| `src/core/manifest-v2.ts` | ManifestV2 Typebox schema, `ManifestV2` type, semantic validation |
| `src/core/plan-v2.ts` | PlanV2 schema, VercelOperation types, `LocalSourceRef`, `buildPlanV2()`, fingerprints |
| `src/core/plan-store.ts` | Add validated `loadPlan()` with shape check, V2-aware `persistPlanV2()` |
| `src/core/state-v2.ts` | StateV2 schema, `loadStateV2()`, `saveStateV2()`, `defaultStateV2()`, conflict detection |
| `src/core/operation-journal.ts` | OperationJournalEntry schema, hash-chain, fail-closed append/read |
| `src/core/journal.ts` | Fail-closed: malformed line throws `E_STATE_CONFLICT` instead of skip |
| `src/core/engine.ts` | No changes to V1 path; only add reconciliation note |
| `src/core/engine-v2.ts` | V2 engine: `applyPlanV2()`, uses `AppOperationRuntime`, reconciliation, typed journal |
| `src/core/approval.ts` | Export `renderPlanSummary()`, add V1 enrichment, add `renderPlanSummaryV2()` |
| `src/core/authorization.ts` | Add V2 authorization path |
| `src/core/credentials.ts` | `CredentialSource`, `loadProviderCredentials()`, credential isolation |
| `src/core/errors.ts` | No changes — existing codes sufficient |
| `src/core/redact.ts` | No changes |
| `src/providers/vercel/client.ts` | Vercel HTTP client: native fetch, injectable, all endpoint wrappers |
| `src/providers/vercel/source.ts` | Local git file enumeration, SHA-1, upload, validation |
| `src/providers/vercel/runtime.ts` | `AppOperationRuntime` implementation for Vercel |
| `src/providers/vercel/types.ts` | Vercel-specific Typebox response schemas |
| `src/providers/factory.ts` | `createProviderExecution()` — provider-scoped credential + manifest → execution |
| `src/tools/ship-ops.ts` | Extend V2 plan path; keep V1 Railway path unchanged |
| `src/tools/db-ops.ts` | V2 database actions return `E_PHASE_UNSUPPORTED` |
| `src/gate.ts` | Add V2 approval gate for apply_plan with V2 plans |
| `src/index.ts` | Register V2-aware tools/gate |

### Phase 0–1 — New Test Files

| Test File | Coverage |
|-----------|----------|
| `test/fixtures/generate-v1-fixture.test.ts` | V1 digest fixture generation and regression |
| `test/core/engine.test.ts` | Preflight, authorization, secret missing, dangling journal, already-applied skip, signal abort |
| `test/core/types-v2.test.ts` | Verification helpers |
| `test/core/manifest-v2.test.ts` | ManifestV2 validation, union discrimination, V1 passthrough, invalid shapes |
| `test/core/plan-store.test.ts` | Validated load, corrupt JSON, V2 persist/load round-trip |
| `test/core/plan-v2.test.ts` | PlanV2 build, fingerprints, operations, digest determinism |
| `test/core/state-v2.test.ts` | StateV2 load/save/default, V1→V2 conflict detection |
| `test/core/operation-journal.test.ts` | Hash chain, fail-closed corruption, append/read, schema validation |
| `test/core/credentials.test.ts` | Credential isolation, factory, unknown provider |
| `test/core/engine-v2.test.ts` | V2 engine with fake runtime: deploy, rollback, ambiguous reconciliation |
| `test/core/approval.test.ts` (modify) | V1 enriched summary, V2 summary |
| `test/providers/factory.test.ts` | Railway→ProviderAdapter, Vercel→AppOperationRuntime, unknown provider |
| `test/providers/vercel-client.test.ts` | All endpoints with fake fetch, auth errors, rate limits, malformed responses |
| `test/providers/vercel-runtime.test.ts` | Full AppOperationRuntime contract: discover, plan, execute, reconcile, status, logs |
| `test/providers/vercel-source.test.ts` | File enumeration, symlink rejection, SHA-1, upload, bounds |
| `test/tools/ship-ops.test.ts` | V2 plan action, environment parameter, V1 unchanged |
| `test/tools/db-ops.test.ts` | V2 database returns E_PHASE_UNSUPPORTED |
| `test/gate.test.ts` | V2 approval gate |
| `test/index.test.ts` | Extension registration smoke test |
| `test/acceptance-vercel.e2e.test.ts` | Cloud-free Vercel acceptance: preview, production, status, logs, rollback, token isolation |

---

## Stage 0 — V1 Compatibility Fixtures

### Task 0.1: Capture V1 plan digest fixture

**Files:**
- Create: `test/fixtures/generate-v1-fixture.test.ts`
- Create: `test/fixtures/v1-plan-digest.fixture.json`

**Purpose:** Lock the exact V1 plan digest for a known manifest/git/planId/createdAt so any future refactor can prove byte-compatibility.

- [ ] **Step 1: Generate fixture via test**

Create `test/fixtures/generate-v1-fixture.test.ts`:

```ts
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildPlan, computeDigest } from "../../src/core/plan.js";
import { persistPlan, loadPlan } from "../../src/core/plan-store.js";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

async function initGit(cwd: string) {
  await exec("git", ["init"], { cwd });
  await exec("git", ["config", "user.email", "fixture@test.local"], { cwd });
  await exec("git", ["config", "user.name", "Fixture"], { cwd });
  await writeFile(join(cwd, "init.txt"), "fixture-content\n");
  await exec("git", ["add", "."], { cwd });
  await exec("git", ["commit", "-m", "fixture commit"], { cwd });
}

const fixtureManifest = {
  name: "fixture-app",
  provider: "railway" as const,
  project: "fixture-project",
  run: { command: ["node", "server.js"] as [string, string] },
  secrets: ["DATABASE_URL"],
};

describe("V1 digest fixture", () => {
  it("produces deterministic digest for fixed inputs", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pi-ship-fixture-"));
    await initGit(tmp);
    const plan = await buildPlan(tmp, fixtureManifest, "production", {
      planId: "00000000-0000-0000-0000-000000000001",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await persistPlan(tmp, plan);
    const loaded = await loadPlan(tmp, plan.planId);

    const recomputed = computeDigest(loaded);
    expect(loaded.planDigest).toBe(recomputed);

    // Write fixture for future regression into project test/fixtures/
    const fixture = {
      planId: plan.planId,
      planDigest: plan.planDigest,
      gitCommit: plan.gitCommit,
      worktreeHash: plan.worktreeHash,
      manifest: plan.manifest,
      createdAt: plan.createdAt,
      environment: plan.environment,
      intent: plan.intent,
      serialized: JSON.stringify(plan, null, 2),
    };
    const fixtureDir = join(__dirname);
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(
      join(fixtureDir, "v1-plan-digest.fixture.json"),
      JSON.stringify(fixture, null, 2) + "\n"
    );
    expect(plan.planDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});
```

- [ ] **Step 2: Run test, capture fixture**

Run: `npx vitest --run test/fixtures/generate-v1-fixture.test.ts`
Expected: PASS. Fixture written to `test/fixtures/v1-plan-digest.fixture.json`.

- [ ] **Step 3: Commit fixture file**

```bash
git add test/fixtures/v1-plan-digest.fixture.json test/fixtures/generate-v1-fixture.test.ts
git commit -m "test: capture V1 plan digest fixture for regression"
```

**Acceptance:** Fixture file exists at `test/fixtures/v1-plan-digest.fixture.json` with `planDigest` field matching `^[a-f0-9]{64}$`. Test passes. Re-running produces identical digest.

**Review gate:** Confirm fixture file content is deterministic and non-empty.

**Stage check:**
```bash
npm test -- --run test/fixtures/generate-v1-fixture.test.ts
# Expected: 1 test passed
```

---

## Stage 1 — Missing V1 Tests (Before Refactoring)

### Task 1.1: Engine preflight and authorization tests

**Files:**
- Create: `test/core/engine.test.ts`

**Interfaces consumed:**
- `applyPlan(ctx: ApplyContext): Promise<ToolResult>` from `src/core/engine.ts`
- `createFakeProvider()` from `src/providers/fake.ts`

**Test cases (all use `createFakeProvider()` + temp cwd with git repo):**

1. `rejects when plan digest mismatches supplied digest` — supply different digest → `E_DIGEST_MISMATCH`
2. `rejects when plan not approved` — no registry approval → `E_APPROVAL_REQUIRED`
3. `rejects when plan is stale (old createdAt)` — set createdAt 31min ago → `E_PLAN_STALE`
4. `rejects when required secrets are missing` — plan with `secrets: ["X"]`, envReader returns `{}` → `E_PRECONDITION` with "missing secrets: X"
5. `rejects when dangling non-idempotent journal entry exists` — pre-write `start` entry for "deploy" without terminal → `E_STATE_CONFLICT`
6. `skips already-applied plan` — pre-write matching history entry → returns "already applied" without calling adapter
7. `throws E_CANCELLED when signal aborted before adapter call` — pass pre-aborted signal → `E_CANCELLED`
8. `auth failure maps to E_AUTH_MISSING` — inject `checkAuth` failure → `E_AUTH_MISSING`

- [ ] **Step 1: Write failing tests**

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { applyPlan } from "../../src/core/engine.js";
import { buildPlan } from "../../src/core/plan.js";
import { persistPlan } from "../../src/core/plan-store.js";
import { ApprovalRegistry } from "../../src/core/approval.js";
import { createFakeProvider } from "../../src/providers/fake.js";
import { appendJournal } from "../../src/core/journal.js";
import { saveState, defaultState } from "../../src/core/state.js";
import type { Manifest } from "../../src/core/manifest.js";
import { err } from "../../src/core/errors.js";

const exec = promisify(execFile);

let tmp: string;
let registry: ApprovalRegistry;
const manifest: Manifest = {
  name: "eng-test",
  provider: "railway",
  project: "eng-proj",
  run: { command: ["node", "server.js"] },
  secrets: ["APP_SECRET"],
};

async function initGit(cwd: string) {
  await exec("git", ["init"], { cwd });
  await exec("git", ["config", "user.email", "test@test.local"], { cwd });
  await exec("git", ["config", "user.name", "Test"], { cwd });
  await writeFile(join(cwd, "x"), "y");
  await exec("git", ["add", "."], { cwd });
  await exec("git", ["commit", "-m", "init"], { cwd });
}

async function makeApprovedPlan() {
  const plan = await buildPlan(tmp, manifest, "production", {
    planId: "eng-plan-1",
    targetSnapshot: {
      projectId: undefined, projectName: undefined,
      environmentId: undefined, environmentName: undefined,
      serviceIds: {}, serviceNames: {},
    },
  });
  await persistPlan(tmp, plan);
  registry.approve(plan.planId, plan.planDigest);
  return plan;
}

function baseCtx(
  plan: Awaited<ReturnType<typeof makeApprovedPlan>>,
  overrides: Partial<Parameters<typeof applyPlan>[0]> = {}
) {
  return {
    adapter: createFakeProvider(),
    manifest,
    plan,
    cwd: tmp,
    envReader: () => ({ APP_SECRET: "val" }),
    piExec: async () => ({
      code: 0, stdout: "", stderr: "",
      killed: false, cancelled: false, truncated: false,
    }),
    registry,
    suppliedDigest: plan.planDigest,
    ...overrides,
  };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pi-ship-engine-"));
  await initGit(tmp);
  registry = new ApprovalRegistry(tmp);
});

afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe("applyPlan preflight", () => {
  it("rejects digest mismatch", async () => {
    const plan = await makeApprovedPlan();
    await expect(
      applyPlan(baseCtx(plan, { suppliedDigest: "bad" }))
    ).rejects.toMatchObject({ code: "E_DIGEST_MISMATCH" });
  });

  it("rejects unapproved plan", async () => {
    const plan = await buildPlan(tmp, manifest, "production", {
      planId: "unapproved",
      targetSnapshot: {
        projectId: undefined, projectName: undefined,
        environmentId: undefined, environmentName: undefined,
        serviceIds: {}, serviceNames: {},
      },
    });
    await persistPlan(tmp, plan);
    await expect(applyPlan(baseCtx(plan))).rejects.toMatchObject({
      code: "E_APPROVAL_REQUIRED",
    });
  });

  it("rejects stale plan", async () => {
    const plan = await makeApprovedPlan();
    plan.createdAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    await expect(applyPlan(baseCtx(plan))).rejects.toMatchObject({
      code: "E_PLAN_STALE",
    });
  });

  it("rejects missing secrets", async () => {
    const plan = await makeApprovedPlan();
    await expect(
      applyPlan(baseCtx(plan, { envReader: () => ({}) }))
    ).rejects.toMatchObject({ code: "E_PRECONDITION" });
  });

  it("rejects dangling non-idempotent journal", async () => {
    const plan = await makeApprovedPlan();
    await appendJournal(tmp, {
      ts: "t1", planId: plan.planId, step: "deploy", status: "start",
    });
    await expect(applyPlan(baseCtx(plan))).rejects.toMatchObject({
      code: "E_STATE_CONFLICT",
    });
  });

  it("skips already-applied plan", async () => {
    const plan = await makeApprovedPlan();
    const state = defaultState();
    state.history.push({
      planId: plan.planId,
      digest: plan.planDigest,
      at: new Date().toISOString(),
      status: "ok",
    });
    await saveState(tmp, state);
    const result = await applyPlan(baseCtx(plan));
    expect(result.content[0]?.text).toContain("already applied");
  });

  it("throws E_CANCELLED on aborted signal", async () => {
    const plan = await makeApprovedPlan();
    const ac = new AbortController();
    ac.abort();
    await expect(
      applyPlan(baseCtx(plan, { signal: ac.signal }))
    ).rejects.toMatchObject({ code: "E_CANCELLED" });
  });

  it("maps auth failure to E_AUTH_MISSING", async () => {
    const plan = await makeApprovedPlan();
    const provider = createFakeProvider();
    provider.injectFailure("checkAuth", err("E_AUTH_MISSING", "no token"));
    await expect(
      applyPlan(baseCtx(plan, { adapter: provider }))
    ).rejects.toMatchObject({ code: "E_AUTH_MISSING" });
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npx vitest --run test/core/engine.test.ts`
Expected: These are characterization tests for existing V1 behavior. All 8 should PASS if engine works correctly. If any fail, that's a real bug to fix first.

- [ ] **Step 3: Verify GREEN**

Run: `npx vitest --run test/core/engine.test.ts`
Expected: 8 tests pass.

- [ ] **Step 4: Commit**

```bash
git add test/core/engine.test.ts
git commit -m "test: add engine preflight and authorization tests"
```

**Acceptance:** 8 tests pass. Tests cover digest mismatch, unapproved, stale, missing secrets, dangling journal, already-applied, abort, auth failure.

**Review gate:** Confirm each test exercises a distinct code path in `engine.ts`.

---

### Task 1.2: Gate tests

**Files:**
- Create: `test/gate.test.ts`

**Interfaces consumed:**
- `registerGate(pi: ExtensionAPI, registry: ApprovalRegistry): void` from `src/gate.ts`

**Test cases:**

1. `blocks ship_ops.apply_plan when not approved` — emit tool_call event → returns `{ block: true }`
2. `allows ship_ops.apply_plan when approved` — approve first → returns `undefined`
3. `blocks db_ops with command field` — emit db_ops with `command` key → block
4. `allows non-mutating actions without approval` — emit `validate` → `undefined`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { ApprovalRegistry } from "../../src/core/approval.js";
import { registerGate } from "../../src/gate.js";

describe("gate", () => {
  let registry: ApprovalRegistry;
  let handler: ((event: any, ctx: any) => Promise<any>) | undefined;

  beforeEach(() => {
    registry = new ApprovalRegistry("/tmp/test");
    handler = undefined;
    const pi = {
      on: (_event: string, fn: any) => { handler = fn; },
    };
    registerGate(pi as any, registry);
  });

  it("blocks unapproved ship_ops.apply_plan", async () => {
    const result = await handler!(
      {
        type: "tool_call",
        toolName: "ship_ops",
        input: { action: "apply_plan", planId: "p1", planDigest: "d1" },
      },
      { cwd: "/tmp/test" }
    );
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("lacks approval"),
    });
  });

  it("allows approved ship_ops.apply_plan", async () => {
    registry.approve("p1", "d1", "/tmp/test");
    const result = await handler!(
      {
        type: "tool_call",
        toolName: "ship_ops",
        input: { action: "apply_plan", planId: "p1", planDigest: "d1" },
      },
      { cwd: "/tmp/test" }
    );
    expect(result).toBeUndefined();
  });

  it("blocks db_ops with command field", async () => {
    const result = await handler!(
      {
        type: "tool_call",
        toolName: "db_ops",
        input: {
          action: "apply_plan",
          planId: "p1",
          planDigest: "d1",
          command: ["rm", "-rf", "/"],
        },
      },
      { cwd: "/tmp/test" }
    );
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("command field"),
    });
  });

  it("allows non-mutating ship_ops without approval", async () => {
    const result = await handler!(
      { type: "tool_call", toolName: "ship_ops", input: { action: "validate" } },
      { cwd: "/tmp/test" }
    );
    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npx vitest --run test/gate.test.ts`
Expected: FAIL — `isToolCallEventType` from `pi-coding-agent` is a type-guard that checks event shape. The mock event objects must match the exact shape expected by `isToolCallEventType`. Investigate the guard's expected shape (it likely checks `event.type === 'tool_call'` and `event.toolName === toolName`). Adapt mock events accordingly.

- [ ] **Step 3: Adapt event shape and run GREEN**

If `isToolCallEventType` requires additional fields, add them to mock events. Alternatively, test the gate logic by extracting it or testing through a real pi mock.

Run: `npx vitest --run test/gate.test.ts`
Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add test/gate.test.ts
git commit -m "test: add gate approval-blocking tests"
```

**Acceptance:** 4 tests pass. Gate correctly blocks unapproved apply_plan and db_ops with command.

**Review gate:** Confirm gate handler is exercised for both ship_ops and db_ops paths.

---

### Task 1.3: Index registration smoke test

**Files:**
- Create: `test/index.test.ts`

**Interfaces consumed:**
- `piShipExtension(pi: ExtensionAPI): void` from `src/index.ts`

**Test case:**

1. `extension registers gate, ship_ops, db_ops, and commands` — mock ExtensionAPI, call `piShipExtension`, verify `registerTool` called with "ship_ops" and "db_ops", `registerCommand` called with "ship-init", "ship-plan", "ship-apply", "ship-status", "ship-logs", "ship-rollback", `on` called with "tool_call" and "session_shutdown"

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";
import piShipExtension from "../../src/index.js";

describe("piShipExtension", () => {
  it("registers tools, gate, and commands", () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const events: string[] = [];
    const pi = {
      registerTool: (def: { name: string }) => { tools.push(def.name); },
      registerCommand: (name: string, _opts: any) => { commands.push(name); },
      on: (event: string, _fn: any) => { events.push(event); },
    };
    piShipExtension(pi as any);
    expect(tools).toContain("ship_ops");
    expect(tools).toContain("db_ops");
    expect(commands).toEqual(expect.arrayContaining([
      "ship-init", "ship-plan", "ship-apply",
      "ship-status", "ship-logs", "ship-rollback",
    ]));
    expect(events).toContain("tool_call");
    expect(events).toContain("session_shutdown");
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npx vitest --run test/index.test.ts`
Expected: PASS (characterization of existing behavior).

- [ ] **Step 3: Verify GREEN**

Run: `npx vitest --run test/index.test.ts`
Expected: 1 test pass.

- [ ] **Step 4: Commit**

```bash
git add test/index.test.ts
git commit -m "test: add extension registration smoke test"
```

**Acceptance:** Test verifies all tools, commands, and events registered.

---

### Task 1.4: Plan-store validation tests

**Files:**
- Create: `test/core/plan-store.test.ts`
- Modify: `src/core/plan-store.ts` (add shape validation)

**Interfaces consumed:**
- `persistPlan()`, `loadPlan()`, `verifyDigest()`, `planPath()` from `src/core/plan-store.ts`

**Test cases:**

1. `persist and load round-trips` — persist plan, load back, fields match
2. `loadPlan rejects malformed JSON` — write garbage → `E_CONFIG_INVALID`
3. `loadPlan rejects object missing planId` — write `{}` → `E_CONFIG_INVALID`
4. `persistPlan rejects duplicate planId (EEXIST)` — persist same planId twice → `E_STATE_CONFLICT`
5. `verifyDigest returns true for matching, false for mismatching`

- [ ] **Step 1: Write failing tests**

```ts
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import { persistPlan, loadPlan, verifyDigest, planPath } from "../../src/core/plan-store.js";
import { buildPlan } from "../../src/core/plan.js";

const exec = promisify(execFile);
let tmp: string;

async function initGit(cwd: string) {
  await exec("git", ["init"], { cwd });
  await exec("git", ["config", "user.email", "t@t"], { cwd });
  await exec("git", ["config", "user.name", "T"], { cwd });
  await writeFile(join(cwd, "x"), "y");
  await exec("git", ["add", "."], { cwd });
  await exec("git", ["commit", "-m", "init"], { cwd });
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pi-ship-ps-"));
  await initGit(tmp);
});

describe("plan-store", () => {
  it("round-trips plan through persist/load", async () => {
    const plan = await buildPlan(
      tmp,
      { name: "a", provider: "railway", project: "p", run: { command: ["node"] } },
      "production",
      { planId: "ps-1" }
    );
    await persistPlan(tmp, plan);
    const loaded = await loadPlan(tmp, "ps-1");
    expect(loaded.planId).toBe("ps-1");
    expect(loaded.planDigest).toBe(plan.planDigest);
  });

  it("rejects malformed JSON on load", async () => {
    await mkdir(join(tmp, ".pi-ship", "plans"), { recursive: true });
    await writeFile(planPath(tmp, "bad"), "not-json");
    await expect(loadPlan(tmp, "bad")).rejects.toMatchObject({
      code: "E_CONFIG_INVALID",
    });
  });

  it("rejects object missing planId on load", async () => {
    await mkdir(join(tmp, ".pi-ship", "plans"), { recursive: true });
    await writeFile(planPath(tmp, "empty"), JSON.stringify({}));
    await expect(loadPlan(tmp, "empty")).rejects.toMatchObject({
      code: "E_CONFIG_INVALID",
    });
  });

  it("rejects duplicate planId", async () => {
    const plan = await buildPlan(
      tmp,
      { name: "a", provider: "railway", project: "p", run: { command: ["node"] } },
      "production",
      { planId: "dup" }
    );
    await persistPlan(tmp, plan);
    await expect(persistPlan(tmp, plan)).rejects.toMatchObject({
      code: "E_STATE_CONFLICT",
    });
  });

  it("verifyDigest validates correct digest", async () => {
    const plan = await buildPlan(
      tmp,
      { name: "a", provider: "railway", project: "p", run: { command: ["node"] } },
      "production",
      { planId: "v1" }
    );
    expect(verifyDigest(plan, plan.planDigest)).toBe(true);
    expect(verifyDigest(plan, "wrong")).toBe(false);
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npx vitest --run test/core/plan-store.test.ts`
Expected: FAIL — `loadPlan` currently does `return parsed as Plan` without validation (line 35 of `plan-store.ts`). Test 3 (`rejects object missing planId`) will fail because `{}` is cast as `Plan`.

- [ ] **Step 3: GREEN — Add shape validation to `loadPlan()`**

In `src/core/plan-store.ts`, replace line 35 (`return parsed as Plan;`) with:

```ts
if (!parsed || typeof parsed !== "object") {
  throw err("E_CONFIG_INVALID", `plan ${planId} is not a JSON object`);
}
const p = parsed as Record<string, unknown>;
if (typeof p.planId !== "string" || typeof p.planDigest !== "string") {
  throw err(
    "E_CONFIG_INVALID",
    `plan ${planId} has invalid shape: missing planId or planDigest`
  );
}
return parsed as Plan;
```

- [ ] **Step 4: Run GREEN**

Run: `npx vitest --run test/core/plan-store.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Full regression**

Run: `npm test && npm run typecheck && npm run acceptance`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add test/core/plan-store.test.ts src/core/plan-store.ts
git commit -m "fix: validate plan shape on load; add plan-store tests"
```

**Acceptance:** 5 tests pass. `loadPlan` validates `planId` and `planDigest` before returning. All existing tests still pass.

**Review gate:** Confirm existing V1 plan files still load. Validation is additive, not breaking.

---

## Stage 2 — Phase 0: V2 Schemas and Type Foundation

### Task 2.1: V2 types and shared verification types

**Files:**
- Modify: `src/core/types.ts`
- Create: `test/core/types-v2.test.ts`

**Interfaces produced (added to `src/core/types.ts`):**

```ts
export type ProviderV2 = "railway" | "vercel";

export type UnverifiedReason =
  | "transport"
  | "rate_limited"
  | "unauthorized"
  | "forbidden"
  | "malformed"
  | "missing_payload"
  | "conflict";

export type Verification<T> =
  | { status: "verified"; value: T; observedAt: string }
  | {
      status: "unverified";
      reason: UnverifiedReason;
      retryable: boolean;
      safeMessage: string;
    };

export interface AccountRef {
  kind: "team" | "user";
  id: string;
}

export function verified<T>(value: T, observedAt?: string): Verification<T> {
  return {
    status: "verified",
    value,
    observedAt: observedAt ?? new Date().toISOString(),
  };
}

export function unverified<T>(
  reason: UnverifiedReason,
  safeMessage: string,
  retryable = false
): Verification<T> {
  return { status: "unverified", reason, retryable, safeMessage };
}
```

- [ ] **Step 1: Write test `test/core/types-v2.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { verified, unverified } from "../../src/core/types.js";

describe("Verification helpers", () => {
  it("verified() produces verified status", () => {
    const v = verified({ id: "1" }, "2026-01-01T00:00:00Z");
    expect(v.status).toBe("verified");
    if (v.status === "verified") {
      expect(v.value).toEqual({ id: "1" });
      expect(v.observedAt).toBe("2026-01-01T00:00:00Z");
    }
  });

  it("unverified() produces unverified with reason", () => {
    const v = unverified("transport", "network error", true);
    expect(v.status).toBe("unverified");
    if (v.status === "unverified") {
      expect(v.reason).toBe("transport");
      expect(v.retryable).toBe(true);
      expect(v.safeMessage).toBe("network error");
    }
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npx vitest --run test/core/types-v2.test.ts`
Expected: FAIL — `verified` and `unverified` not exported from `types.ts`.

- [ ] **Step 3: Implement**

Add the types and helper functions to `src/core/types.ts` as specified above.

- [ ] **Step 4: Run GREEN**

Run: `npx vitest --run test/core/types-v2.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Full regression**

Run: `npm test && npm run typecheck`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts test/core/types-v2.test.ts
git commit -m "feat: add V2 verification types and helpers"
```

**Acceptance:** `verified()` and `unverified()` helpers exported. V1 `Provider`, `Environment`, `ToolResult` unchanged.

---

### Task 2.2: ManifestV2 schema and semantic validation

**Files:**
- Create: `src/core/manifest-v2.ts`
- Create: `test/core/manifest-v2.test.ts`

**Interfaces produced:**

```ts
// src/core/manifest-v2.ts

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { err } from "./errors.js";

export const ManifestV2AppConfigSchema = Type.Object(
  {
    projectName: Type.String({ minLength: 1 }),
    teamId: Type.Optional(Type.String({ minLength: 1 })),
    rootDirectory: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

export const ManifestV2AppSchema = Type.Object(
  {
    provider: Type.Literal("vercel"),
    config: ManifestV2AppConfigSchema,
  },
  { additionalProperties: false }
);

export const ManifestV2DatabaseSchema = Type.Object(
  {
    provider: Type.Literal("external"),
    config: Type.Object(
      { urlSecretName: Type.String({ minLength: 1 }) },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const ManifestV2Schema = Type.Object(
  {
    version: Type.Literal(2),
    name: Type.String({ minLength: 1 }),
    app: ManifestV2AppSchema,
    database: Type.Optional(ManifestV2DatabaseSchema),
    checks: Type.Optional(
      Type.Array(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), { minItems: 1 })
    ),
    secrets: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
  },
  { additionalProperties: false }
);

export type ManifestV2 = Static<typeof ManifestV2Schema>;

export function validateManifestV2Semantics(m: ManifestV2): void {
  if (m.app.config.rootDirectory !== undefined) {
    const rd = m.app.config.rootDirectory;
    if (rd.includes("..") || rd.includes("\\") || rd.includes("\0") || rd.startsWith("/")) {
      throw err("E_CONFIG_INVALID", "rootDirectory must be relative, normalized, inside cwd");
    }
  }
  if (m.database && m.secrets) {
    if (!m.secrets.includes(m.database.config.urlSecretName)) {
      throw err("E_CONFIG_INVALID", "database.config.urlSecretName must appear in secrets");
    }
  }
}
```

**Test cases:**

1. `validates minimal V2 manifest` — `{ version: 2, name: "app", app: { provider: "vercel", config: { projectName: "p" } } }` → passes
2. `validates V2 manifest with database and secrets` — full shape passes
3. `rejects version !== 2` — `{ version: 1, ... }` → false
4. `rejects unknown top-level key` — extra field → false
5. `rejects app.provider !== "vercel"` — `{ provider: "aws" }` → false
6. `rejects unknown key inside app.config` — `{ projectName: "p", hacked: true }` → false
7. `rejects rootDirectory with ".."` — throws "relative"
8. `rejects database urlSecretName not in secrets` — throws "urlSecretName"

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  ManifestV2Schema,
  validateManifestV2Semantics,
} from "../../src/core/manifest-v2.js";
import type { ManifestV2 } from "../../src/core/manifest-v2.js";

function validV2(overrides: Partial<ManifestV2> = {}): ManifestV2 {
  return {
    version: 2,
    name: "app",
    app: { provider: "vercel", config: { projectName: "proj" } },
    ...overrides,
  } as ManifestV2;
}

describe("ManifestV2Schema", () => {
  it("accepts minimal V2 manifest", () => {
    expect(Value.Check(ManifestV2Schema, validV2())).toBe(true);
  });

  it("accepts V2 with database and secrets", () => {
    expect(
      Value.Check(
        ManifestV2Schema,
        validV2({
          database: {
            provider: "external",
            config: { urlSecretName: "DATABASE_URL" },
          },
          secrets: ["DATABASE_URL"],
        })
      )
    ).toBe(true);
  });

  it("rejects version !== 2", () => {
    expect(
      Value.Check(ManifestV2Schema, validV2({ version: 1 as any }))
    ).toBe(false);
  });

  it("rejects unknown top-level key", () => {
    expect(
      Value.Check(ManifestV2Schema, { ...validV2(), extra: true })
    ).toBe(false);
  });

  it("rejects app.provider !== vercel", () => {
    expect(
      Value.Check(
        ManifestV2Schema,
        validV2({
          app: { provider: "aws" as any, config: { projectName: "p" } },
        })
      )
    ).toBe(false);
  });

  it("rejects unknown key inside app.config", () => {
    expect(
      Value.Check(
        ManifestV2Schema,
        validV2({
          app: {
            provider: "vercel",
            config: { projectName: "p", hacked: true } as any,
          },
        })
      )
    ).toBe(false);
  });
});

describe("validateManifestV2Semantics", () => {
  it("rejects rootDirectory with ..", () => {
    expect(() =>
      validateManifestV2Semantics(
        validV2({
          app: {
            provider: "vercel",
            config: { projectName: "p", rootDirectory: "../escape" },
          },
        })
      )
    ).toThrow("relative");
  });

  it("rejects database urlSecretName not in secrets", () => {
    expect(() =>
      validateManifestV2Semantics(
        validV2({
          database: {
            provider: "external",
            config: { urlSecretName: "DB_URL" },
          },
          secrets: ["OTHER"],
        })
      )
    ).toThrow("urlSecretName");
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npx vitest --run test/core/manifest-v2.test.ts`
Expected: FAIL — `manifest-v2.ts` does not exist.

- [ ] **Step 3: Implement `src/core/manifest-v2.ts`**

Write the file as specified in the interfaces above.

- [ ] **Step 4: Run GREEN**

Run: `npx vitest --run test/core/manifest-v2.test.ts`
Expected: 8 tests pass.

- [ ] **Step 5: Full regression**

Run: `npm test && npm run typecheck`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/manifest-v2.ts test/core/manifest-v2.test.ts
git commit -m "feat: add ManifestV2 Typebox schema with semantic validation"
```

**Acceptance:** 8 tests pass. V1 manifest unchanged. V2 schema rejects unknown keys, wrong provider, escape paths.

---

### Task 2.3: PlanV2 types, operations, and fingerprints

**Files:**
- Create: `src/core/plan-v2.ts`
- Create: `test/core/plan-v2.test.ts`

**Interfaces produced:**

```ts
// src/core/plan-v2.ts

import { createHash, randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join, relative, posix } from "node:path";
import type { ManifestV2 } from "./manifest-v2.js";
import { canonicalize } from "./plan.js";

export interface LocalSourceRef {
  kind: "local-files";
  rootDirectory: string;
  fileCount: number;
  totalBytes: number;
  fingerprint: string;
}

export interface VercelOperationBase {
  operationId: string;
  provider: "vercel";
  domain: "app";
  targetFingerprint: string;
  requestFingerprint: string;
  expectedStateFingerprint: string;
  destructive: false;
  reversible: boolean;
  dependsOn: string[];
}

export type VercelOperation =
  | (VercelOperationBase & {
      kind: "ensure_project";
      projectName: string;
      observedProjectId?: string;
      reversible: false;
    })
  | (VercelOperationBase & {
      kind: "upsert_secrets";
      projectName: string;
      environment: "preview" | "production";
      secretNames: string[];
      reversible: false;
    })
  | (VercelOperationBase & {
      kind: "deploy";
      projectName: string;
      environment: "preview" | "production";
      source: LocalSourceRef;
      reversible: boolean;
    })
  | (VercelOperationBase & {
      kind: "rollback";
      projectId: string;
      environment: "production";
      targetDeploymentId: string;
      reversible: true;
    });

export interface PlanV2 {
  version: 2;
  planId: string;
  domain: "app";
  manifest: ManifestV2;
  provider: "vercel";
  environment: "preview" | "production";
  intent: "deploy" | "rollback";
  identity: {
    account: { kind: "team" | "user"; id: string };
    project: { name: string; observedId?: string };
    environment: "preview" | "production";
  };
  accountFingerprint: string;
  projectFingerprint: string;
  targetFingerprint: string;
  gitCommit: string;
  gitDirty: boolean;
  worktreeHash: string;
  source?: LocalSourceRef;
  secretNames: string[];
  operations: VercelOperation[];
  estimatedImpact: string;
  createdAt: string;
  planDigest: string;
}

// computeFingerprint: sha256(canonicalize(value))
export function computeFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function computeRequestFingerprint(
  pick: Pick<VercelOperation, "provider" | "kind" | "targetFingerprint"> & {
    requestPayload: unknown;
  }
): string {
  return computeFingerprint({
    provider: pick.provider,
    kind: pick.kind,
    targetFingerprint: pick.targetFingerprint,
    requestPayload: pick.requestPayload,
  });
}

export function computeOperationId(
  pick: Pick<VercelOperation, "provider" | "kind" | "targetFingerprint"> & {
    requestFingerprint: string;
  }
): string {
  return computeFingerprint({
    provider: pick.provider,
    kind: pick.kind,
    targetFingerprint: pick.targetFingerprint,
    requestFingerprint: pick.requestFingerprint,
  });
}

export function computePlanDigestV2(
  plan: Omit<PlanV2, "planDigest">
): string {
  return createHash("sha256").update(canonicalize(plan)).digest("hex");
}

export async function buildPlanV2(
  cwd: string,
  manifest: ManifestV2,
  environment: "preview" | "production",
  intent: "deploy" | "rollback",
  options: {
    planId?: string;
    createdAt?: string;
    accountRef?: { kind: "team" | "user"; id: string };
    source?: LocalSourceRef;
    observedProjectId?: string;
    targetDeploymentId?: string;
    gitCommit?: string;
    gitDirty?: boolean;
    worktreeHash?: string;
  } = {}
): Promise<PlanV2> {
  // Implementation builds operations based on intent:
  // deploy → ensure_project, upsert_secrets, deploy (each depends on prior)
  // rollback → single rollback operation
  // Fingerprints computed from manifest, environment, account
  // Uses same git gathering as plan.ts
  // ... full implementation in actual file
}
```

**Test cases:**

1. `buildPlanV2 produces deploy plan with 3 operations in correct order` — verify ensure_project → upsert_secrets → deploy with correct dependsOn chains
2. `buildPlanV2 produces rollback plan with single operation` — intent: "rollback", one rollback operation, reversible: true
3. `computeFingerprint is deterministic sha256 hex` — same input → same 64-char hex, different input → different hex
4. `computeOperationId changes with different kind` — same targetFingerprint but different kind → different operationId
5. `computePlanDigestV2 is deterministic for fixed inputs` — same planId/createdAt → same digest
6. `deploy reversibility: true for production, false for preview`
7. `source field populated with fileCount and fingerprint` (git repo with known files)

- [ ] **Step 1: Write tests** (full code in task — each test creates temp git repo, builds plan, asserts shape)

- [ ] **Step 2: Run RED**

Run: `npx vitest --run test/core/plan-v2.test.ts`
Expected: FAIL — `plan-v2.ts` does not exist.

- [ ] **Step 3: Implement `src/core/plan-v2.ts`**

Write full implementation following contract section 3. Uses `canonicalize()` re-exported from `plan.ts`. SHA-256 via `node:crypto`.

- [ ] **Step 4: Run GREEN**

Run: `npx vitest --run test/core/plan-v2.test.ts`
Expected: 7 tests pass.

- [ ] **Step 5: Full regression**

Run: `npm test && npm run typecheck`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/plan-v2.ts test/core/plan-v2.test.ts
git commit -m "feat: add PlanV2 types, operations, fingerprints, and digest"
```

**Acceptance:** 7 tests pass. V1 plan unchanged. V2 operations, fingerprints, and digest correct.

---

### Task 2.4: StateV2 schema and persistence

**Files:**
- Create: `src/core/state-v2.ts`
- Create: `test/core/state-v2.test.ts`

**Interfaces produced:**

```ts
// src/core/state-v2.ts

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { err } from "./errors.js";

export const AppEnvironmentStateSchema = Type.Object({
  targetFingerprint: Type.String(),
  lastRelease: Type.Optional(Type.Object({
    id: Type.String(),
    planId: Type.String(),
    digest: Type.String(),
    status: Type.Union([
      Type.Literal("queued"), Type.Literal("building"),
      Type.Literal("ready"), Type.Literal("error"),
      Type.Literal("cancelled"), Type.Literal("blocked"),
      Type.Literal("unknown"),
    ]),
    url: Type.Optional(Type.String()),
    at: Type.String(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export const ExternalDatabaseTargetStateSchema = Type.Object({
  provider: Type.Literal("external"),
  connectionSecretName: Type.String(),
  targetFingerprint: Type.String(),
}, { additionalProperties: false });

export const ReleaseStateSchema = Type.Object({
  provider: Type.Literal("vercel"),
  projectId: Type.String(),
  environment: Type.Union([Type.Literal("preview"), Type.Literal("production")]),
  releaseId: Type.String(),
  planId: Type.String(),
  digest: Type.String(),
  url: Type.Optional(Type.String()),
  at: Type.String(),
}, { additionalProperties: false });

export const HistoryEntryV2Schema = Type.Object({
  planId: Type.String(),
  digest: Type.String(),
  domain: Type.Literal("app"),
  provider: Type.Literal("vercel"),
  status: Type.Union([Type.Literal("ok"), Type.Literal("failed")]),
  at: Type.String(),
}, { additionalProperties: false });

export const StateV2Schema = Type.Object({
  version: Type.Literal(2),
  app: Type.Optional(Type.Object({
    provider: Type.Literal("vercel"),
    account: Type.Object({
      kind: Type.Union([Type.Literal("team"), Type.Literal("user")]),
      id: Type.String(),
    }, { additionalProperties: false }),
    accountFingerprint: Type.String(),
    project: Type.Object({
      id: Type.String(),
      name: Type.String(),
      fingerprint: Type.String(),
    }, { additionalProperties: false }),
    environments: Type.Object({
      preview: Type.Optional(AppEnvironmentStateSchema),
      production: Type.Optional(AppEnvironmentStateSchema),
    }, { additionalProperties: false }),
  }, { additionalProperties: false })),
  databases: Type.Record(Type.String(), ExternalDatabaseTargetStateSchema),
  releases: Type.Array(ReleaseStateSchema),
  history: Type.Array(HistoryEntryV2Schema),
}, { additionalProperties: false });

export type StateV2 = Static<typeof StateV2Schema>;

export function defaultStateV2(): StateV2 {
  return {
    version: 2,
    databases: {},
    releases: [],
    history: [],
  };
}

export function statePathV2(cwd: string): string {
  return join(cwd, ".pi-ship", "state-v2.json");
}

export async function loadStateV2(cwd: string): Promise<StateV2> {
  const path = statePathV2(cwd);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return defaultStateV2();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw err("E_CONFIG_INVALID", `state-v2.json is invalid JSON: ${(e as Error).message}`);
  }
  if (!Value.Check(StateV2Schema, parsed)) {
    throw err("E_CONFIG_INVALID", "state-v2.json has invalid shape");
  }
  return parsed;
}

export async function saveStateV2(cwd: string, state: StateV2): Promise<void> {
  if (!Value.Check(StateV2Schema, state)) {
    throw err("E_CONFIG_INVALID", "state-v2 validation failed before save");
  }
  const path = statePathV2(cwd);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

export function detectStateConflict(
  manifestProvider: string,
  v1StateExists: boolean,
  v2StateExists: boolean
): void {
  // Vercel manifest + Railway V1 state → conflict
  // Railway manifest + V2 state → conflict
  if (manifestProvider === "vercel" && v1StateExists && !v2StateExists) {
    throw err("E_STATE_CONFLICT", "Vercel manifest found but Railway V1 state exists; cannot mix providers");
  }
  if (manifestProvider === "railway" && v2StateExists && !v1StateExists) {
    throw err("E_STATE_CONFLICT", "Railway manifest found but Vercel V2 state exists; cannot mix providers");
  }
}
```

**Test cases:**

1. `defaultStateV2 returns empty state with version: 2`
2. `saveStateV2 round-trips through file`
3. `loadStateV2 returns default when file missing`
4. `loadStateV2 rejects malformed JSON` — `E_CONFIG_INVALID`
5. `loadStateV2 rejects state with version: 1` — `E_CONFIG_INVALID`
6. `detectStateConflict throws for vercel manifest + railway v1 state`
7. `detectStateConflict throws for railway manifest + vercel v2 state`
8. `atomic write does not leave partial state`

- [ ] **Step 1: Write failing tests** (full code)

- [ ] **Step 2: Run RED**

Run: `npx vitest --run test/core/state-v2.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/core/state-v2.ts`**

- [ ] **Step 4: Run GREEN**

Run: `npx vitest --run test/core/state-v2.test.ts`
Expected: 8 tests pass.

- [ ] **Step 5: Full regression**

Run: `npm test && npm run typecheck`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/state-v2.ts test/core/state-v2.test.ts
git commit -m "feat: add StateV2 schema, persistence, and conflict detection"
```

**Acceptance:** 8 tests pass. V1 state untouched. V2 persisted to `.pi-ship/state-v2.json`.

---

### Task 2.5: Fail-closed journal and V2 operation journal

**Files:**
- Modify: `src/core/journal.ts` (fail-closed change)
- Create: `src/core/operation-journal.ts`
- Create: `test/core/operation-journal.test.ts`

**Changes to `journal.ts`:**

Replace the `catch { /* skip corrupted lines */ }` block in `readJournal` (line 40-42) with:

```ts
catch {
  throw err("E_STATE_CONFLICT", "journal contains malformed entry; manual review required");
}
```

**`operation-journal.ts` interfaces:**

```ts
// src/core/operation-journal.ts

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalize } from "./plan.js";
import { err } from "./errors.js";

// UnverifiedReason reused from types.ts
export const OperationJournalBaseSchema = Type.Object({
  version: Type.Literal(2),
  ts: Type.String(),
  planId: Type.String(),
  planDigest: Type.String(),
  provider: Type.Literal("vercel"),
  domain: Type.Literal("app"),
  operationId: Type.String(),
  kind: Type.Union([
    Type.Literal("ensure_project"),
    Type.Literal("upsert_secrets"),
    Type.Literal("deploy"),
    Type.Literal("rollback"),
  ]),
  targetFingerprint: Type.String(),
  requestFingerprint: Type.String(),
  expectedStateFingerprint: Type.String(),
  attempt: Type.Number(),
  previousHash: Type.Union([Type.String(), Type.Null()]),
  entryHash: Type.String(),
}, { additionalProperties: false });

export const OperationJournalEntrySchema = Type.Union([
  // start
  Type.Intersect([OperationJournalBaseSchema, Type.Object({
    status: Type.Literal("start"),
  }, { additionalProperties: false })]),
  // ok
  Type.Intersect([OperationJournalBaseSchema, Type.Object({
    status: Type.Literal("ok"),
    resourceRef: Type.String(),
    observedStateFingerprint: Type.String(),
    providerRequestId: Type.Optional(Type.String()),
  }, { additionalProperties: false })]),
  // fail
  Type.Intersect([OperationJournalBaseSchema, Type.Object({
    status: Type.Literal("fail"),
    error: Type.Object({
      code: Type.String(),
      message: Type.String(),
      retryable: Type.Boolean(),
    }, { additionalProperties: false }),
  }, { additionalProperties: false })]),
  // ambiguous
  Type.Intersect([OperationJournalBaseSchema, Type.Object({
    status: Type.Literal("ambiguous"),
    reason: Type.String(), // UnverifiedReason
  }, { additionalProperties: false })]),
  // reconciled
  Type.Intersect([OperationJournalBaseSchema, Type.Object({
    status: Type.Literal("reconciled"),
    outcome: Type.Union([
      Type.Literal("matches_expected"),
      Type.Literal("not_applied"),
      Type.Literal("conflict"),
      Type.Literal("unverified"),
    ]),
    resourceRef: Type.Optional(Type.String()),
    observedStateFingerprint: Type.Optional(Type.String()),
  }, { additionalProperties: false })]),
]);

export type OperationJournalEntry = Static<typeof OperationJournalEntrySchema>;

export function operationJournalPath(cwd: string): string {
  return join(cwd, ".pi-ship", "operation-journal.jsonl");
}

export function computeEntryHash(
  entry: Omit<OperationJournalEntry, "entryHash">
): string {
  return createHash("sha256").update(canonicalize(entry)).digest("hex");
}

export async function appendOperationEntry(
  cwd: string,
  entry: Omit<OperationJournalEntry, "entryHash" | "previousHash">
): Promise<OperationJournalEntry> {
  const existing = await readOperationJournal(cwd);
  const previousHash = existing.length > 0
    ? existing[existing.length - 1].entryHash
    : null;
  const full = { ...entry, previousHash } as Omit<OperationJournalEntry, "entryHash">;
  const entryHash = computeEntryHash(full);
  const complete = { ...full, entryHash } as OperationJournalEntry;
  const path = operationJournalPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(complete) + "\n", "utf8");
  return complete;
}

export async function readOperationJournal(
  cwd: string,
  filter?: { planId?: string }
): Promise<OperationJournalEntry[]> {
  const path = operationJournalPath(cwd);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const entries: OperationJournalEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw err("E_STATE_CONFLICT", "operation-journal contains malformed entry");
    }
    if (!Value.Check(OperationJournalEntrySchema, parsed)) {
      throw err("E_STATE_CONFLICT", "operation-journal entry has invalid shape");
    }
    const entry = parsed as OperationJournalEntry;
    if (!filter?.planId || entry.planId === filter.planId) {
      entries.push(entry);
    }
  }
  // Validate hash chain
  validateHashChain(entries);
  return entries;
}

export function validateHashChain(entries: OperationJournalEntry[]): void {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const expectedPrevious = i === 0 ? null : entries[i - 1].entryHash;
    if (entry.previousHash !== expectedPrevious) {
      throw err("E_STATE_CONFLICT", `operation-journal hash chain broken at entry ${i}`);
    }
    const recomputed = computeEntryHash(
      (({ entryHash, ...rest }) => rest)(entry) as Omit<OperationJournalEntry, "entryHash">
    );
    if (entry.entryHash !== recomputed) {
      throw err("E_STATE_CONFLICT", `operation-journal entry ${i} hash mismatch`);
    }
  }
}
```

**Test cases:**

1. `append and read round-trips` — append 3 entries, read back, verify fields
2. `hash chain is valid for sequential entries` — verify each entryHash matches recomputed
3. `rejects corrupted entry (malformed JSON)` — write garbage line → `E_STATE_CONFLICT`
4. `rejects entry with invalid schema` — write valid JSON but wrong shape → `E_STATE_CONFLICT`
5. `rejects broken hash chain` — modify middle entry → `E_STATE_CONFLICT`
6. `first entry has previousHash: null`
7. `filters by planId`

**Also test V1 journal change:**

8. `V1 journal rejects malformed line` — write valid + garbage + valid → `E_STATE_CONFLICT` (was previously silently skipped)

- [ ] **Step 1: Write failing tests**

- [ ] **Step 2: Run RED**

Run: `npx vitest --run test/core/operation-journal.test.ts`
Expected: FAIL — files don't exist.

- [ ] **Step 3: Implement**

Write `src/core/operation-journal.ts`. Modify `src/core/journal.ts` fail-closed.

- [ ] **Step 4: Run GREEN**

Run: `npx vitest --run test/core/operation-journal.test.ts`
Expected: 8 tests pass.

- [ ] **Step 5: Verify existing journal tests**

Run: `npx vitest --run test/core/journal.test.ts`
Expected: 3 existing tests pass (none test corruption path).

- [ ] **Step 6: Full regression**

Run: `npm test && npm run typecheck && npm run acceptance`
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/journal.ts src/core/operation-journal.ts test/core/operation-journal.test.ts
git commit -m "feat: fail-closed V1 journal; add V2 operation journal with hash chain"
```

**Acceptance:** 8 new tests pass. V1 journal malformed lines now throw instead of skip. Existing journal tests pass.

---

### Task 2.6: Credential loader

**Files:**
- Create: `src/core/credentials.ts`
- Create: `test/core/credentials.test.ts`

**Interfaces produced:**

```ts
// src/core/credentials.ts

import { err } from "./errors.js";

export type CredentialName = "RAILWAY_API_TOKEN" | "RAILWAY_TOKEN" | "VERCEL_TOKEN";

export interface CredentialSource {
  get(name: CredentialName): string | undefined;
}

export function envCredentialSource(): CredentialSource {
  return { get: (name) => process.env[name] };
}

export type ProviderCredentials =
  | { provider: "railway"; apiToken?: string; projectToken?: string }
  | { provider: "vercel"; token?: string };

export function loadProviderCredentials(
  provider: "railway" | "vercel",
  source: CredentialSource
): ProviderCredentials {
  switch (provider) {
    case "railway":
      return {
        provider: "railway",
        apiToken: source.get("RAILWAY_API_TOKEN") || undefined,
        projectToken: source.get("RAILWAY_TOKEN") || undefined,
      };
    case "vercel":
      return {
        provider: "vercel",
        token: source.get("VERCEL_TOKEN") || undefined,
      };
    default:
      throw err("E_CONFIG_INVALID", `unknown provider: ${provider}`);
  }
}
```

**Test cases:**

1. `railway credentials load apiToken and projectToken from source`
2. `vercel credentials load token from source`
3. `railway credentials: missing tokens return undefined fields`
4. `unknown provider throws E_CONFIG_INVALID`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import { loadProviderCredentials } from "../../src/core/credentials.js";
import type { CredentialSource } from "../../src/core/credentials.js";

function source(vars: Record<string, string>): CredentialSource {
  return { get: (name) => vars[name] };
}

describe("loadProviderCredentials", () => {
  it("railway loads apiToken and projectToken", () => {
    const cred = loadProviderCredentials("railway", source({
      RAILWAY_API_TOKEN: "api",
      RAILWAY_TOKEN: "proj",
    }));
    expect(cred).toEqual({ provider: "railway", apiToken: "api", projectToken: "proj" });
  });

  it("vercel loads token", () => {
    const cred = loadProviderCredentials("vercel", source({
      VERCEL_TOKEN: "vercel-tok",
    }));
    expect(cred).toEqual({ provider: "vercel", token: "vercel-tok" });
  });

  it("missing tokens return undefined fields", () => {
    const cred = loadProviderCredentials("railway", source({}));
    expect(cred).toEqual({ provider: "railway", apiToken: undefined, projectToken: undefined });
  });

  it("unknown provider throws E_CONFIG_INVALID", () => {
    expect(() => loadProviderCredentials("aws" as any, source({}))).toThrow("unknown provider");
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npx vitest --run test/core/credentials.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run GREEN**

Run: `npx vitest --run test/core/credentials.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Full regression**

Run: `npm test && npm run typecheck`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/credentials.ts test/core/credentials.test.ts
git commit -m "feat: add provider-scoped credential loader"
```

**Acceptance:** 4 tests pass. Credential isolation verified.

---

### Task 2.7: Provider-rich approval

**Files:**
- Modify: `src/core/approval.ts`

**Changes:**

1. Export `renderPlanSummary(plan: Plan): string` (currently private function at line 42)
2. Add V1 enrichment to existing `renderPlanSummary`: include `Provider: railway`, project/environment IDs from targetSnapshot, target fingerprint (sha256 of canonicalized targetSnapshot)
3. Add `renderPlanSummaryV2(plan: PlanV2): string` with full V2 fields per contract section 8

**Test additions in `test/core/approval.test.ts`:**

1. `renderPlanSummary includes provider: railway`
2. `renderPlanSummary includes project/environment from targetSnapshot`
3. `renderPlanSummaryV2 includes provider, account, project, environment, fingerprint, source info`
4. `renderPlanSummaryV2 lists operations with reversibility`
5. `renderPlanSummaryV2 shows secret names only, never values`

- [ ] **Step 1: Write failing tests**

- [ ] **Step 2: Run RED**

Run: `npx vitest --run test/core/approval.test.ts`
Expected: FAIL — `renderPlanSummary` not exported (currently private).

- [ ] **Step 3: Implement**

Export `renderPlanSummary`, add V1 enrichment, add `renderPlanSummaryV2`.

- [ ] **Step 4: Run GREEN**

Run: `npx vitest --run test/core/approval.test.ts`
Expected: All tests pass (existing 8 + new 5 = 13).

- [ ] **Step 5: Full regression**

Run: `npm test && npm run typecheck`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/approval.ts test/core/approval.test.ts
git commit -m "feat: export renderPlanSummary; add V1 enrichment and V2 summary"
```

**Acceptance:** All tests pass. V1 summary enriched with provider/project/env. V2 summary shows all contract fields.

---

### Task 2.8: V2 engine with reconciliation

**Files:**
- Create: `src/core/engine-v2.ts`
- Create: `test/core/engine-v2.test.ts`

**Interfaces produced:**

```ts
// src/core/engine-v2.ts

import type { AppOperationRuntime, Verification, ReconciliationState, OperationResult } from "./types.js";
import type { ManifestV2 } from "./manifest-v2.js";
import type { PlanV2, VercelOperation } from "./plan-v2.js";
import type { ApprovalRegistry } from "./approval.js";
import type { ToolResult } from "./types.js";
import { err } from "./errors.js";
import { appendOperationEntry, readOperationJournal } from "./operation-journal.js";
import { redact } from "./redact.js";

export interface VercelProjectSnapshot {
  presence: "absent" | "present";
  account: { kind: "team" | "user"; id: string };
  projectName: string;
  project?: { id: string; name: string };
}

export type VercelStatus = { readyState: string; url?: string; errorMessage?: string };
export type VercelLogs = { lines: string[]; truncated: boolean };

export interface ApplyContextV2 {
  runtime: AppOperationRuntime<VercelProjectSnapshot, VercelOperation, VercelStatus, VercelLogs>;
  manifest: ManifestV2;
  plan: PlanV2;
  cwd: string;
  secretValues: Record<string, string>;
  registry: ApprovalRegistry;
  suppliedDigest: string;
  signal?: AbortSignal;
}

export async function applyPlanV2(ctx: ApplyContextV2): Promise<ToolResult>;
```

Engine behavior:
1. Validate plan digest matches supplied
2. Check approval via registry
3. Load operation journal, validate hash chain
4. For each operation in plan.operations:
   a. Check last entry for this operationId
   b. If `ok` with matching fingerprints → skip
   c. If `start` or `ambiguous` → reconcile first
   d. Reconcile: `matches_expected` → append `reconciled` + skip; `not_applied` → retry; `conflict` or `unverified` → `E_STATE_CONFLICT`
   e. Append `start`, execute, handle result:
      - `succeeded` → append `ok`
      - `failed` with certainty `not_applied` → append `fail`, throw
      - `ambiguous` → append `ambiguous`, then reconcile
5. Return ToolResult with plan details

**Test cases (fake AppOperationRuntime in test file):**

1. `executes deploy plan: ensure_project → upsert_secrets → deploy` — 3 operations executed in order
2. `skips already-completed operation` — pre-write `ok` entry → skip
3. `reconciles ambiguous result` — runtime returns ambiguous, then reconcile matches_expected → continues
4. `blocks on conflict reconciliation` — reconcile returns conflict → `E_STATE_CONFLICT`
5. `rollback plan executes single rollback operation`
6. `rejects when approval missing` → `E_APPROVAL_REQUIRED`
7. `rejects when signal aborted` → `E_CANCELLED`

- [ ] **Step 1: Write failing tests** (create fake `AppOperationRuntime` in test, write all 7 tests)

- [ ] **Step 2: Run RED**

Run: `npx vitest --run test/core/engine-v2.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/core/engine-v2.ts`**

- [ ] **Step 4: Run GREEN**

Run: `npx vitest --run test/core/engine-v2.test.ts`
Expected: 7 tests pass.

- [ ] **Step 5: Full regression**

Run: `npm test && npm run typecheck && npm run acceptance`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/engine-v2.ts test/core/engine-v2.test.ts
git commit -m "feat: add V2 engine with reconciliation and typed operation journal"
```

**Acceptance:** 7 tests pass. V2 engine uses AppOperationRuntime, not ProviderAdapter.

---

### Task 2.9: Phase 0 integration — tool/gate V2 awareness

**Files:**
- Modify: `src/tools/ship-ops.ts` — add V2 plan routing
- Modify: `src/tools/db-ops.ts` — V2 returns `E_PHASE_UNSUPPORTED`
- Modify: `src/gate.ts` — add V2 approval gate
- Modify: `src/index.ts` — register V2-aware components
- Create: `src/providers/factory.ts` — provider execution factory
- Create: `test/tools/ship-ops.test.ts`
- Create: `test/tools/db-ops.test.ts`
- Create: `test/providers/factory.test.ts`

**`factory.ts` interfaces:**

```ts
// src/providers/factory.ts

import type { Manifest } from "../core/manifest.js";
import type { ManifestV2 } from "../core/manifest-v2.js";
import type { ProviderCredentials } from "../core/credentials.js";
import type { ProviderAdapter } from "./types.js";
import type { LocalState } from "../core/state.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRailwayAdapter } from "./railway/index.js";
import { err } from "../core/errors.js";

export type ProviderExecution =
  | { contract: 1; provider: "railway"; adapter: ProviderAdapter }
  | { contract: 2; provider: "vercel"; runtime: any }; // AppOperationRuntime typed later

export function createProviderExecution(
  manifest: Manifest | ManifestV2,
  credentials: ProviderCredentials,
  options: {
    pi: Pick<ExtensionAPI, "exec">;
    state?: LocalState;
    secretValues?: string[];
  }
): ProviderExecution {
  // V1 Railway
  if ("provider" in manifest && manifest.provider === "railway") {
    const creds = credentials as { provider: "railway"; apiToken?: string; projectToken?: string };
    const state = options.state;
    const adapter = createRailwayAdapter(options.pi, {
      apiToken: creds.apiToken,
      projectToken: creds.projectToken,
      projectId: state?.projectId,
      environmentId: state?.environmentId,
      serviceId: state?.serviceIds?.app,
      secretValues: options.secretValues,
    });
    return { contract: 1, provider: "railway", adapter };
  }
  // V2 Vercel — Phase 0 skeleton, real runtime in Task 4.4
  if ("version" in manifest && manifest.version === 2 && manifest.app.provider === "vercel") {
    throw err("E_PHASE_UNSUPPORTED", "Vercel runtime not yet implemented; will be available in Phase 1");
  }
  throw err("E_CONFIG_INVALID", "unsupported manifest provider/version");
}
```

**`ship-ops.ts` changes:**

- Add V2 manifest detection: if manifest has `version: 2` and `app.provider === "vercel"`, use V2 planner/engine
- Extend `shipOpsSchema` plan action: accept `environment: "preview" | "production"` for V2
- V1 Railway path unchanged

**`db-ops.ts` changes:**

- Detect V2 manifest, return `E_PHASE_UNSUPPORTED` for all V2 database actions

**`gate.ts` changes:**

- Add V2 plan detection for approval check

**Test cases for `ship-ops.test.ts`:**

1. `V1 manifest: plan action creates V1 plan with environment: production` — existing behavior
2. `V2 manifest with environment: preview uses V2 planner` — creates PlanV2 with 3 operations
3. `V2 manifest with environment: production uses V2 planner`
4. `V2 status returns E_PHASE_UNSUPPORTED (no runtime yet)`

**Test cases for `db-ops.test.ts`:**

1. `db_ops.inspect returns placeholder for V1 manifest`
2. `db_ops schema rejects unknown action`
3. `V2 database action returns E_PHASE_UNSUPPORTED`

**Test cases for `factory.test.ts`:**

1. `V1 railway manifest creates contract:1 ProviderExecution`
2. `V2 vercel manifest throws E_PHASE_UNSUPPORTED during Phase 0`
3. `unknown manifest throws E_CONFIG_INVALID`

- [ ] **Step 1: Write failing tests**

- [ ] **Step 2: Run RED**

Run: `npx vitest --run test/tools/ship-ops.test.ts test/tools/db-ops.test.ts test/providers/factory.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement V2 routing**

- [ ] **Step 4: Run GREEN**

Run: `npx vitest --run test/tools/ship-ops.test.ts test/tools/db-ops.test.ts test/providers/factory.test.ts`
Expected: 9 tests pass.

- [ ] **Step 5: Full regression**

Run: `npm test && npm run typecheck && npm run acceptance`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/tools/ship-ops.ts src/tools/db-ops.ts src/gate.ts src/index.ts \
  src/providers/factory.ts test/tools/ship-ops.test.ts test/tools/db-ops.test.ts \
  test/providers/factory.test.ts
git commit -m "feat: add V2 routing in ship-ops, db-ops, gate, and factory"
```

**Acceptance:** 9 tests pass. V1 Railway behavior unchanged. V2 routes correctly. Factory produces correct execution type.

---

## Stage 3 — Phase 0 Full Verification

**Full checks:**

```bash
npm test
npm run typecheck
npm run acceptance
git diff --check
```

Expected: All exit 0. No staged files.

**V1 digest regression:**

```bash
npx vitest --run test/fixtures/generate-v1-fixture.test.ts
```

Expected: PASS with same `planDigest` as fixture file.

---

## Stage 4 — Phase 1: Vercel Provider

### Task 4.1: Vercel HTTP client with fake fetch

**Files:**
- Create: `src/providers/vercel/types.ts` — Vercel response Typebox schemas
- Create: `src/providers/vercel/client.ts` — HTTP client
- Create: `test/providers/vercel-client.test.ts`

**`vercel/types.ts` — response schemas (refreshed endpoint paths):**

```ts
import { Type, type Static } from "typebox";

// GET /v2/user response
export const VercelUserResponseSchema = Type.Object({
  user: Type.Object({
    id: Type.String(),
    email: Type.String(),
    username: Type.String(),
    defaultTeamId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  }, { additionalProperties: true }),
}, { additionalProperties: true });

// POST /v11/projects and GET /v10/projects/{name} response
export const VercelProjectSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  accountId: Type.Optional(Type.String()),
}, { additionalProperties: true });

// POST /v10/projects/{name}/env?upsert=true response (201)
export const VercelEnvUpsertResponseSchema = Type.Object({
  created: Type.Optional(Type.Union([Type.Array(Type.Unknown()), Type.Unknown()])),
  failed: Type.Optional(Type.Array(Type.Object({
    error: Type.Object({
      code: Type.String(),
      message: Type.String(),
    }, { additionalProperties: true }),
  }, { additionalProperties: true }))),
}, { additionalProperties: true });

// POST /v2/files response
export const VercelFileUploadResponseSchema = Type.Object({
  urls: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: true });

// POST /v13/deployments and GET /v13/deployments/{id} response
export const VercelDeploymentSchema = Type.Object({
  id: Type.String(),
  url: Type.Optional(Type.String()),
  readyState: Type.Union([
    Type.Literal("QUEUED"), Type.Literal("INITIALIZING"),
    Type.Literal("BUILDING"), Type.Literal("READY"),
    Type.Literal("ERROR"), Type.Literal("CANCELED"),
    Type.Literal("BLOCKED"),
  ]),
  projectId: Type.Optional(Type.String()),
  meta: Type.Optional(Type.Record(Type.String(), Type.String())),
  target: Type.Optional(Type.Union([
    Type.Literal("production"), Type.Literal("staging"), Type.Null(),
  ])),
  errorMessage: Type.Optional(Type.Union([Type.String(), Type.Null()])),
}, { additionalProperties: true });

// GET /v3/deployments/{id}/events response
export const VercelBuildEventSchema = Type.Object({
  type: Type.String(),
  created: Type.Optional(Type.Number()),
  payload: Type.Object({
    text: Type.Optional(Type.String()),
    deploymentId: Type.Optional(Type.String()),
  }, { additionalProperties: true }),
}, { additionalProperties: true });

// GET /v1/projects/{pid}/deployments/{did}/runtime-logs response
export const VercelRuntimeLogSchema = Type.Object({
  level: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  timestampInMs: Type.Optional(Type.Number()),
  source: Type.Optional(Type.String()),
}, { additionalProperties: true });

export type VercelUserResponse = Static<typeof VercelUserResponseSchema>;
export type VercelProject = Static<typeof VercelProjectSchema>;
export type VercelDeployment = Static<typeof VercelDeploymentSchema>;
export type VercelBuildEvent = Static<typeof VercelBuildEventSchema>;
export type VercelRuntimeLog = Static<typeof VercelRuntimeLogSchema>;
```

**`vercel/client.ts` interfaces:**

```ts
export interface VercelClientOptions {
  token: string;
  teamId?: string;
  fetchImpl?: typeof fetch;
}

export interface VercelClient {
  checkAuth(signal?: AbortSignal): Promise<VercelUserResponse>;
  discoverProject(name: string, signal?: AbortSignal): Promise<VercelProject | null>;
  createProject(name: string, signal?: AbortSignal): Promise<VercelProject>;
  upsertSecrets(
    projectName: string,
    entries: Array<{ key: string; value: string; target: ("production" | "preview")[] }>,
    signal?: AbortSignal
  ): Promise<void>;
  uploadFile(sha1: string, content: Uint8Array, signal?: AbortSignal): Promise<void>;
  createDeployment(body: Record<string, unknown>, signal?: AbortSignal): Promise<VercelDeployment>;
  getDeployment(id: string, signal?: AbortSignal): Promise<VercelDeployment>;
  getBuildEvents(deploymentId: string, signal?: AbortSignal): Promise<VercelBuildEvent[]>;
  getRuntimeLogs(projectId: string, deploymentId: string, signal?: AbortSignal): Promise<VercelRuntimeLog[]>;
  cancelDeployment(id: string, signal?: AbortSignal): Promise<VercelDeployment>;
  rollback(projectId: string, deploymentId: string, signal?: AbortSignal): Promise<void>;
}
```

**Endpoint paths (from refreshed research, resolving conflicts with prior research):**

| Operation | Method | Path |
|-----------|--------|------|
| Auth check | GET | `/v2/user` |
| Project discover | GET | `/v10/projects/{encodedName}` |
| Project create | POST | `/v11/projects` |
| Env upsert | POST | `/v10/projects/{encodedName}/env?upsert=true` |
| File upload | POST | `/v2/files` |
| Deploy create | POST | `/v13/deployments` |
| Deploy status | GET | `/v13/deployments/{id}` |
| Build events | GET | `/v3/deployments/{id}/events` |
| Runtime logs | GET | `/v1/projects/{pid}/deployments/{did}/runtime-logs` |
| Cancel deploy | PATCH | `/v12/deployments/{id}/cancel` |
| Rollback | POST | `/v1/projects/{pid}/rollback/{did}` |

All requests: `Authorization: Bearer {token}`, append `?teamId={teamId}` when configured.

File upload: `Content-Type: application/octet-stream`, header `x-vercel-digest: {sha1}`.

**Error mapping:**

| Condition | Result |
|-----------|--------|
| Missing token | `E_AUTH_MISSING` |
| HTTP 401/403 | `E_AUTH_MISSING` |
| HTTP 429 | Retryable `E_PROVIDER` (expose Retry-After if present) |
| HTTP 5xx / transport | Retryable `E_PROVIDER` for reads |
| Other 4xx | Non-retryable `E_PROVIDER` |
| Malformed JSON | `E_PROVIDER` |
| Aborted before dispatch | `E_CANCELLED` |
| Aborted after dispatch | `E_PROVIDER` + reconciliation |

**Test cases (18 total):**

1. `checkAuth: 200 returns user data, attaches Bearer header and teamId`
2. `checkAuth: 401 throws E_AUTH_MISSING`
3. `discoverProject: 200 returns project`
4. `discoverProject: 404 returns null (verified absent)`
5. `discoverProject: 500 throws retryable E_PROVIDER`
6. `createProject: 200 returns project with id and name`
7. `upsertSecrets: 201 succeeds, body has type: "sensitive" and correct target`
8. `upsertSecrets: 429 throws retryable E_PROVIDER`
9. `uploadFile: 200 succeeds, sends x-vercel-digest header with SHA-1`
10. `createDeployment: 200 returns deployment with id and readyState`
11. `createDeployment: body includes meta.piShipOperationId`
12. `getDeployment: 200 returns deployment`
13. `getBuildEvents: 200 returns events array — uses /v3 path`
14. `getRuntimeLogs: 200 returns logs array — uses /v1/projects/{pid}/deployments/{did}/runtime-logs path`
15. `cancelDeployment: 200 returns deployment — uses PATCH /v12 path`
16. `rollback: 201 succeeds — uses POST /v1/projects/{pid}/rollback/{did} path`
17. `transport error throws retryable E_PROVIDER`
18. `abort before dispatch throws E_CANCELLED`

Each test uses fake `fetch` that returns crafted Response objects and captures request URL/headers/body for assertion.

- [ ] **Step 1: Write tests** (full code for each test case)

- [ ] **Step 2: Run RED**

Run: `npx vitest --run test/providers/vercel-client.test.ts`
Expected: FAIL — files don't exist.

- [ ] **Step 3: Implement `src/providers/vercel/types.ts` and `src/providers/vercel/client.ts`**

- [ ] **Step 4: Run GREEN**

Run: `npx vitest --run test/providers/vercel-client.test.ts`
Expected: 18 tests pass.

- [ ] **Step 5: Full regression**

Run: `npm test && npm run typecheck`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/providers/vercel/types.ts src/providers/vercel/client.ts test/providers/vercel-client.test.ts
git commit -m "feat: add Vercel HTTP client with injectable fetch and response validation"
```

**Acceptance:** 18 tests pass. All endpoints use refreshed paths. Error mapping verified. No live calls.

---

### Task 4.2: Vercel source file enumeration and upload

**Files:**
- Create: `src/providers/vercel/source.ts`
- Create: `test/providers/vercel-source.test.ts`

**`source.ts` interfaces:**

```ts
export interface SourceFile {
  path: string;       // relative POSIX path
  sha1: string;       // lowercase 40-char hex
  size: number;
}

export interface LocalSourceRef {
  kind: "local-files";
  rootDirectory: string;
  fileCount: number;
  totalBytes: number;
  fingerprint: string;  // sha256 over canonical sorted {path, sha1, size}
}

export async function enumerateSourceFiles(cwd: string, rootDirectory: string): Promise<SourceFile[]>;
// Uses: git ls-files -z --cached --others --exclude-standard -- <root>
// Rejects: symlink, non-regular, path escape, .git/**, .pi-ship/**, .env, .env.*
// Rejects: empty source, >10000 files, >100MiB/file, >250MiB total
// Sorts by normalized relative POSIX path

export function computeSourceRef(files: SourceFile[]): LocalSourceRef;

export async function verifySourceFreshness(
  cwd: string,
  rootDirectory: string,
  expected: LocalSourceRef
): Promise<void>;
// Re-enumerates, compares fingerprint. Difference → E_PLAN_STALE

export async function uploadSourceFiles(
  client: VercelClient,
  cwd: string,
  files: SourceFile[],
  options?: { concurrency?: number; signal?: AbortSignal }
): Promise<void>;
// Uploads sequentially or max concurrency 4. Honors cancellation.
```

SHA-1 computation: `createHash("sha1").update(fileBytes).digest("hex")`.
Source fingerprint: `sha256(JSON.stringify(sorted([{path, sha1, size}])))`.

**Test cases (11 total):**

1. `enumerates tracked and untracked files from git repo`
2. `rejects symlink in source tree`
3. `rejects .git directory files`
4. `rejects .env files`
5. `rejects path with ..`
6. `rejects empty source`
7. `rejects file exceeding single-file limit`
8. `fingerprint is deterministic SHA-256`
9. `verifySourceFreshness passes when unchanged`
10. `verifySourceFreshness throws E_PLAN_STALE when files changed`
11. `uploadSourceFiles calls client.uploadFile for each file with correct SHA-1`

- [ ] **Step 1: Write tests**

- [ ] **Step 2: Run RED**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run GREEN**

Expected: 11 tests pass.

- [ ] **Step 5: Full regression**

Run: `npm test && npm run typecheck`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/providers/vercel/source.ts test/providers/vercel-source.test.ts
git commit -m "feat: add Vercel source enumeration, validation, and upload"
```

**Acceptance:** 11 tests pass. Symlink/env/escape rejection verified.

---

### Task 4.3: Vercel AppOperationRuntime

**Files:**
- Create: `src/providers/vercel/runtime.ts`
- Create: `test/providers/vercel-runtime.test.ts`

**`runtime.ts` interfaces:**

```ts
import type { AppOperationRuntime } from "../../core/types.js";
import type { VercelClient } from "./client.js";
import type { VercelOperation, LocalSourceRef, PlanV2 } from "../../core/plan-v2.js";
import type {
  VercelProjectSnapshot, AccountRef, Verification, ReconciliationState, OperationResult,
} from "../../core/types.js";

export interface VercelStatus {
  readyState: string;
  url?: string;
  errorMessage?: string;
}

export interface VercelLogs {
  lines: string[];
  truncated: boolean;
}

export function createVercelRuntime(
  client: VercelClient,
  options: { secretValues: Record<string, string> }
): AppOperationRuntime<VercelProjectSnapshot, VercelOperation, VercelStatus, VercelLogs>;
```

Runtime implements full `AppOperationRuntime` contract:
- `descriptor`: `{ domain: "app", provider: "vercel", capabilities: ["discover", "write_secrets", "deploy", "status", "logs", "rollback"] }`
- `checkAuth`: calls `client.checkAuth()`, extracts user.id and defaultTeamId, returns `Verification<AccountRef>`
- `discover`: calls `client.discoverProject()`, returns `Verification<VercelProjectSnapshot>` — `presence: "present"` or `presence: "absent"`
- `plan`: builds VercelOperation list for deploy (3 ops) or rollback (1 op)
- `execute`: dispatches by operation.kind to appropriate client method
  - `ensure_project`: client.discoverProject → if absent, client.createProject
  - `upsert_secrets`: client.upsertSecrets with type: "sensitive"
  - `deploy`: (upload handled separately) client.createDeployment
  - `rollback`: client.rollback
- `reconcile`: client.getDeployment list filtered by `meta.piShipOperationId` and `meta.piShipRequestFingerprint`
  - Exact match → `matches_expected`
  - Missing/malformed → `unverified`
- `status`: client.getDeployment, maps readyState
- `logs`: client.getBuildEvents + client.getRuntimeLogs, redacts secret values, bounds to 4000 chars / requested lines

**Test cases (15 total):**

1. `checkAuth returns verified AccountRef on 200`
2. `checkAuth returns unverified on 401`
3. `discover returns present when project found`
4. `discover returns absent when 404`
5. `plan deploy returns 3 operations`
6. `plan rollback returns 1 operation`
7. `execute ensure_project calls createProject when absent`
8. `execute upsert_secrets calls client.upsertSecrets with type: sensitive`
9. `execute deploy calls createDeployment with correct body shape`
10. `execute rollback calls client.rollback`
11. `reconcile finds matching deployment by metadata`
12. `reconcile returns unverified when metadata missing`
13. `status maps readyState to VercelStatus`
14. `logs combines build events and runtime logs, bounds length to 4000 chars`
15. `logs clamps requested lines to 1..500`

- [ ] **Step 1: Write tests**

- [ ] **Step 2: Run RED**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run GREEN**

Expected: 15 tests pass.

- [ ] **Step 5: Full regression**

Run: `npm test && npm run typecheck && npm run acceptance`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/providers/vercel/runtime.ts test/providers/vercel-runtime.test.ts
git commit -m "feat: add Vercel AppOperationRuntime implementation"
```

**Acceptance:** 15 tests pass. Full AppOperationRuntime contract. Secret redaction verified.

---

### Task 4.4: Wire Vercel runtime into factory

**Files:**
- Modify: `src/providers/factory.ts`
- Modify: `test/providers/factory.test.ts`

**Changes:**

Replace `E_PHASE_UNSUPPORTED` for V2 vercel manifests with actual `createVercelRuntime()` call.

```ts
// In factory.ts, replace the Vercel branch:
if ("version" in manifest && manifest.version === 2 && manifest.app.provider === "vercel") {
  const creds = credentials as { provider: "vercel"; token?: string };
  if (!creds.token) throw err("E_AUTH_MISSING", "VERCEL_TOKEN required for Vercel deployments");
  const { createVercelRuntime } = await import("./vercel/runtime.js");
  const { createVercelClient } = await import("./vercel/client.js");
  const client = createVercelClient({ token: creds.token });
  const runtime = createVercelRuntime(client, {
    secretValues: options.secretValues
      ? Object.fromEntries(options.secretValues.map((v) => [v, v]))
      : {},
  });
  return { contract: 2, provider: "vercel", runtime };
}
```

**Additional test cases:**

1. `V2 vercel manifest creates contract:2 ProviderExecution with runtime`
2. `Vercel runtime receives only VERCEL_TOKEN, not railway tokens` — verify credential scoping
3. `Vercel runtime descriptor has provider: "vercel"`

- [ ] **Step 1: Write failing tests**

- [ ] **Step 2: Run RED**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run GREEN**

Run: `npx vitest --run test/providers/factory.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Full regression**

Run: `npm test && npm run typecheck`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/providers/factory.ts test/providers/factory.test.ts
git commit -m "feat: wire Vercel runtime into provider factory"
```

**Acceptance:** Factory creates Vercel execution. Credential isolation verified.

---

## Stage 5 — Phase 1: Vercel Acceptance

### Task 5.1: Vercel cloud-free acceptance test

**Files:**
- Create: `test/acceptance-vercel.e2e.test.ts`

**Test cases (6 total):**

1. `preview deploy lifecycle: discover → plan → approve → execute → status` — fake Vercel runtime, verify all operations called in order
2. `production deploy lifecycle with rollback` — deploy production, then rollback
3. `ambiguous deploy reconciliation` — first deploy returns ambiguous, reconcile finds match → success
4. `token isolation: vercel runtime never sees railway tokens` — verify credential scoping through factory
5. `secret values never appear in tool results` — deploy with secrets, check redaction in output
6. `headless production deploy denied` — no UI → `approved: false`

Each test:
- Creates temp git repo with files
- Creates V2 vercel manifest
- Uses fake VercelClient (or fake AppOperationRuntime)
- Runs through V2 engine
- Verifies final state, journal entries, and tool results

- [ ] **Step 1: Write tests**

- [ ] **Step 2: Run RED**

- [ ] **Step 3: Ensure all Phase 1 pieces connected**

- [ ] **Step 4: Run GREEN**

Expected: 6 tests pass.

- [ ] **Step 5: Full verification**

```bash
npm test
npm run typecheck
npm run acceptance
git diff --check
```

Expected: All exit 0.

- [ ] **Step 6: Commit**

```bash
git add test/acceptance-vercel.e2e.test.ts
git commit -m "test: add cloud-free Vercel acceptance lifecycle tests"
```

**Acceptance:** 6 tests pass. Preview, production, rollback, reconciliation, token isolation, redaction verified.

---

### Task 5.2: Update acceptance script

**Files:**
- Modify: `scripts/acceptance.mjs`

**Changes:**

Add Vercel acceptance to script after Railway acceptance:

```js
const result2 = spawnSync("npx", ["vitest", "--run", "test/acceptance-vercel.e2e.test.ts"], {
  stdio: "inherit",
  env: { ...process.env, VERCEL_TOKEN: "" },
});
if (result2.status !== 0) process.exit(result2.status ?? 1);
console.log("PASS cloud-free Vercel acceptance lifecycle");
```

- [ ] **Step 1: Modify script**

- [ ] **Step 2: Run**

Run: `npm run acceptance`
Expected: Both Railway and Vercel acceptance pass.

- [ ] **Step 3: Commit**

```bash
git add scripts/acceptance.mjs
git commit -m "chore: add Vercel acceptance to acceptance script"
```

---

## Stage 6 — Final Verification

**Full checks:**

```bash
npm test
npm run typecheck
npm run acceptance
git diff --check
```

Expected: All exit 0.

**V1 digest regression:**

```bash
npx vitest --run test/fixtures/generate-v1-fixture.test.ts
```

Expected: PASS with same `planDigest` as fixture file.

---

## Dependencies

```
Task 0.1 (fixture)       → standalone
Task 1.1 (engine tests)  → standalone (characterization)
Task 1.2 (gate tests)    → standalone
Task 1.3 (index tests)   → standalone
Task 1.4 (plan-store)    → standalone
Task 2.1 (V2 types)      → standalone
Task 2.2 (ManifestV2)    → after 2.1
Task 2.3 (PlanV2)        → after 2.1, 2.2
Task 2.4 (StateV2)       → after 2.1
Task 2.5 (journal)       → after 2.1
Task 2.6 (credentials)   → after 2.1
Task 2.7 (approval)      → after 2.1, 2.2, 2.3
Task 2.8 (engine-v2)     → after 2.1–2.7
Task 2.9 (tool/gate V2)  → after 2.8
Task 4.1 (Vercel client) → after 2.1 (types); parallel to 2.3–2.9
Task 4.2 (source)        → after 4.1
Task 4.3 (runtime)       → after 4.1, 4.2
Task 4.4 (factory)       → after 4.3
Task 5.1 (acceptance)    → after 2.9, 4.4
Task 5.2 (script)        → after 5.1
```

**Worker assignment:**
- Tasks 0.1, 1.1–1.4, 2.1–2.9: **shared-core worker**
- Tasks 4.1–4.4: **provider worker** (can start 4.1 in parallel with 2.3+)
- Tasks 5.1–5.2: **integration worker** (after both complete)

## Risks

1. **`isToolCallEventType` compatibility in gate tests (Task 1.2):** The type-guard from `pi-coding-agent` may require specific event shape. Mock events may need adaptation. Mitigation: investigate guard's expected shape first; if incompatible, test gate logic through extracted function.

2. **Vercel runtime logs pagination undocumented (Task 4.1):** Refreshed research confirms no `limit`/`since`/`until` query params. Client tests should use raw response. Risk: actual API may paginate differently. Mitigation: tests validate raw response shape only.

3. **Rollback response body undocumented (Task 4.1):** Tests assume 201 with empty body. If Vercel returns deployment object, response validation needs adjustment. Mitigation: client accepts both empty and object responses for 201.

4. **Retry-After header not confirmed (Task 4.1):** Client implements exponential backoff with jitter as fallback. Tests verify both with and without header.

5. **`git ls-files` platform differences (Task 4.2):** Source enumeration uses `git ls-files -z`. Tests must ensure git available and temp repos have correct .gitignore.

6. **Hash chain detects accidental corruption only (Task 2.5):** Operation journal chain catches corruption but not malicious truncation. Documented limitation.

7. **Typebox `additionalProperties: false` with unions (Task 2.2):** Verify `Type.Union` + `additionalProperties: false` works correctly with `typebox@1.1.38`. May need `Type.Strict()` wrapper.

8. **V1 journal fail-closed change (Task 2.5):** Existing V1 entries previously silently skipped will now throw. Verify no CI/CD relies on skip-on-corruption behavior.

---

## Execution corrections (override draft)

These corrections apply across Stages 0–2. The shared-core worker implements these as the contract; downstream provider work (Stages 4–5) inherits the same constraints.

### C-1. V1 compatibility

- V1 manifest, Plan, and LocalState shapes remain byte-compatible. No field added/removed/renamed.
- V1 `computeDigest` algorithm and `canonicalize()` key ordering remain identical. Re-running `buildPlan` over an existing approved plan yields the same `planDigest`.
- Add a **hardcoded regression digest** test: a fixed `(manifest, git state, planId, createdAt)` triple produces a literal expected 64-char SHA-256 hex captured in a constant. Any refactor that perturbs the digest fails the test.

### C-2. Persisted V1/V2 at single `.pi-ship/state.json`

- V1 and V2 states are written to the **same** `.pi-ship/state.json` file using a strict version-discriminated Typebox union.
- No `.pi-ship/state-v2.json` file is created.
- `loadState(cwd)` returns a version-discriminated union. V1 reads must never silently rewrite or migrate the file. V2 reads do not rewrite V1.
- Opposite version/provider conflict (`Vercel manifest + persisted V1` or `Railway manifest + persisted V2`) throws `E_STATE_CONFLICT` and never alters the file.

### C-3. Strict persisted plan validation

- `loadPlan` and a new `loadPlanV2` strictly validate the full plan using Typebox with `additionalProperties: false` at every nested object, including `targetSnapshot`, `resourceActions`, `manifest`, and operation payloads.
- Loaded plans must satisfy: type validation, plan file `planId` matches the request `planId` argument.
- Validation failures throw `E_CONFIG_INVALID` and never fall through to `parsed as Plan` casting.

### C-4. Unified manifest loader

- Single `loadManifest(cwd)` returns a discriminated union of `ManifestV1 | ManifestV2`.
- Loader first attempts V1 shape; on mismatch it attempts V2 shape. Both attempts use the same strict Typebox validators.
- `Manifest` type alias is the discriminated union; existing call sites continue to work because V1 shape is unchanged.
- `rootDirectory` (V2 only) is normalized: rejects `..`, backslash, NUL, leading `/`, empty segments. No `path.resolve` is used; only string checks plus `posix.normalize` round-trip.

### C-5. Typed app runtime contracts

- `AppOperationRuntime` is fully typed across `TSnapshot`, `TOperation`, `TStatus`, `TLogs`.
- No `any`. The `plan` method returns `Verification<readonly TOperation[]>`, never a generic `any[]`.
- Helper factories `verified()` and `unverified()` are exported with concrete literal return types.
- Provider-specific runtime types (e.g., `VercelProjectSnapshot`, `VercelOperation`, `VercelStatus`, `VercelLogs`) live in the runtime module and are imported by the engine.

### C-6. Operation journal

- `OperationJournalEntrySchema` is a strict Typebox discriminated union of five object variants: `start`, `ok`, `fail`, `ambiguous`, `reconciled`. Every variant has `additionalProperties: false`.
- `readOperationJournal` parses the **entire physical file first**, validates schema and hash chain, then filters by `planId` (if supplied). A malformed line anywhere in the file throws `E_STATE_CONFLICT`, even if the filter would have excluded it.
- V1 `readJournal` is also fail-closed: malformed lines now throw `E_STATE_CONFLICT` instead of being silently skipped.
- The journal is never the sole authorization for destructive resume. The V2 engine reconciles via the runtime.

### C-7. V2 engine authorization and reconciliation

- `applyPlanV2` performs, in order:
  1. `computeDigest`/supplied digest match,
  2. approval registry check,
  3. plan staleness check,
  4. manifest match against persisted,
  5. target fingerprint check against live snapshot.
- For each operation, consult the journal: `ok` with matching fingerprints → skip with reconciled log; `start` or `ambiguous` → reconcile first; `reconciled.matches_expected` → skip; `reconciled.not_applied` → retry; `reconciled.conflict` or `unverified` → block with `E_STATE_CONFLICT`.
- Successful operations append `start` then `ok`; failures append `start` then `fail`; ambiguous results append `start` then `ambiguous` and reconcile.
- StateV2 (`releases`, `history`, environments) is updated incrementally; never rewritten in full after a single operation.
- `db_ops` V2 actions return `E_PHASE_UNSUPPORTED`. `ship_ops` V2 actions validate the V2 manifest shape and may also return `E_PHASE_UNSUPPORTED` for any provider call until Phase 1.

### C-8. Factory and credentials

- `createProviderExecution(manifest, credentials, options)` is **synchronous** and fully typed. No `await`/dynamic import in the hot path.
- `loadProviderCredentials(provider, source)` accepts an injected `CredentialSource` interface, never reads `process.env` directly.
- Each branch reads only its allowlisted names: `railway` reads `RAILWAY_API_TOKEN` and `RAILWAY_TOKEN`; `vercel` reads only `VERCEL_TOKEN`. Unknown providers throw `E_CONFIG_INVALID`.
- The factory never receives `process.env`. The CLI `acceptance.mjs` env scrub continues to apply.

### C-9. Approval rendering

- `renderPlanSummary(plan)` is exported and used by both V1 and V2 paths.
- V1 summary is enriched with provider literal, project/environment/service IDs, and a target fingerprint derived from the bound `targetSnapshot`.
- `renderPlanSummaryV2(planV2)` shows provider, account, project (with observedId when present), environment, target/source fingerprints, operation list with reversibility, secret names only (never values), and impact.
- Both summaries redact secret values before returning to the UI.

### C-10. Characterization tests before refactor

- Add the following characterization tests **before** any V2 surface is integrated:
  - `test/core/engine.test.ts` (engine preflight, authorization, missing secrets, dangling journal, already-applied skip, abort, auth failure),
  - `test/tools/ship-ops.test.ts` (schema, V1 plan/apply path),
  - `test/tools/db-ops.test.ts` (schema, V1 plan_migration path),
  - `test/gate.test.ts` (gate approval blocks),
  - `test/index.test.ts` (extension registration).
- These tests describe existing V1 behavior. They must pass before any V2 routing is added.

### C-11. Phase 0 boundaries

- Phase 0 may validate a V2 manifest and produce an `E_PHASE_UNSUPPORTED` tool result for any V2 provider call. The runtime factory returns an error before any HTTP call.
- V1 actions, commands, and tool results remain unchanged. The V1 Railway engine and adapter remain the only mutating code path.
- No Vercel HTTP, source enumeration, or runtime file in Phase 0. Provider worker owns those.
- No `@vercel/sdk`, no new dependencies, no `process.env` injection into the factory.

### C-12. Reviewer flags

- Typebox version (`1.1.38`) does not always enforce `additionalProperties: false` through union composition. Where the draft suggests `Type.Union` + `additionalProperties: false` without `Type.Strict()`, prefer wrapping each object literal with `Type.Object(..., { additionalProperties: false })` and using `Type.Intersect` for discriminator overlays. The implementation in `manifest-v2.ts` already does this; the same approach applies to operation journal variants.
- The V1 `readJournal` change to fail-closed may break any future extension that relied on skip-on-corruption. Document this as a behavior change in `docs/`.
