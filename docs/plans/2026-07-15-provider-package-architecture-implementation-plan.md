# Provider Package Architecture Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace historical V1/V2 module layout with provider packages plus provider-neutral deployment kernel, preserving exact Railway behavior/digest and every persisted `version: 1 | 2` contract.

**Architecture:** `src/deployment/` owns provider-neutral verification, approval primitives, operation execution mechanics, and hash-chain mechanics. `src/providers/railway/` and `src/providers/vercel/` own provider manifests, plans, state schemas, authorization policies, execution/state projection, credentials, adapters, and tool/command handlers. `src/providers/registry.ts` owns catalog, manifest/plan/state dispatch, execution construction, and provider handler lookup; future provider adds one package definition plus one explicit registry entry.

**Tech Stack:** TypeScript ESM, TypeBox, Vitest, native fetch, Node fs/crypto, existing Pi extension API.

**Status:** Approved

## Global Constraints

- Preserve `pi-ship.json` shapes, stored plan/state/journal JSON shapes, `.pi-ship/state.json`, `.pi-ship/plans/<planId>.json`, `.pi-ship/journal.jsonl`, `.pi-ship/operation-journal.jsonl`, exact Railway V1 digest algorithm/output, tool schemas, tool text/details, error codes/messages, command names, and public `src/index.ts` exports.
- Persisted discriminators remain exact: Railway manifest/state `provider: "railway"`, Railway state `version: 1`; Vercel manifest/state/operation journal `version: 2` where currently stored; Vercel `provider: "vercel"`. File/module names must not contain `-v2`, `V1`, or `V2`.
- No source compatibility shims named `*-v2.ts`; delete every old `src/core/*-v2.ts` and old `test/**/*-v2.test.ts` after import migration.
- No new dependencies, database/schema migration, state path change, cloud mutation, unattended production apply, commit, or staged files.
- Do not weaken strict schemas. Generic deployment code receives provider-owned TypeBox schemas/validators; it must not replace current Vercel literals/enums with broad strings in persisted validation.
- Secret values remain only in memory; never plan/state/journal/log/tool-result content.
- Treat all pre-existing uncommitted files as user-owned. Use moves plus targeted import edits; do not reset, checkout, clean, or overwrite unrelated changes.
- Final required checks: `npm test`, `npm run typecheck`, `npm run acceptance`, `git diff --check`.

---

## Final File Tree

```text
src/
  core/
    approval-store.ts
    approval.ts
    errors.ts
    redact.ts
    types.ts
  deployment/
    credentials.ts
    contracts.ts
    operation-authorization.ts
    operation-engine.ts
    operation-journal.ts
  persistence/
    json.ts
    manifest-store.ts
    plan-store.ts
    state-store.ts
  providers/
    contracts.ts
    registry.ts
    railway/
      adapter.ts
      authorization.ts
      commands.ts
      credentials.ts
      engine.ts
      gql.ts
      cli.ts
      journal.ts
      manifest.ts
      package.ts
      plan.ts
      state.ts
    vercel/
      authorization.ts
      client.ts
      credentials.ts
      engine.ts
      manifest.ts
      package.ts
      plan.ts
      runtime.ts
      source.ts
      state.ts
      types.ts
  tools/
    db-ops.ts
    ship-ops/
      contracts.ts
      index.ts
      schema.ts
```

`src/core/approval.ts` and `src/core/approval-store.ts` stay because approval registry/sidecar are provider-neutral existing public internal concepts. `src/core/errors.ts`, `src/core/redact.ts`, and `src/core/types.ts` stay as cross-cutting primitives. No `src/core/manifest.ts`, `plan.ts`, `state.ts`, `engine.ts`, `authorization.ts`, `journal.ts`, `plan-store.ts`, `runtime.ts`, `operation-journal.ts`, `credentials.ts`, or any `*-v2.ts` remains.

## Exact Move Map

| Current path | Final path | Required change |
|---|---|---|
| `src/core/manifest.ts` | `src/providers/railway/manifest.ts` + `src/persistence/manifest-store.ts` | Move Railway `ManifestSchema`, `Manifest`, Railway semantic/error behavior into package. Parse/read `pi-ship.json` in manifest store through registry. |
| `src/core/manifest-v2.ts` | `src/providers/vercel/manifest.ts` | Move exact strict Vercel manifest schema/semantic validation; rename `ManifestV2` to `VercelManifest`. |
| `src/core/plan.ts` | `src/providers/railway/plan.ts` | Move exact Railway `Plan`, `buildPlan`, `computeDigest`, `canonicalize`, `gatherGit`, stale checks, resource actions. Preserve canonicalization byte-for-byte. |
| `src/core/plan-v2.ts` | `src/providers/vercel/plan.ts` | Move exact Vercel plan/operation/source schemas/builders. Rename `PlanV2` → `VercelPlan`; `VercelOperation` stays. |
| `src/core/state.ts` | `src/providers/railway/state.ts` + `src/providers/vercel/state.ts` + `src/persistence/state-store.ts` | Split exact Railway and Vercel schemas/defaults/projection into package files; atomic JSON path/read/write mechanics into state store. Preserve cross-version conflict messages verbatim via package-specific mismatch callbacks. |
| `src/core/state-v2.ts` | delete | Remove two-line historical shim after callers import `providers/vercel/state.ts`. |
| `src/core/plan-store.ts` | `src/persistence/plan-store.ts` | Keep exact plan file path/non-overwrite/digest errors; registry selects provider plan validator/digest calculator. Export provider-neutral `loadStoredPlan`, `persistStoredPlan`, `planPath`; provider package facades expose typed wrappers if needed. |
| `src/core/authorization.ts` | `src/providers/railway/authorization.ts` | Move exact Railway plan authorization and target snapshot checks. Shared approval/digest helper calls move to deployment authorization. |
| `src/core/authorization-v2.ts` | `src/providers/vercel/authorization.ts` | Move Vercel source/account/project/operation policy. Rename `AuthorizationV2Context` → `VercelAuthorizationContext`; retain every validation/error. |
| `src/core/engine.ts` | `src/providers/railway/engine.ts` | Move exact Railway adapter workflow. It uses Railway state/plan/authorization/journal. |
| `src/core/engine-v2.ts` | `src/deployment/operation-engine.ts` + `src/providers/vercel/engine.ts` | Extract retry/journal/reconcile dependency ordering into generic kernel; Vercel wrapper supplies Vercel authorization, state I/O/projection/history mutation, Vercel journal contract. Rename public internal entry to `applyVercelPlan`. |
| `src/core/runtime.ts` | `src/deployment/contracts.ts` + `src/providers/vercel/runtime.ts` | Move provider-neutral `Verification`, `OperationResult`, `ReconciliationState`, `OperationRuntime` to deployment. Keep Vercel plan/execution/status types inside Vercel package. Generic descriptor uses `provider: ProviderId` and `capabilities: readonly string[]`; no literal `"vercel"`. |
| `src/core/operation-journal.ts` | `src/deployment/operation-journal.ts` + `src/providers/vercel/engine.ts` or `src/providers/vercel/package.ts` | Generic hash/read/append factory accepts exact provider entry schema and exact journal path. Vercel package supplies current strict entry union, allowed operation kinds/statuses, and release-status enum unchanged. |
| `src/core/journal.ts` | `src/providers/railway/journal.ts` | Move exact Railway journal schema and legacy error normalization unchanged. |
| `src/core/credentials.ts` | `src/deployment/credentials.ts` + `src/providers/railway/credentials.ts` + `src/providers/vercel/credentials.ts` | Generic source/environment/app-secret allowlist in deployment; provider token-name selection in provider package. |
| `src/providers/types.ts` | `src/providers/railway/adapter.ts` | Move Railway-only adapter/result/failure types beside adapter. |
| `src/providers/fake.ts` | `src/providers/railway/fake.ts` | Move Railway fake adapter beside Railway contract. |
| `src/providers/railway/index.ts` | `src/providers/railway/adapter.ts` | Rename implementation file; package facade is `package.ts`. |
| `src/providers/factory.ts` | `src/providers/registry.ts` | Replace two-arm historical factory with sole catalog/dispatch/factory seam. |
| `src/providers/vercel/client.ts` | unchanged | Already correct provider ownership. |
| `src/providers/vercel/source.ts` | unchanged | Already correct provider ownership. |
| `src/providers/vercel/runtime.ts` | unchanged path | Change imports to package/deployment paths; retain behavior. |
| `src/providers/vercel/types.ts` | unchanged | Already correct provider ownership. |
| `src/tools/ship-ops.ts` | `src/tools/ship-ops/index.ts`, `contracts.ts`, `schema.ts`; provider handling moves to package files | Thin generic registration/router. No provider `if`/`switch` in tool. |
| `src/tools/db-ops.ts` | unchanged path but reduced | Keep public registration/schema; route manifest-selected database capability through registry. Railway handler lives in Railway package; Vercel package returns current `E_PHASE_UNSUPPORTED` text. |
| `src/commands/ship.ts` | `src/providers/railway/commands.ts` | Move Railway-specific command registration unchanged. `src/index.ts` invokes registry command registration. |
| `src/gate.ts` | unchanged path | Continue generic `apply_plan` registry check. Only import path changes if `ShipOpsInput` moves. |
| `src/index.ts` | modify | Import `registerShipOps` from `tools/ship-ops/index.ts`; obtain registry and invoke `registerProviderCommands`. Public extension/default and exported tool input names unchanged. |

## Module Ownership and Dependency Rules

1. **`core/` rule:** only errors, redaction, approval registry/sidecar, and shared displayed result types. It imports neither provider packages nor persistence.
2. **`deployment/` rule:** no Railway/Vercel names, tokens, endpoints, manifest fields, operation kind enums, state shape, or TypeBox provider literals. It owns generic algorithm and contracts only. It may import `core/errors`, `core/approval`, and `core/redact`.
3. **`persistence/` rule:** owns path/file I/O and generic persisted-plan selection. It receives a `ProviderCatalog`/provider contract argument rather than importing a concrete provider. It imports no tool modules.
4. **Provider package rule:** provider-specific schema, persisted version discriminator, token names, execution state projection, operation sequence, and external client remain local to package. A package may import `core`, `deployment`, and `persistence`; never another provider package.
5. **Registry rule:** `src/providers/registry.ts` is only concrete package composition point. It imports `railwayPackage` and `vercelPackage`, exposes `providerRegistry`, and validates duplicate IDs/ambiguous manifest matches at construction. No other file imports both provider packages or switches on `"railway" | "vercel"`.
6. **Tool rule:** generic tools ask registry to parse manifest and obtain capability handler. They do not import provider manifest/plan/state/runtime/client files and contain no provider-specific action logic.
7. **Future-provider rule:** add `src/providers/<id>/package.ts` satisfying `ProviderPackage`, add it to `providerPackages` in registry, add provider-local tests. No changes in `deployment/`, `persistence/`, `tools/`, `gate.ts`, or existing providers unless new capability intentionally changes common tool schema.
8. **Runtime contract:** define `OperationRuntime<TSnapshot, TOperation, TPlanInput, TExecutionInput, TStatus, TLogs>` with `descriptor: { domain: string; provider: ProviderId; capabilities: readonly string[] }`, `checkAuth`, `discover`, `plan`, `execute`, `reconcile`, `status`, `logs`. `AccountRef`, `Verification`, retryability, `OperationResult`, and `ReconciliationState` stay provider-neutral. Vercel-only `VercelPlanInput`, `VercelExecutionInput`, `VercelReleaseStatus` belong in `providers/vercel/`.
9. **Operation journal contract:** `createOperationJournal<TEntry>(schema, path)` in deployment does strict parse, full-chain verification before filtering, hash computation, append. `providers/vercel/` supplies exact strict schema values currently in `OperationJournalEntrySchema`; do not replace allowed literal kinds/statuses with strings.
10. **Vercel operation engine contract:** `runOperationPlan` in deployment accepts callbacks for authorization, state load/save, `applyVerifiedState`, history append, required-resource policy, and provider journal. `applyVercelPlan` supplies Vercel callbacks. Generic engine never reads `plan.app`, `state.app`, `operations`, or Vercel source fields.

## Test Move Map

Move tests; retain test bodies/assertions except imports, describe strings removing historical labels, and architecture-specific new assertions.

| Current test | Final test |
|---|---|
| `test/core/manifest.test.ts` | `test/providers/railway/manifest.test.ts` |
| `test/core/manifest-v2.test.ts` | `test/providers/vercel/manifest.test.ts` |
| `test/core/plan.test.ts` | `test/providers/railway/plan.test.ts` |
| `test/core/plan-v2.test.ts` | `test/providers/vercel/plan.test.ts` |
| `test/core/state.test.ts` | `test/providers/railway/state.test.ts` |
| `test/core/state-v2.test.ts` | `test/providers/vercel/state.test.ts` |
| `test/core/authorization-v2.test.ts` | `test/providers/vercel/authorization.test.ts` |
| `test/core/engine.test.ts` | `test/providers/railway/engine.test.ts` |
| `test/core/engine-v2.test.ts` | `test/providers/vercel/engine.test.ts` plus `test/deployment/operation-engine.test.ts` for new generic seam behavior |
| `test/core/journal.test.ts` | `test/providers/railway/journal.test.ts` |
| `test/core/operation-journal.test.ts` | `test/deployment/operation-journal.test.ts` plus Vercel schema assertions in `test/providers/vercel/engine.test.ts` |
| `test/core/credentials.test.ts` | `test/deployment/credentials.test.ts`, with provider token selection assertions in `test/providers/railway/credentials.test.ts` and `test/providers/vercel/credentials.test.ts` |
| `test/core/plan-store.test.ts` | `test/persistence/plan-store.test.ts` |
| `test/core/approval.test.ts` | `test/deployment/approval.test.ts` |
| `test/core/approval-v2.test.ts` | `test/providers/vercel/approval.test.ts` |
| `test/fixtures/generate-v1-fixture.test.ts` | `test/providers/railway/fixtures/plan-digest.test.ts` |
| `test/fixtures/v1-plan-digest.fixture.json` | `test/providers/railway/fixtures/plan-digest.fixture.json` |
| `test/providers/fake.test.ts` | `test/providers/railway/fake.test.ts` |
| `test/providers/railway-adapter.test.ts` | `test/providers/railway/adapter.test.ts` |
| `test/providers/railway-cli.test.ts` | `test/providers/railway/cli.test.ts` |
| `test/providers/railway-gql.test.ts` | `test/providers/railway/gql.test.ts` |
| `test/providers/factory.test.ts` | `test/providers/registry.test.ts` |
| `test/providers/vercel-client.test.ts` | `test/providers/vercel/client.test.ts` |
| `test/providers/vercel-runtime.test.ts` | `test/providers/vercel/runtime.test.ts` |
| `test/providers/vercel-source.test.ts` | `test/providers/vercel/source.test.ts` |
| `test/tools/ship-ops.test.ts` | `test/tools/ship-ops/index.test.ts` |
| `test/tools/db-ops.test.ts` | `test/tools/db-ops.test.ts` (imports change only) |
| `test/acceptance.e2e.test.ts` | `test/acceptance/railway.e2e.test.ts` |
| `test/acceptance-vercel.e2e.test.ts` | `test/acceptance/vercel.e2e.test.ts` |

Keep `test/core/redact.test.ts`, `test/gate.test.ts`, `test/index.test.ts`, and `test/tools/schema.test.ts` at their existing logical locations, updating imports only.

---

## Task 1: Lock Behavior Before Structural Moves

**Files:**
- Test: `test/providers/railway/fixtures/plan-digest.test.ts`
- Test: `test/acceptance/railway.e2e.test.ts`
- Test: `test/acceptance/vercel.e2e.test.ts`
- Test: `test/providers/registry.test.ts`

**Consumes:** Current passing behavior, fixture digest, acceptance tests.

**Produces:** Characterization guards for exact persisted behavior and registry-only selection.

- [ ] **Step 1: Move tests without changing assertions.**

Use `git mv` for every path in Test Move Map. Update imports only. Rename describe strings from `V2`/`V1` to `Vercel`/`Railway`; do not change expected tool text, errors, digests, state JSON, or request assertions.

- [ ] **Step 2: Run moved Railway characterization tests.**

Run:
```bash
npx vitest run test/providers/railway/fixtures/plan-digest.test.ts test/acceptance/railway.e2e.test.ts test/providers/railway/plan.test.ts test/providers/railway/state.test.ts test/providers/railway/engine.test.ts
```

Expected: all pass before production import moves. Confirm fixture digest remains `0db6e88fb36d652b454b3a3c2983cae6b1ddea6bcd48ac768ad7024c5b17bf22`.

- [ ] **Step 3: Add registry architecture characterization test.**

Create `test/providers/registry.test.ts`. It must import only `providerRegistry`/registry public helpers and assert all of:

```ts
expect(providerRegistry.ids()).toEqual(["railway", "vercel"]);
expect(providerRegistry.resolveManifest(railwayManifest).id).toBe("railway");
expect(providerRegistry.resolveManifest(vercelManifest).id).toBe("vercel");
expect(() => createProviderRegistry([railwayPackage, railwayPackage])).toThrow(
  expect.objectContaining({ code: "E_CONFIG_INVALID" }),
);
```

Use representative current manifest objects. Add a test that an object matching neither strict schema yields current `E_CONFIG_INVALID` manifest-validation behavior through `loadManifestContract` replacement.

- [ ] **Step 4: Run test to prove registry test initially fails.**

Run:
```bash
npx vitest run test/providers/registry.test.ts
```

Expected: fail because `providerRegistry` and `createProviderRegistry` do not exist.

## Task 2: Create Provider Catalog and Provider-Neutral Contracts

**Files:**
- Create: `src/providers/contracts.ts`
- Create: `src/providers/registry.ts`
- Create: `src/deployment/contracts.ts`
- Create: `src/deployment/credentials.ts`
- Modify: `src/index.ts`
- Test: `test/providers/registry.test.ts`
- Test: `test/deployment/credentials.test.ts`

**Consumes:** Current `CredentialSource`, `ProviderExecution`, Vercel runtime types, Railway adapter types.

**Produces:** `ProviderPackage`, `ProviderCatalog`, `providerRegistry`, `OperationRuntime`, `Verification`, `OperationResult`, `ReconciliationState`, `environmentSource`, `loadAppSecrets`.

- [ ] **Step 1: Define provider-neutral public-internal contracts.**

`src/deployment/contracts.ts` must contain only general types. Use these signatures:

```ts
export type ProviderId = string;
export type UnverifiedReason =
  | "transport" | "rate_limited" | "unauthorized" | "forbidden"
  | "malformed" | "missing_payload" | "conflict";
export type Verification<T> =
  | { status: "verified"; value: T; observedAt: string }
  | { status: "unverified"; reason: UnverifiedReason; retryable: boolean; safeMessage: string };
export interface AccountRef { kind: "team" | "user"; id: string; }
export type ReconciliationState =
  | { outcome: "matches_expected"; observedStateFingerprint: string; resourceRef?: string; releaseStatus?: string; releaseUrl?: string }
  | { outcome: "not_applied"; observedStateFingerprint: string }
  | { outcome: "conflict"; observedStateFingerprint: string };
export type OperationResult =
  | { status: "succeeded"; observedStateFingerprint: string; resourceRef: string; providerRequestId?: string; releaseStatus?: string; releaseUrl?: string }
  | { status: "failed"; certainty: "not_applied"; code: string; safeMessage: string; retryable: boolean }
  | { status: "ambiguous"; reason: UnverifiedReason; safeMessage: string; resourceRef?: string };
export interface OperationRuntime<TSnapshot, TOperation, TPlanInput, TExecutionInput, TStatus, TLogs> {
  readonly descriptor: { domain: string; provider: ProviderId; capabilities: readonly string[] };
  checkAuth(signal?: AbortSignal): Promise<Verification<AccountRef>>;
  discover(target: unknown, signal?: AbortSignal): Promise<Verification<TSnapshot>>;
  plan(intent: string, input: TPlanInput, snapshot: TSnapshot): Promise<Verification<readonly TOperation[]>>;
  execute(operation: TOperation, input: TExecutionInput, signal?: AbortSignal): Promise<OperationResult>;
  reconcile(operation: TOperation, resourceRef?: string, signal?: AbortSignal): Promise<Verification<ReconciliationState>>;
  status(releaseId: string, signal?: AbortSignal): Promise<Verification<TStatus>>;
  logs(releaseId: string, input: { lines: number; secretValues: readonly string[] }, signal?: AbortSignal): Promise<Verification<TLogs>>;
}
```

Keep `verified()`/`unverified()` exact behavior. Do not put Vercel status literals, plan inputs, operation kinds, or provider endpoint data in this file.

- [ ] **Step 2: Move generic credentials and specify package selectors.**

`src/deployment/credentials.ts` exports only `CredentialSource`, `environmentSource`, and `loadAppSecrets`. Railway/Vercel token lookup is not here. Existing token-name tests must move to provider-specific credential tests.

- [ ] **Step 3: Define provider catalog seam.**

`src/providers/contracts.ts` defines generic structural interfaces, including `ProviderPackage`, plan/state/manifest validator hooks, `createExecution`, optional `shipOps`, optional `databaseOps`, and optional `registerCommands`. `src/providers/registry.ts` creates a catalog from an explicit readonly array. It must:

1. reject duplicate `id` values with `E_CONFIG_INVALID`;
2. resolve exactly one manifest package; reject zero or multiple matches with existing config-invalid semantics;
3. resolve stored plan/state through exact provider package schema predicates before returning;
4. expose `createExecution(manifest, options)` and handler lookup;
5. contain the only runtime imports of both package facades.

Use package facades only after Tasks 3–4 create them. During this task, create types and failing registry test scaffolding; do not register incomplete packages.

- [ ] **Step 4: Run focused tests.**

Run:
```bash
npx vitest run test/deployment/credentials.test.ts test/providers/registry.test.ts
```

Expected: credential tests pass after import migration; registry test stays red until package facades exist.

## Task 3: Move Railway Into a Coherent Package Without Behavior Change

**Files:**
- Create/move: `src/providers/railway/{manifest,plan,state,authorization,engine,journal,credentials,adapter,fake,commands,package}.ts`
- Move: `src/providers/railway/index.ts` → `src/providers/railway/adapter.ts`
- Move: `src/providers/fake.ts` → `src/providers/railway/fake.ts`
- Move: `src/core/{manifest,plan,state,authorization,engine,journal}.ts` Railway portions → Railway files
- Modify: `src/providers/railway/{cli,gql}.ts`, `src/commands/ship.ts`, `src/tools/db-ops.ts`, `src/core/approval.ts`, `src/gate.ts`, `src/index.ts`
- Test: every Railway test in Test Move Map

**Consumes:** deployment contracts/credentials, persistence state/plan interfaces from Task 5 (temporary direct existing persistence imports allowed only within this task branch; final import graph must satisfy Task 5).

**Produces:** `railwayPackage`, exact Railway functions renamed without historical version terms:
`buildRailwayPlan`, `computeRailwayPlanDigest`, `loadRailwayState`, `saveRailwayState`, `applyRailwayPlan`, `authorizeRailwayPlanApply`, `createRailwayAdapter`, `registerRailwayCommands`.

- [ ] **Step 1: Move exact Railway modules and rename symbols internally.**

Use `git mv`; copy function bodies byte-for-byte before import changes. Preserve `canonicalize` key sorting and `computeDigest` bytes. Rename only exported TypeScript identifiers to provider names after characterization test proves fixed digest unchanged. `RailwayPlan` must have same JSON fields as old `Plan`; `RailwayState` must have same JSON fields as old `LocalState`.

- [ ] **Step 2: Preserve journal and state error contracts.**

Keep `journal.jsonl` path, `normalizeLegacyError`, malformed/invalid errors, `statePath`, atomic write semantics, and exact cross-version text. Railway state loader checks Vercel schema through catalog/persistence and still emits:

```text
state.json contains V2 state; V1 caller cannot load it
cannot overwrite V2 state with V1 state
```

These legacy messages are observable and must remain literal despite removed filename/version architecture labels.

- [ ] **Step 3: Move Railway commands and register through package.**

Move `src/commands/ship.ts` body to `src/providers/railway/commands.ts`; retain command names, starter manifest, text, direct current command behavior. `src/index.ts` invokes `providerRegistry.registerCommands(pi, registry)`; Railway package supplies command registration, Vercel package returns no commands. Delete `src/commands/ship.ts` only after `test/index.test.ts` passes unchanged assertions.

- [ ] **Step 4: Add Railway package facade test.**

In `test/providers/registry.test.ts`, assert `providerRegistry.resolveManifest(railwayManifest).createExecution(...)` returns Railway adapter behavior and reads only `RAILWAY_API_TOKEN`, then `RAILWAY_TOKEN`. Existing provider factory assertion moves here, not duplicated.

- [ ] **Step 5: Run Railway guard.**

Run:
```bash
npx vitest run test/providers/railway test/acceptance/railway.e2e.test.ts test/tools/db-ops.test.ts test/gate.test.ts test/index.test.ts
```

Expected: all pass; fixed fixture digest exact unchanged.

## Task 4: Move Vercel Contracts, State, Authorization, and Runtime Into Package

**Files:**
- Move: `src/core/manifest-v2.ts` → `src/providers/vercel/manifest.ts`
- Move: `src/core/plan-v2.ts` → `src/providers/vercel/plan.ts`
- Create: `src/providers/vercel/state.ts`
- Move: `src/core/authorization-v2.ts` → `src/providers/vercel/authorization.ts`
- Modify: `src/providers/vercel/{runtime,client,source,types}.ts`
- Create: `src/providers/vercel/{credentials,package}.ts`
- Delete: `src/core/state-v2.ts`
- Test: `test/providers/vercel/{manifest,plan,state,authorization,client,runtime,source}.test.ts`

**Consumes:** deployment contracts, generic credentials, exact Vercel client/source code.

**Produces:** `VercelManifest`, `VercelPlan`, `VercelState`, `VercelOperation`, `VercelPlanInput`, `VercelExecutionInput`, `VercelReleaseStatus`, `buildVercelPlan`, `authorizeVercelPlanApply`, `createVercelRuntime`, `vercelPackage`.

- [ ] **Step 1: Move strict Vercel schemas with exact persisted fields.**

Rename TypeScript symbols only:

```ts
ManifestV2       -> VercelManifest
PlanV2           -> VercelPlan
StateV2          -> VercelState
buildPlanV2      -> buildVercelPlan
computePlanDigestV2 -> computeVercelPlanDigest
isPlanV2         -> isVercelPlan
loadStateV2      -> loadVercelState
saveStateV2      -> saveVercelState
defaultStateV2   -> defaultVercelState
authorizePlanApplyV2 -> authorizeVercelPlanApply
```

Never rename serialized fields or values. `version: 2`, Vercel provider literals, current operation kind sequence, release status enum, strict nested schema, fingerprint inputs, team fallback, source safety, and Vercel API path behavior stay identical.

- [ ] **Step 2: Move Vercel-specific runtime types out of deployment.**

`providers/vercel/runtime.ts` imports `OperationRuntime`, `Verification`, `OperationResult`, `ReconciliationState`, `AccountRef`, `verified`, and `unverified` from `deployment/contracts.ts`. It imports `VercelPlanInput`, `VercelExecutionInput`, `VercelReleaseStatus`, and `VercelOperation` from sibling Vercel modules. Preserve all certainty classifications and redaction behavior.

- [ ] **Step 3: Implement package-local credential selection and facade.**

`providers/vercel/credentials.ts` exposes `loadVercelCredentials(source)` and reads only `VERCEL_TOKEN`; missing token still produces `E_AUTH_MISSING` text `VERCEL_TOKEN is required` at package execution construction. `providers/vercel/package.ts` implements package metadata/schema/persistence hooks/execution construction. It validates exact team binding against persisted Vercel state before client creation.

- [ ] **Step 4: Add Vercel facade assertions.**

Move current factory tests to `test/providers/registry.test.ts`, assert the Vercel package returns runtime/client, only reads `VERCEL_TOKEN`, preserves team-scoped URL behavior, and rejects mismatched stored account bindings.

- [ ] **Step 5: Run Vercel guard.**

Run:
```bash
npx vitest run test/providers/vercel test/providers/registry.test.ts test/acceptance/vercel.e2e.test.ts
```

Expected: all pass; no native/live fetch used in acceptance.

## Task 5: Build Persistence and Registry Dispatch; Delete Historical Core Files

**Files:**
- Create: `src/persistence/{json,manifest-store,plan-store,state-store}.ts`
- Create/modify: `src/providers/registry.ts`, `src/providers/{railway,vercel}/package.ts`
- Delete: `src/core/{manifest,plan,state,plan-store,authorization,engine,journal,credentials,runtime,operation-journal}.ts`
- Delete: all `src/core/*-v2.ts`
- Modify: all imports in `src`, including `src/core/approval.ts`, `src/core/approval-store.ts`, `src/gate.ts`, `src/index.ts`
- Test: `test/persistence/plan-store.test.ts`, `test/providers/registry.test.ts`, moved state/manifest tests

**Consumes:** package facades and package schemas from Tasks 3–4.

**Produces:** sole catalog path for provider dispatch and shared file persistence.

- [ ] **Step 1: Implement raw JSON persistence only.**

`persistence/json.ts` exports safe primitives: `readJson(path)`, `writeJsonAtomically(path, value)`, and existing error wrapping. `persistence/state-store.ts` exports `statePath(cwd)` retaining exactly `.pi-ship/state.json`; it does not know Railway/Vercel schemas. `persistence/plan-store.ts` exports `planPath(cwd, planId)` retaining exactly `.pi-ship/plans/<planId>.json` and no-overwrite behavior.

- [ ] **Step 2: Make registry sole schema dispatch.**

`providerRegistry` must expose these operations:

```ts
loadManifest(cwd: string): Promise<ProviderManifest>;
persistPlan(cwd: string, plan: ProviderPlan): Promise<void>;
loadPlan(cwd: string, planId: string): Promise<ProviderPlan>;
loadState(cwd: string, provider: ProviderId): Promise<unknown>;
saveState(cwd: string, provider: ProviderId, state: unknown): Promise<void>;
createExecution(manifest: ProviderManifest, options: ProviderExecutionOptions): ProviderExecution;
getShipOpsHandler(manifest: ProviderManifest): ProviderShipOpsHandler;
getDatabaseOpsHandler(manifest: ProviderManifest): ProviderDatabaseOpsHandler;
registerCommands(pi: ExtensionAPI, registry: ApprovalRegistry): void;
```

Internally it calls persistence with package-supplied `isManifest`, `isPlan`, `isState`, `validate`, `computePlanDigest`, default-state, and mismatch-message hooks. It must select exactly one package and must not use a historical version-named branch.

- [ ] **Step 3: Preserve plan-store behavior exactly.**

`persistPlan` checks strict provider schema and recomputed package digest before write; duplicate plan ID gives `E_STATE_CONFLICT`; missing plan gives `E_PLAN_NOT_FOUND`; malformed JSON and requested/stored ID mismatch retain current code/text. Vercel and Railway plan schemas stay package-owned. Test Railway and Vercel tampered digest cases through registry persistence.

- [ ] **Step 4: Preserve cross-provider state conflict exactly.**

State store asks expected package `isState`. If the other registered package recognizes stored JSON, invoke expected package's exact mismatch error text. Do not migrate/transform file contents. Tests must prove saved Railway blocks Vercel and saved Vercel blocks Railway at load and write exactly as current.

- [ ] **Step 5: Delete old files only after import search is zero.**

Run:
```bash
rg --glob '*.ts' --glob '!src/.pi-smartread.tags.cache/**' '(-v2|V1|V2|core/(manifest|plan|state|plan-store|authorization|engine|journal|credentials|runtime|operation-journal)\.js)' src test
```

Expected: no historical module/file import hits; allowed persisted error text containing `V1`/`V2` is reviewed manually, not mechanically changed.

- [ ] **Step 6: Run persistence and compatibility checks.**

Run:
```bash
npx vitest run test/persistence/plan-store.test.ts test/providers/railway/state.test.ts test/providers/vercel/state.test.ts test/providers/registry.test.ts
```

Expected: all pass.

## Task 6: Extract Generic Operation Kernel and Bind Vercel Workflow

**Files:**
- Create: `src/deployment/{operation-authorization,operation-engine,operation-journal}.ts`
- Create/modify: `src/providers/vercel/engine.ts`, `authorization.ts`, `state.ts`, `package.ts`
- Delete: historical operation engine/journal/authorization sources after move
- Test: `test/deployment/{operation-engine,operation-journal}.test.ts`, `test/providers/vercel/{engine,authorization}.test.ts`

**Consumes:** provider-neutral contracts, Vercel schemas/persistence package hooks.

**Produces:** generic execution mechanics plus provider-owned Vercel state effects.

- [ ] **Step 1: Extract generic approved-plan checks.**

`deployment/operation-authorization.ts` exports helpers that only accept generic inputs: approved `planId`/`planDigest`, supplied digest, `createdAt`, canonical manifest snapshot comparator callback, and cancellation signal. It preserves error code/message/retryability. `providers/vercel/authorization.ts` retains source identity, account/project target binding, exact operation sequence/fingerprint checks, and current journal full-read before execution.

- [ ] **Step 2: Extract generic journal mechanics with injected strict schema.**

`createOperationJournal` receives a `TSchema` and path callback; it performs strict append/read/hash-chain mechanics. Vercel package defines the existing exact `OperationJournalEntrySchema` and passes it. Tests prove invalid Vercel release status is still rejected and planDigest hash tampering still fails before filtering.

- [ ] **Step 3: Extract generic operation retry/reconciliation loop.**

`runOperationPlan` operates on generic operation fields (`operationId`, `kind`, `dependsOn`, `targetFingerprint`, `requestFingerprint`, `expectedStateFingerprint`) and injected callbacks. It preserves: dependency order, max two attempts, journal start/fail/ambiguous/reconciled entries, never retry ambiguous until verified `not_applied`, complete physical journal validation, cancellation, resource requirements, and conflict behavior.

- [ ] **Step 4: Keep Vercel state projection local.**

`applyVercelPlan` in `providers/vercel/engine.ts` supplies Vercel callbacks and owns all `app`, `environments`, `releases`, `history`, release-status mapping, Vercel secret completeness checks, verified account match, and `saveVercelState`. It returns `Promise<VercelState>`. No deployment module references `app`, `projectName`, `teamId`, `releaseStatus` enum literals, or Vercel operation names.

- [ ] **Step 5: Run Vercel safety tests.**

Run:
```bash
npx vitest run test/deployment/operation-engine.test.ts test/deployment/operation-journal.test.ts test/providers/vercel/engine.test.ts test/providers/vercel/authorization.test.ts test/providers/vercel/runtime.test.ts
```

Expected: all pass, including ambiguous deploy no-retry, mismatched create identity no-retry, failed secret entries block deploy, source drift blocks mutation, and hash tampering fails.

## Task 7: Split Generic Tools After Registry Seam Exists

**Files:**
- Create: `src/tools/ship-ops/{contracts,index,schema}.ts`
- Modify: `src/tools/db-ops.ts`, `src/gate.ts`, `src/index.ts`
- Create/modify: `src/providers/railway/package.ts`, `src/providers/vercel/package.ts`, provider-local tool handlers if facade needs separate `ship-ops.ts` files
- Delete: `src/tools/ship-ops.ts`
- Test: `test/tools/ship-ops/index.test.ts`, `test/tools/db-ops.test.ts`, `test/gate.test.ts`, `test/acceptance/{railway,vercel}.e2e.test.ts`

**Consumes:** working registry/package handlers.

**Produces:** provider-neutral tool registration, exact unchanged user-visible behavior.

- [ ] **Step 1: Keep common ship schema byte-equivalent.**

Move existing `shipOpsSchema` and `ShipOpsInput` unchanged to `tools/ship-ops/schema.ts`. `tools/ship-ops/contracts.ts` defines handler context containing Pi/context/cwd/action/credential source/fetch injection/approval registry/signal. `tools/ship-ops/index.ts` validates input exactly, obtains manifest through registry, asks package handler to execute. It contains no `isManifest`, Vercel import, Railway import, version conditional, or provider string branch.

- [ ] **Step 2: Place current handlers behind package facades.**

Railway package receives former validation/plan/apply/status/logs behavior and existing database behavior. Vercel package receives former validate/plan/apply/status/logs behavior. Preserve every string and details object exactly, including `Missing:`, preview rejection, unavailable status/log output, fetched secret values used only for redaction, injected fetch behavior, and unsupported Vercel DB text.

- [ ] **Step 3: Use registry for `db_ops` and commands.**

`db_ops` loads manifest via registry and invokes package database handler. Railway behavior remains exact; Vercel still throws `E_PHASE_UNSUPPORTED`, current message. `index.ts` gets provider command registration from registry; all existing Railway command names remain registered.

- [ ] **Step 4: Add architecture assertions.**

Add to `test/tools/ship-ops/index.test.ts` a test that runs one Railway and one Vercel request through the same registered `ship_ops` function and proves package routing by existing fake adapter/fetch observations. Add a static architecture test (`test/providers/registry.test.ts`) that reads `src/tools/ship-ops/index.ts` and asserts it does not import `providers/railway` or `providers/vercel`; only `providers/registry` is allowed. Do not make source-text inspection a behavioral guard replacement; retain both acceptance tests.

- [ ] **Step 5: Run tool/acceptance tests.**

Run:
```bash
npx vitest run test/tools/ship-ops/index.test.ts test/tools/db-ops.test.ts test/gate.test.ts test/index.test.ts test/acceptance/railway.e2e.test.ts test/acceptance/vercel.e2e.test.ts
```

Expected: all pass; Vercel acceptance still forbids native fetch and Railway acceptance still deploys once.

## Task 8: ADRs and Durable Design Record

**Files:**
- Modify: `docs/adr/0001-single-provider-railway.md`
- Create: `docs/adr/0002-provider-expansion-and-operation-safety.md`
- Create: `docs/adr/0003-hybrid-provider-packages-and-deployment-kernel.md`
- Create: `docs/plans/2026-07-15-provider-package-architecture-implementation-plan.md`

**Consumes:** approved architecture and current Phase 0/1 behavior.

**Produces:** durable rationale; no code behavior change.

- [ ] **Step 1: Supersede ADR-0001 without removing history.**

Replace only status line with:

```markdown
Status: Superseded by [ADR 0002: Provider expansion and operation safety](0002-provider-expansion-and-operation-safety.md)
```

Keep title, Decision, Consequences, and historical Railway MVP text unchanged.

- [ ] **Step 2: Create ADR-0002 with exact content.**

```markdown
# ADR 0002: Provider expansion and operation safety

## Status
Accepted

## Context
ADR 0001 limited pi-ship to Railway during MVP. Phase 0/1 adds Vercel app deployment while Railway persisted manifests, plans, state, journals, digest, commands, and tool output must remain compatible. Provider APIs can acknowledge writes ambiguously; local source can change after approval; provider tokens and application secrets have distinct trust boundaries.

## Decision
pi-ship supports Railway and Vercel through separate provider contracts. Railway retains its existing manifest and `version: 1` state/plan behavior. Vercel uses its existing strict `version: 2` manifest, plan, state, and operation-journal contracts. Both providers keep `.pi-ship/state.json`; incompatible stored provider contracts fail closed rather than migrate.

Vercel uses injectable native fetch, strict projected response validation, provider-isolated `VERCEL_TOKEN`, separately allowlisted app-secret values, local source enumeration with containment/symlink/secret exclusions, SHA-1 file uploads, SHA-256 source fingerprints, and no live test-cloud mutation.

Vercel mutations are never retried from an uncertain response. Retry occurs at most once only after reconciliation verifies `not_applied`; conflict, unverified state, mismatched resource identity, partial secret write, or fingerprint mismatch blocks apply. The operation journal is hash chained and fully validated before filtering. Journal/history never authorizes an apply.

## Alternatives considered
1. Keep Railway-only scope — rejected because approved Phase 1 requires Vercel deployment.
2. Reuse Railway `ProviderAdapter` for Vercel — rejected because Railway CLI/GraphQL lifecycle and Vercel operation reconciliation have incompatible interfaces and certainty semantics.
3. Retry all transient Vercel mutations — rejected because a server may apply a timed-out/5xx request.

## Consequences
- Vercel deploys require in-memory approval, a fresh bound plan, verified account/project/source identity, and explicit token/app-secret allowlists.
- Vercel environment writes and rollback are intentionally unreconcilable when provider reads cannot prove their effect; apply fails closed.
- Tests use injected fake fetch; documented endpoints are validated, but no live Vercel mutation is performed.
- Future providers must preserve their own persisted contracts and failure semantics rather than inherit Railway assumptions.

## Verification
`npm test`, `npm run typecheck`, `npm run acceptance`, and `git diff --check` pass. Cloud-free Vercel acceptance covers preview, production, status, redacted logs, rollback, token isolation, source drift, ambiguous mutation blocking, and journal integrity.
```

- [ ] **Step 3: Create ADR-0003 with exact content.**

```markdown
# ADR 0003: Hybrid provider packages and deployment kernel

## Status
Accepted

## Context
Phase 0/1 implementation initially used files such as `manifest-v2.ts`, `plan-v2.ts`, and `engine-v2.ts`. Those names encode rollout history instead of ownership. Vercel-specific schemas and lifecycle rules leaked into generic core modules and `ship_ops`, making another provider require scattered edits and making version labels permanent architecture.

## Decision
Provider-specific behavior lives in `src/providers/<provider>/`. Each package owns its manifest, plan, state, authorization policy, credential selection, external adapter/client, execution state projection, and optional tool/command/database handlers. Persisted numeric versions remain provider contract discriminators; they are not module architecture.

`src/deployment/` owns provider-neutral verification contracts, approval primitives, generic operation execution mechanics, generic operation authorization helpers, and generic hash-chain mechanics. Provider-owned strict schemas are injected into generic persistence/journal mechanics so exact persisted validation is retained.

`src/persistence/` owns paths and JSON/atomic I/O. `src/providers/registry.ts` is the sole package composition, manifest/plan/state dispatch, execution construction, and provider handler lookup seam. Adding a provider requires its package plus an explicit registry entry. `tools/ship-ops` only validates common input and delegates to registry; it contains no provider branch.

## Alternatives considered
1. Keep `core/*-v2.ts` beside Railway files — rejected because historical labels conceal provider ownership and make future providers copy a false version split.
2. Move all Vercel files into its package but leave separate engines/factories/tools — rejected because dispatch and persistence coupling remain scattered.
3. Build a universal provider adapter with one operation model — rejected because Railway adapter workflow and Vercel reconciliation differ materially; forced abstraction would reduce safety and locality.
4. Use dynamic package discovery — rejected because explicit registry entries are auditable, typed, and fail closed.

## Consequences
- Internal import paths change; `src/index.ts` public extension exports, persisted data, state paths, tool schemas/output/errors, command names, and Railway digest remain unchanged.
- `deployment/` intentionally has callback-based operation hooks. This is a real seam: generic retry/journal mechanics remain shared while provider state projection stays local.
- Future provider addition is bounded to package plus registry entry and package tests. Common tool schema changes remain explicit product work.
- No compatibility files with `-v2` names remain. Historical ADRs stay discoverable through supersession links.

## Verification
Architecture tests prove registry contains Railway/Vercel, generic tools import only registry, provider packages retain strict schemas, persisted contract fixtures remain readable, Vercel cloud-free acceptance remains injected, and Railway fixture digest is byte-identical.
```

- [ ] **Step 4: Write durable implementation plan.**

Create `docs/plans/2026-07-15-provider-package-architecture-implementation-plan.md` by copying this approved plan's Goal, Global Constraints, Final File Tree, Exact Move Map, Module Ownership and Dependency Rules, Test Move Map, Tasks 1–9, ADR drafts, verification, and rollback sections. Update status line to `Approved` only after user approval already recorded in this session; leave task checkboxes unchecked until work completes.

- [ ] **Step 5: Verify docs links and historical labels.**

Run:
```bash
rg -n 'Status:|0002-provider-expansion|0003-hybrid-provider|\*-v2|manifest-v2|plan-v2|state-v2|engine-v2|authorization-v2' docs src test
```

Expected: ADR-0001 links ADR-0002; ADR-0002/0003 exist; no source/test file/import historical `-v2` names; the old Phase 0/1 historical plan is allowed to describe original implementation.

## Task 9: Full Verification, Diff Review, and No-Compatibility-Shim Gate

**Files:** all moved/modified source/tests/docs.

**Consumes:** completed Tasks 1–8.

**Produces:** evidence refactor preserved exact behavior.

- [ ] **Step 1: Verify no prohibited layout remains.**

Run:
```bash
find src test -type f \( -name '*-v2.ts' -o -name '*-v2.test.ts' \) -print
find src -type f -name '*-v2.ts' -print
```

Expected: no output. Inspect `src/deployment/` manually; it must contain no `vercel`, `railway`, `Vercel`, or `Railway` literal in source except generic documentation that does not define behavior.

- [ ] **Step 2: Verify provider import locality.**

Run:
```bash
rg -n 'providers/(railway|vercel)' src/tools src/deployment src/persistence src/core
rg -n 'from "\.\./providers/(railway|vercel)|from "\.\./\.\./providers/(railway|vercel)' src/tools src/deployment src/persistence src/core
```

Expected: no direct concrete-provider imports outside `src/providers/registry.ts`, provider packages, and tests. `src/index.ts` may import only registry/tool registration, not concrete provider packages.

- [ ] **Step 3: Run targeted contract tests.**

Run:
```bash
npx vitest run test/providers/registry.test.ts test/deployment test/persistence test/providers/railway test/providers/vercel test/tools test/gate.test.ts test/index.test.ts test/acceptance
```

Expected: all targeted tests pass.

- [ ] **Step 4: Run full required checks.**

Run:
```bash
npm test
npm run typecheck
npm run acceptance
git diff --check
git diff --cached --name-only
git status --short
```

Expected: full suite passes; typecheck exits 0; acceptance exits 0; diff check empty; cached-file command prints nothing; status shows only intended uncommitted refactor/docs changes and preserves unrelated user-owned files.

- [ ] **Step 5: Perform explicit persisted compatibility proof.**

Run:
```bash
npx vitest run test/providers/railway/fixtures/plan-digest.test.ts test/providers/railway/state.test.ts test/providers/vercel/state.test.ts test/persistence/plan-store.test.ts test/deployment/operation-journal.test.ts test/acceptance/railway.e2e.test.ts test/acceptance/vercel.e2e.test.ts
```

Expected: Railway fixed digest exact; both versioned state shapes reject cross-provider overwrite; Vercel plan/state/journal validation remains strict; both acceptance paths pass.

---

## Migration and Rollback Strategy

- This is a source-layout migration only. Do not rewrite, backfill, rename, or delete any `.pi-ship` files.
- Runtime reads existing persisted data through provider-owned schemas identical to current schemas. Railway plan digest must be proven against existing fixture before and after moves.
- Do not introduce old-path re-export compatibility modules. Internal consumers migrate atomically inside one uncommitted change set; external public API remains `src/index.ts` extension entry and unchanged tool/command/persisted contracts.
- If focused characterization fails during a move, stop that task, restore only files changed by that task with targeted edits or `git mv` reversal, and retain prior passing source. Do not use `git reset --hard`, `git clean`, or broad checkout because worktree contains user-owned uncommitted changes.
- If generic operation extraction changes Vercel behavior, keep `deployment/operation-engine.ts` generic mechanics but move the affected policy/state effect back into `providers/vercel/engine.ts`; do not weaken safety checks to fit abstraction.
- If registry generic typing becomes wider than strict provider contracts, use discriminated package union/overloads rather than `any`, broad `Record`, or permissive TypeBox schema. Exact provider schema stays authoritative.

## Risks

1. **Exact Railway digest drift:** imports/renames must not alter `canonicalize`, object construction ordering, resource action ordering, or persisted fixture. Mitigation: fixture test first and final exact digest assertion.
2. **Generic journal schema weakening:** a stringly generic schema would accept persisted Vercel data currently rejected. Mitigation: generic journal mechanics receive Vercel-owned strict schema instance.
3. **Registry/persistence circular imports:** registry composes packages; persistence receives catalog/contracts as arguments and must not import registry singleton. Mitigation: enforce dependency rules and TypeScript import graph review.
4. **User-visible version labels:** errors currently mention V1/V2. Requirement bans historical architecture/module names, not existing user-visible error changes. Preserve exact current messages; do not rewrite them.
5. **Tool output drift:** moving handlers can alter default values, fetch injection, or redaction. Mitigation: retain acceptance assertions verbatim and router test runs both packages.
6. **Scope creep into provider normalization:** keep Railway and Vercel execution models separate; generic kernel only owns proven common retry/journal mechanics.
7. **Untracked user-owned files:** current Phase 0/1 additions are untracked. Mitigation: no destructive Git command, no commits, inspect status before/after moves.

## Plan Self-Review

- Coverage: final tree/move map removes all named `-v2` source/test files; provider package ownership, registry-only seam, shared kernel, tool split, persisted compatibility, ADR supersession/additions, and verification all map to tasks.
- No behavior contract intentionally changes: existing user-visible version/error text, persisted discriminators, paths, exact V1 digest, schemas, commands, tool output, and fake-fetch safety are explicit guards.
- Genericization is limited: provider-specific literal schemas and state projection stay local, avoiding a broad persistent schema change.
- No commit step appears because user explicitly prohibited commits.
