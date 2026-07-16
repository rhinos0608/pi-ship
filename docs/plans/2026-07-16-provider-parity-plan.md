# Provider Parity Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close approved Vercel, Cloudflare, Neon, Railway, command-registration, acceptance, and capability-matrix gaps while retaining vendor-specific boundaries.

**Architecture:** Part 1 (`2026-07-16-provider-scoped-tool-surfaces-plan.md`) supplies selected immutable `ProviderRuntimeBinding` and `ProviderCapabilityProfile`. This plan fixes provider behavior behind those profiles. It adds no new provider command, tool action, dependency, or persisted format.

**Tech Stack:** TypeScript, TypeBox, Vitest, injected fetch/adapter fakes, Node.js test filesystem.

## Global Constraints

- Depends on Part 1 binding/profile exports, but every task below is independently reviewable.
- Keep tool names, action names, persisted plan/state/journal/approval formats, and dependencies unchanged. Preserve production rollback plan requiring `targetReleaseId` for Railway, Vercel, Cloudflare, and Neon; Neon continues resolving it to owned restore point.
- No Neon logs. No Cloudflare DB-provider handler/operations. No fake provider commands.
- Do not force Railway planning online; validation and metadata-only planning remain usable without Railway token.
- Register commands only for selected provider; Railway remains sole command provider. Part 1 wrapper permits only declared profile command names and calls `assertIntact(ctx.cwd)` exactly once at command-dispatch top.
- Preserve broad public schemas and direct `registerShip`/`registerDB`/three-argument `executeApprovedOperation` behavior; default extension alone supplies narrowed immutable binding.
- All cloud-free tests inject fakes and reject native network.
- Keep vendor/architecture differences. Parity means consistent safety/contract handling, not identical backend behavior.
- No commits.

---

## File Structure

- `src/providers/vercel/package.ts` — install Vercel semantic validator at manifest load.
- `src/providers/vercel/manifest.ts` — existing semantic validator; no schema format change.
- `src/providers/cloudflare/ship-ops.ts` — bound requested log lines forwarding.
- `src/providers/neon/authorization.ts` — current manifest/project/branch authorization checks.
- `src/providers/neon/{ship-ops,db-ops,engine}.ts` — pass current manifest/state to Neon authorizer before adapter mutation.
- `src/providers/railway/credentials.ts` — nonthrowing load plus execution-only require helper.
- `src/providers/railway/package.ts` and `src/providers/railway/commands.ts` — require token only when creating execution adapter.
- `src/index.ts` / Part 1 registration seam — selected command registration assertion only; no new commands.
- `test/providers/vercel/manifest.test.ts`, `test/providers/registry.test.ts` — Vercel startup semantics.
- `test/providers/cloudflare/ship-ops.test.ts` — new log forwarding unit coverage.
- `test/providers/neon/{authorization,engine,adapter}.test.ts` — current-binding authorization coverage.
- `test/providers/railway/{adapter,cli}.test.ts`, `test/tools/ship/index.test.ts` — credential behavior.
- `test/index.test.ts` — selected command registration.
- `test/acceptance/cloudflare.e2e.test.ts` — new cloud-free Workers lifecycle.
- `test/acceptance/neon.e2e.test.ts` — new cloud-free Neon lifecycle.
- `test/providers/capability-profile.test.ts` and `test/docs/provider-capability-matrix.test.ts` — Part 1 executable capability matrix.
- `scripts/acceptance.mjs` — explicit list must add Cloudflare and Neon acceptance files.

## Interfaces

Part 1 supplies:

```ts
interface ProviderRuntimeBinding {
  readonly manifest: unknown | undefined;
  readonly package: ProviderPackage | undefined;
  readonly profile: ProviderCapabilityProfile;
  assertIntact(runtimeCwd: string): Promise<void>;
}
```

Extend Neon authorization context only; do not alter `NeonPlan` or `NeonState` schema:

```ts
export interface NeonAuthorizationContext {
  registry: ApprovalRegistry;
  cwd: string;
  plan: NeonPlan;
  suppliedDigest: string;
  manifest: NeonManifest;
  state: NeonState;
  signal?: AbortSignal;
  now?: number;
}
```

Add execution-only Railway helper:

```ts
export function requireRailwayCredentials(
  source: CredentialSource,
): ProviderCredentials & { apiToken: string };
```

It accepts either `RAILWAY_API_TOKEN` or `RAILWAY_TOKEN`; when neither exists it throws `err("E_AUTH_MISSING", "RAILWAY_API_TOKEN or RAILWAY_TOKEN is required")`. `loadRailwayCredentials` remains nonthrowing.

## Tasks

### Task 1: Run Vercel semantic validation during startup binding

**Files:**
- Modify: `src/providers/vercel/package.ts`
- Modify: `test/providers/vercel/manifest.test.ts`
- Modify: `test/providers/registry.test.ts`

**Consumes:** `validateVercelManifestSemantics` in `src/providers/vercel/manifest.ts`; Part 1 binding calls package `validateManifest` exactly once.

**Produces:** Invalid Vercel semantics fail before tool/command registration or runtime creation.

- [ ] **Step 1: Write failing startup semantic tests.**

  Create temporary Vercel manifests structurally accepted by `VercelManifestSchema` but semantically invalid:

  ```ts
  const traversal = {
    version: 2,
    name: "app",
    app: { provider: "vercel", config: { projectName: "app", rootDirectory: "../outside" } },
  };
  const omittedSecret = {
    version: 2,
    name: "app",
    app: { provider: "vercel", config: { projectName: "app" } },
    database: { provider: "external", config: { urlSecretName: "DATABASE_URL" } },
    secrets: ["OTHER_SECRET"],
  };
  ```

  Assert `providerRegistry.loadManifest(cwd)` and Part 1 extension factory reject each with `E_CONFIG_INVALID`. Assert no fake fetch/runtime constructor ran.

- [ ] **Step 2: Run targeted tests; verify failure.**

  Run:

  ```bash
  npx vitest run test/providers/vercel/manifest.test.ts test/providers/registry.test.ts test/index.test.ts
  ```

  Expected: FAIL because `vercelPackage` omits `validateManifest` and semantic validation currently occurs only in ship handler/plan path.

- [ ] **Step 3: Add package hook.**

  In `src/providers/vercel/package.ts`, import `isVercelManifest`, `validateVercelManifestSemantics`, and Vercel manifest type. Add unknown-accepting package wrapper; direct assignment of narrower semantic validator does not satisfy `validateManifest?(manifest: unknown): void`:

  ```ts
  function validateVercelManifest(manifest: unknown): void {
    if (!isVercelManifest(manifest)) {
      throw err("E_CONFIG_INVALID", "Vercel manifest has invalid shape");
    }
    validateVercelManifestSemantics(manifest);
  }

  // package field
  validateManifest: validateVercelManifest,
  ```

  Do not duplicate semantic checks or change manifest schema. Startup binding owns call timing.

- [ ] **Step 4: Re-run targeted tests; verify pass.**

  Run:

  ```bash
  npx vitest run test/providers/vercel/manifest.test.ts test/providers/registry.test.ts test/index.test.ts
  ```

  Expected: PASS. Valid Vercel manifests retain current runtime validation defense in depth.

### Task 2: Forward bounded Cloudflare requested log lines

**Files:**
- Modify: `src/providers/cloudflare/ship-ops.ts`
- Create: `test/providers/cloudflare/ship-ops.test.ts`
- Modify: `test/providers/cloudflare/runtime.test.ts`

**Consumes:** `ShipInput` logs schema range `1..500`; Cloudflare runtime `logs(deploymentId, { lines, secretValues }, signal)`.

**Produces:** `ship.logs` sends user-requested bounded line count to Workers Tail runtime.

- [ ] **Step 1: Write failing log forwarding tests.**

  Use injected `RegistryServices.createExecution` with fake runtime. Persist one Cloudflare deployment and invoke handler with `{ action: "logs", lines: 1 }`, `{ action: "logs", lines: 500 }`, and `{ action: "logs" }`. Assert runtime receives `1`, `500`, and default `100`; assert secret values still pass and result remains redacted/spotlighted through tool wrapper.

- [ ] **Step 2: Run targeted tests; verify failure.**

  Run:

  ```bash
  npx vitest run test/providers/cloudflare/ship-ops.test.ts test/providers/cloudflare/runtime.test.ts
  ```

  Expected: FAIL because `logsAction` ignores `_params` and passes `{ lines: 100 }` always.

- [ ] **Step 3: Forward bounded input.**

  In `src/providers/cloudflare/ship-ops.ts`, rename `_params` to `params`; compute:

  ```ts
  const requested = params.lines;
  const bounded = requested !== undefined && Number.isFinite(requested)
    ? Math.min(Math.max(Math.floor(requested), 1), 500)
    : 100;
  ```

  Pass `{ lines: bounded, secretValues }`. Keep no-deployment behavior, Tail cleanup, secret loading, unverified response handling, and output truncation unchanged.

- [ ] **Step 4: Re-run targeted tests; verify pass.**

  Run:

  ```bash
  npx vitest run test/providers/cloudflare/ship-ops.test.ts test/providers/cloudflare/runtime.test.ts
  ```

  Expected: PASS. No historical-log claim or provider DB behavior added.

### Task 3: Bind Neon apply authorization to current manifest and target state

**Files:**
- Modify: `src/providers/neon/authorization.ts`
- Modify: `src/providers/neon/ship-ops.ts`
- Modify: `src/providers/neon/db-ops.ts`
- Modify: `src/providers/neon/engine.ts`
- Modify: `test/providers/neon/authorization.test.ts`
- Modify: `test/providers/neon/engine.test.ts`
- Modify: `test/providers/neon/adapter.test.ts`

**Consumes:** Existing digest/approval/staleness checks, `NeonPlan.manifest`, `NeonState.projectName`, `branchIds`, `restorePoints`, and current branch rule.

**Produces:** Authorization rejects changed manifest or current target mismatch before Neon adapter mutation, with no persisted shape change.

- [ ] **Step 1: Write failing current-binding tests.**

  Add tests asserting `authorizeNeonPlanApply` rejects before fake adapter call when:

  - canonical current manifest differs from `plan.manifest`;
  - `state.projectName` is absent for any non-provision intent, producing `E_STATE_CONFLICT`;
  - present `state.projectName !== manifest.project` for existing-target intents;
  - required base branch name (`manifest.branch?.name ?? manifest.project`) is absent from `state.branchIds` for migration/preview/rollback;
  - rollback `plan.targetBranchId` differs from current base branch ID;
  - rollback `plan.sourceBranchId` or `plan.restoreTimestamp` has no matching current restore point for current project/target branch.

  Assert valid migration with matching current manifest/project/base branch passes. Assert provision with no project/branch remains valid only for `plan.intent === "provision"` and matching manifest. Preserve valid Neon production rollback plan with `targetReleaseId` resolving one owned restore point; reject only mismatched/missing owned point.

- [ ] **Step 2: Run targeted tests; verify failure.**

  Run:

  ```bash
  npx vitest run test/providers/neon/authorization.test.ts test/providers/neon/engine.test.ts test/providers/neon/adapter.test.ts
  ```

  Expected: FAIL because current authorizer checks digest, approval, and time only.

- [ ] **Step 3: Implement exact non-persistent binding rule.**

  In `authorizeNeonPlanApply`:

  1. Preserve digest, scoped approval, staleness, and abort checks.
  2. Require `canonicalize(ctx.plan.manifest) === canonicalize(ctx.manifest)`; otherwise throw `E_STATE_CONFLICT`.
  3. Derive `baseBranch = ctx.manifest.branch?.name ?? ctx.manifest.project`.
  4. For non-provision intents, first require `ctx.state.projectName` to be present; absence throws `E_STATE_CONFLICT` even though persisted state keeps field optional. Then require `ctx.state.projectName === ctx.manifest.project`, `ctx.state.projectId`, and `ctx.state.branchIds[baseBranch]`; mismatches throw `E_STATE_CONFLICT`. `E_PRECONDITION` remains only for intentionally unprovisioned provision flow.
  5. For preview, bind existing parent base branch; preview branch itself is created by apply and must not be required before apply.
  6. For rollback, require `plan.targetBranchId === state.branchIds[baseBranch]`, `plan.sourceBranchId` exists, and a restore point matches current `projectId`, current target branch ID, `plan.sourceBranchId`, and `plan.restoreTimestamp`. Reject mismatch before adapter call.

  Pass current `manifest` and loaded current `state` from Neon ship apply, DB migration apply, and `applyNeonPlan`. Remove duplicate/late checks only when equivalent authorizer check now precedes mutation; keep engine restore-point check as defense in depth.

  Document in comments/tests: a same-name base branch replaced with another ID between plan and apply cannot be proven was original plan target because plan lacks persisted target snapshot. This remains accepted out-of-scope risk.

- [ ] **Step 4: Re-run targeted tests; verify pass.**

  Run:

  ```bash
  npx vitest run test/providers/neon/authorization.test.ts test/providers/neon/engine.test.ts test/providers/neon/adapter.test.ts
  ```

  Expected: PASS. Valid provision/migration/preview/rollback flows retain vendor-specific behavior; mismatches fail before fake mutation.

### Task 4: Normalize Railway missing execution credentials without breaking offline actions

**Files:**
- Modify: `src/providers/railway/credentials.ts`
- Modify: `src/providers/railway/package.ts`
- Modify: `src/providers/railway/commands.ts`
- Modify: `test/providers/railway/adapter.test.ts`
- Modify: `test/providers/railway/cli.test.ts`
- Modify: `test/tools/ship/index.test.ts`
- Modify: `test/providers/registry.test.ts`

**Consumes:** Existing nonthrowing `loadRailwayCredentials`; factory creation only occurs for execution/status/logs, not Railway metadata plan building.

**Produces:** deterministic `E_AUTH_MISSING` at execution boundary; validate and offline plan behavior retained.

- [ ] **Step 1: Write failing credential behavior tests.**

  With credential source returning no Railway token, assert execution factory/status/logs/apply setup throws:

  ```ts
  expect(() => createProviderExecution(railwayManifest, options)).toThrow(
    expect.objectContaining({ code: "E_AUTH_MISSING" }),
  );
  ```

  Assert `ship.validate` still returns existing manifest missing-secret report and does not throw. Assert `ship.plan` creates metadata plan without Railway credential read, fake network, or forced `checkAuth`.

- [ ] **Step 2: Run targeted tests; verify failure.**

  Run:

  ```bash
  npx vitest run test/providers/railway/adapter.test.ts test/providers/railway/cli.test.ts test/tools/ship/index.test.ts test/providers/registry.test.ts
  ```

  Expected: FAIL because missing credentials are passed as undefined or an eager require breaks validation/planning.

- [ ] **Step 3: Add narrow require helper and use only execution path.**

  Keep `loadRailwayCredentials` unchanged. Add `requireRailwayCredentials` accepting either token variable and emitting one safe `E_AUTH_MISSING` message only when both absent. Use it in Railway package `createExecution` and command adapter creation path. Do not call it from `validateAction`, `planAction`, plan builder, manifest validation, or command metadata planning.

- [ ] **Step 4: Re-run targeted tests; verify pass.**

  Run:

  ```bash
  npx vitest run test/providers/railway/adapter.test.ts test/providers/railway/cli.test.ts test/tools/ship/index.test.ts test/providers/registry.test.ts
  ```

  Expected: PASS. Missing-secret validation report and offline planning stay intact.

### Task 5: Limit command registration to selected provider

**Files:**
- Modify: `test/index.test.ts`
- Modify: `src/index.ts` only if Part 1 selected-package registration needs correction

**Consumes:** Part 1 binding and Railway `profile.commands` list.

**Produces:** only selected Railway package registers its existing commands.

- [ ] **Step 1: Write failing command registration/drift tests.**

  Record `registerCommand` calls for local, Railway, Vercel, Cloudflare, and Neon temporary manifests. Assert exact six Railway names only for Railway; others empty. After Railway startup byte mutation, invoke captured command handler and assert `E_STATE_CONFLICT` before service/provider activity. For unmodified binding, assert command context `services.loadManifest()` returns startup manifest object without disk read, and state/plan service calls receive startup cwd even if command context supplies alternate cwd.

- [ ] **Step 2: Run test; verify failure.**

  Run:

  ```bash
  npx vitest run test/index.test.ts
  ```

  Expected: FAIL until Part 1 uses selected package only and wraps command dispatch with binding drift guard.

- [ ] **Step 3: Correct selected registration only.**

  Use `binding.package?.registerCommands(...)`, never `providerRegistry.registerCommands(...)` over all packages. Pass a wrapping registration API that permits only names in `binding.profile.commands`; undeclared name throws `E_CONFIG_INVALID`. Each accepted handler calls `await binding.assertIntact(ctx.cwd)` exactly once as first dispatch action, then invokes original handler. Pass selected command services whose `loadManifest` returns cached startup `binding.manifest` and never reads disk after guard; `loadState`, `saveState`, `loadPlan`, and `persistPlan` close over startup `binding.cwd`, not command `ctx.cwd`. Do not add `registerCommands` to Vercel, Cloudflare, or Neon. Preserve Railway command names and behavior.

- [ ] **Step 4: Re-run test; verify pass.**

  Run:

  ```bash
  npx vitest run test/index.test.ts
  ```

  Expected: PASS. No fake parity commands appear.

### Task 6: Add cloud-free Cloudflare and Neon integration/acceptance coverage

**Files:**
- Create: `test/acceptance/cloudflare.e2e.test.ts`
- Create: `test/acceptance/neon.e2e.test.ts`
- Modify: `scripts/acceptance.mjs`

**Consumes:** Existing `test/support/cloudflare-fake.ts`, injected `fetchImpl`, `RegistryServices.createExecution`, fake Neon adapter shape, temporary cwd/state, approval registry/UI.

**Produces:** full provider lifecycle coverage with live network forbidden.

- [ ] **Step 1: Write failing Cloudflare acceptance test.**

  Create temporary git cwd plus Cloudflare manifest/state. Set `vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("live fetch forbidden"))`. Register ship with injected fake fetch/client/runtime. Exercise validate, preview or production plan, approved apply, status, logs with `lines: 1`, and rollback if fake supports it. Assert native fetch untouched, fake receives credential auth, requested log bound is `1`, output redacts secret, and state/journal changes only through fake.

- [ ] **Step 2: Write failing Neon acceptance test.**

  Create temporary cwd/manifest/state and inject fake `NeonAdapter` through `RegistryServices.createExecution`; fake must record every mutation and never call native network. Exercise provision, migration, preview, rollback, then changed-manifest/current-branch mismatch rejection. Assert rejection happens before new fake mutation; connection values stay redacted; restore-point/current-state checks run.

- [ ] **Step 3: Run acceptance targets; verify failure.**

  Run:

  ```bash
  npx vitest run test/acceptance/cloudflare.e2e.test.ts test/acceptance/neon.e2e.test.ts
  ```

  Expected: FAIL until files/fake seams and parity fixes exist.

- [ ] **Step 4: Implement smallest seams required by prior tasks.**

  Use existing injected `fetchImpl`, fake Cloudflare client/runtime, and `RegistryServices.createExecution`; do not add remote credentials, live test accounts, dependency, log API, or DB-provider behavior. `scripts/acceptance.mjs` uses explicit Vitest paths, so add `test/acceptance/cloudflare.e2e.test.ts` and `test/acceptance/neon.e2e.test.ts` to its spawn argument list and update success label to name all five acceptance lifecycles.

- [ ] **Step 5: Re-run acceptance targets; verify pass.**

  Run:

  ```bash
  npx vitest run test/acceptance/cloudflare.e2e.test.ts test/acceptance/neon.e2e.test.ts
  ```

  Expected: PASS with native fetch rejected and no live cloud request.

### Task 7: Verify executable capability matrix and full project

**Files:**
- Modify: `test/providers/capability-profile.test.ts`
- Modify: `test/docs/provider-capability-matrix.test.ts`
- Modify: `docs/adr/0012-provider-scoped-tool-surfaces.md` only if table correction required

- [ ] **Step 1: Add matrix assertions.**

  Parse actual ADR capability-table rows into cells and compare exact expected capability tokens/expectations, not provider names only. Assert Railway row includes preview ID, production rollback `targetReleaseId`, migration, and six commands; Vercel/Cloudflare rows include production rollback `targetReleaseId`, no preview-ID allowance, and common DB; Neon row includes development, no logs, production rollback `targetReleaseId` plus owned restore-point resolution, and migration; local row contains DB-only eight-action set. Independently compare these tokens with profile declarations.

- [ ] **Step 2: Run matrix tests; verify pass.**

  Run:

  ```bash
  npx vitest run test/providers/capability-profile.test.ts test/docs/provider-capability-matrix.test.ts
  ```

  Expected: PASS; provider-name match alone is insufficient; capability-token loss, rollback omission, or stale documentation fails.

- [ ] **Step 3: Run full verification.**

  Run:

  ```bash
  npm run typecheck
  npm test
  npm run acceptance
  git diff --check
  ```

  Expected: PASS. No dependency lockfile, persisted-format fixture, fake command, Neon log, or Cloudflare provider-DB diff.

## Files to Modify

- `src/providers/vercel/package.ts` — semantic hook.
- `src/providers/cloudflare/ship-ops.ts` — bounded lines forwarding.
- `src/providers/neon/{authorization,ship-ops,db-ops,engine}.ts` — current binding authorization.
- `src/providers/railway/{credentials,package,commands}.ts` — execution-only missing-token normalization.
- `src/index.ts` — selected declared-command wrapper only if Part 1 needs correction.
- `scripts/acceptance.mjs` — add Cloudflare and Neon explicit acceptance paths.
- Tests and optional acceptance script listed above.

## New Files

- `test/providers/cloudflare/ship-ops.test.ts` — requested-lines forwarding.
- `test/acceptance/cloudflare.e2e.test.ts` — cloud-free Workers lifecycle.
- `test/acceptance/neon.e2e.test.ts` — cloud-free Neon lifecycle.

## Dependencies

```text
Part 1 profile/binding
  ├─ Task 1 Vercel startup semantics
  ├─ Task 2 Cloudflare lines forwarding
  ├─ Task 3 Neon binding authorization
  ├─ Task 4 Railway execution credentials
  └─ Task 5 selected command registration
      └─ Task 6 cloud-free acceptance coverage
          └─ Task 7 matrix/full verification
```

## Risks

- Neon plan has no plan-time target snapshot. Current manifest/project/base-branch and rollback-field comparisons prevent current mismatch, but same-name branch ID replacement between plan/apply cannot be proven without persisted format change. Out of scope.
- Cloudflare `lines` means bounded live Tail collection, not historical log retrieval.
- Eager Railway credential requirement would break valid validate/offline plan paths; keep require helper at execution factory boundary.
- Vercel semantic validation becomes startup failure by design; test no registration occurs after invalid present manifest.
- Command closures must enforce Part 1 canonical-cwd/manifest drift guard exactly once at dispatch top, not only registration selection.
- Vercel package hook must accept `unknown`; assigning narrower semantic validator directly fails TypeScript.
