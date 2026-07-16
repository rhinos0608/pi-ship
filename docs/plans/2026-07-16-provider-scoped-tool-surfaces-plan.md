# Provider-Scoped Tool Surfaces Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind one startup-validated provider profile to exact `ship` and `DB` schemas without changing tool names or persisted formats.

**Architecture:** `pi-ship.json` resolves once into immutable `ProviderRuntimeBinding`. Shared TypeBox action catalogs compose local or selected provider profile. Startup passes binding into boundary/tools/commands; byte-digest drift guard runs before dispatch. Approval gate, vault capability, and handler checks remain enforcement layers.

**Tech Stack:** TypeScript, TypeBox, Vitest, Node.js `fs/promises` and `crypto`.

## Global Constraints

- Keep tool names exact `ship` and `DB`.
- Keep persisted plan, state, journal, approval, and manifest formats unchanged.
- No manifest profile exposes only DB `inspect`, `browse`, `query`, `plan`, `apply_plan`, `migration_status`, `import`, `reset`.
- Present invalid/unsupported manifest aborts startup; never downgrade to local.
- Parse and validate present manifest once at startup. Runtime guard canonicalizes runtime cwd, compares it with canonical startup cwd, then hashes bytes only.
- Broad public `shipSchema`/`ShipInput` remains union of all profile variants including Neon `development`; broad public `DBSchema`/`DBInput` retains `plan_migration`. Registration uses narrowed composed schemas.
- Preserve public `registerShip`, `registerDB`, and three-argument `executeApprovedOperation(vault, binding, fn)` compatibility; default extension passes immutable binding.
- Railway preview requires `previewId`; Vercel/Cloudflare reject it; Neon accepts `development` and omits logs. Railway, Vercel, Cloudflare, and Neon retain production rollback plan requiring `targetReleaseId`; Neon resolves it to owned restore point.
- Railway/Neon add `plan_migration`; every provider retains common DB actions.
- Registration narrowing is ergonomics only. Gate approval and vault capability remain mandatory.
- No dependency changes, fake commands, Neon logs, Cloudflare DB-provider ops, or commits.

---

## File Structure

- `docs/adr/0012-provider-scoped-tool-surfaces.md` — accepted contract and executable matrix source.
- `src/providers/capability-profile.ts` — profile types, local profile, common matrix helpers.
- `src/providers/contracts.ts` — `ProviderPackage.profile` and binding-facing types.
- `src/persistence/manifest-store.ts` — one-read startup binding and byte-only drift check.
- `src/providers/registry.ts` — resolve binding, selected package command registration/services.
- `src/tools/ship/schema.ts` — shared ship variants and profile schema composer.
- `src/tools/db/schema.ts` — shared DB variants and profile schema composer.
- `src/index.ts` — startup order and one binding injection.
- `src/boundary/integration/register.ts` — binding-provided manifest configuration.
- `src/tools/ship/index.ts` — selected schema/binding dispatch, legacy registration compatibility, vault resource lookup.
- `src/tools/db/index.ts` — selected DB schema/binding dispatch, legacy registration compatibility, context fingerprint.
- `src/gate.ts` — typed acceptance remains broad enough for runtime gate; no authorization narrowing.
- `src/providers/{railway,vercel,cloudflare,neon}/package.ts` — profile declarations only.
- `test/providers/capability-profile.test.ts` — profile/schema matrix.
- `test/index.test.ts` — extension startup registration and byte drift integration.
- `test/docs/provider-capability-matrix.test.ts` — ADR table/profile parity.
- Existing `test/providers/registry.test.ts`, `test/tools/schema.test.ts`, `test/tools/ship/index.test.ts`, `test/tools/db/index.test.ts`, `test/boundary/integration/register.test.ts`, and `test/gate.test.ts` — regression coverage; create `test/gate.test.ts` only if absent.

## Interfaces

Create `src/providers/capability-profile.ts`:

```ts
import type { TSchema } from "typebox";

export type ToolName = "ship" | "DB";
export type BoundaryResourceName =
  | "railway-deployment"
  | "vercel-deployment"
  | "cloudflare-deployment"
  | "neon-control-plane";

export type ShipVariant = TSchema;
export type DBVariant = TSchema;

export interface ProviderCapabilityProfile {
  readonly ship: readonly ShipVariant[];
  readonly databaseAdditions: readonly DBVariant[];
  readonly commands: readonly string[];
  readonly boundaryResource?: BoundaryResourceName;
}

export interface ProviderRuntimeBinding {
  readonly cwd: string;
  readonly manifest: unknown | undefined;
  readonly package: ProviderPackage | undefined;
  readonly profile: ProviderCapabilityProfile;
  readonly manifestBytesDigest: string | undefined;
  assertIntact(runtimeCwd: string): Promise<void>;
}
```

Import `ProviderPackage` as type from `src/providers/contracts.ts`; avoid runtime cycle. Add to `ProviderPackage`:

```ts
readonly profile: ProviderCapabilityProfile;
```

Catalog modules export `composeShipSchema(variants)` and `composeDBSchema(additions)`. `composeDBSchema` always joins all shared DB variants with additions. It rejects duplicate action discriminators during module/test construction with `E_CONFIG_INVALID`. `composeShipSchema([])` is never registered as a tool. Public `shipSchema` is separately composed from every profile variant, including Neon development, and public `DBSchema` from shared variants plus `planMigrationVariant`; keep public `ShipInput`/`DBInput` based on these broad schemas.

Keep public registration APIs source-compatible:

```ts
export function registerShip(pi: ExtensionAPI, registry: ApprovalRegistry, deps?: ShipRegistrationDeps): void;
export function registerDB(pi: ExtensionAPI, registry: ApprovalRegistry, deps?: DatabaseRegistrationDeps): DatabaseRegistration;
```

`deps.binding`, `deps.profile`, and `deps.parameters` are optional. Absent binding preserves current direct-call broad schema/per-call manifest behavior. Default extension supplies all three and uses immutable binding.

Keep helper call compatibility with optional fourth argument:

```ts
export function executeApprovedOperation<T>(
  vault: CredentialVault,
  binding: ApprovedPlanBinding,
  fn: () => T,
  resourceOverride?: BoundaryResourceName,
): T;
```

No `resourceOverride` preserves legacy `PROVIDER_RESOURCE[binding.provider]` lookup. Bound default extension compares `binding.provider` with selected `ProviderPackage.id` before calling helper and passes selected profile `boundaryResource` as fourth argument.

Create startup API in `src/persistence/manifest-store.ts`:

```ts
export async function loadProviderRuntimeBinding(
  cwd: string,
  packages: readonly ProviderPackage[],
): Promise<ProviderRuntimeBinding>;
```

`ENOENT` returns local binding/profile. Present-file path reads bytes once, parses once, resolves one package, calls `validateManifest`, and captures SHA-256 bytes digest. `assertIntact()` rereads bytes and compares digest only. It throws `E_STATE_CONFLICT` on changed/missing/unreadable manifest after startup.

## Tasks

### Task 1: Lock catalog/profile matrix with failing tests

**Files:**
- Create: `test/providers/capability-profile.test.ts`
- Modify: `test/tools/schema.test.ts`
- Modify: `src/tools/ship/schema.ts`
- Modify: `src/tools/db/schema.ts`
- Create: `src/providers/capability-profile.ts`

**Consumes:** Existing broad `shipSchema`, `DBSchema`, all four package manifests.

**Produces:** Shared schema variants, local profile, typed profile contract, profile-specific schema builders.

- [ ] **Step 1: Write failing profile schema tests.**

  Assert `Value.Check(composeShipSchema(profile.ship), input)` and `Value.Check(composeDBSchema(profile.databaseAdditions), input)` for each package:

  ```ts
  expect(Value.Check(railwayShip, {
    action: "plan", environment: "preview", previewId: "pr-7",
  })).toBe(true);
  expect(Value.Check(railwayShip, {
    action: "plan", environment: "preview",
  })).toBe(false);
  expect(Value.Check(vercelShip, {
    action: "plan", environment: "preview", previewId: "pr-7",
  })).toBe(false);
  expect(Value.Check(cloudflareShip, {
    action: "plan", environment: "preview", previewId: "pr-7",
  })).toBe(false);
  expect(Value.Check(neonShip, {
    action: "plan", environment: "development",
  })).toBe(true);
  expect(Value.Check(neonShip, { action: "logs", lines: 10 })).toBe(false);
  ```

  For each profile, assert all eight common DB action fixtures pass. Assert `plan_migration` passes only Railway/Neon, and fails local/Vercel/Cloudflare. For Railway, Vercel, Cloudflare, and Neon composed ship schemas, assert `{ action: "plan", environment: "production", intent: "rollback", targetReleaseId: "release-1" }` passes and missing `targetReleaseId` fails; Neon handler tests separately prove ID resolves to owned restore point. Separately assert public broad compatibility schemas accept Railway/Vercel/Cloudflare/Neon forms, including `{ action: "plan", environment: "development" }` and production rollback form, and public `DBSchema` accepts `{ action: "plan_migration" }`.

- [ ] **Step 2: Run focused tests; verify failure.**

  Run:

  ```bash
  npx vitest run test/providers/capability-profile.test.ts test/tools/schema.test.ts
  ```

  Expected: FAIL because profile exports/composers do not exist and current universal schemas accept forbidden actions.

- [ ] **Step 3: Implement catalog and profiles.**

  In `src/tools/ship/schema.ts`, split static union into exported strict variants: common `validate`, `apply_plan`, `status`, `logs`; provider-composable plan variants. Define distinct Railway preview object requiring `previewId`, Vercel/Cloudflare preview object without it, Neon normal-plan environment union including `development`, and production rollback object requiring `targetReleaseId`. Include rollback object in Railway, Vercel, Cloudflare, and Neon profiles; do not lose existing rollback behavior. Define public `shipSchema` as union of every catalog/profile variant, not common-only variants; keep `ShipInput = Static<typeof shipSchema>`. Registration receives composed profile schema.

  In `src/tools/db/schema.ts`, export strict variants for all eight shared actions plus separate `planMigrationVariant`. Define public `DBSchema` as shared variants plus `planMigrationVariant`, with `DBInput = Static<typeof DBSchema>`. `composeDBSchema(additions)` always includes eight shared variants. Do not move provider migration action into shared set.

  In `src/providers/capability-profile.ts`, define `localCapabilityProfile` and provider profile constructors/constants. Profiles use catalog exports, command list, and boundary resource exactly as ADR matrix.

  In every package facade, set `profile` to corresponding profile. Railway alone lists existing six commands; other packages list empty commands.

- [ ] **Step 4: Re-run focused tests; verify pass.**

  Run:

  ```bash
  npx vitest run test/providers/capability-profile.test.ts test/tools/schema.test.ts
  ```

  Expected: PASS. Vercel/Cloudflare still accept all common DB actions; Neon rejects logs; all variant objects reject unknown fields.

### Task 2: Build one startup binding and byte-only drift guard

**Files:**
- Modify: `src/providers/contracts.ts`
- Modify: `src/persistence/manifest-store.ts`
- Modify: `src/providers/registry.ts`
- Modify: `test/providers/registry.test.ts`
- Modify: `test/index.test.ts`

**Consumes:** Task 1 `ProviderCapabilityProfile` and `localCapabilityProfile`.

**Produces:** `loadProviderRuntimeBinding`, cached selected package/manifest/profile, drift guard.

- [ ] **Step 1: Write binding failure tests.**

  In `test/providers/registry.test.ts`, test valid Railway/Vercel/Cloudflare/Neon manifests return matching profile/package. Test invalid Vercel semantic manifest (`rootDirectory: "../outside"` or database secret missing from `secrets`) rejects during binding construction.

  In existing `test/index.test.ts`, use temporary cwd and recording extension API. Test absent manifest gives local binding. Test malformed JSON and unsupported provider reject factory before any `registerTool`/`registerCommand` call. After valid startup, replace `pi-ship.json` bytes and call captured `ship`/`DB` executor; assert `E_STATE_CONFLICT` before fake provider handler observes call. Invoke captured tool/command with a different `ctx.cwd`; assert canonical-cwd `E_STATE_CONFLICT` before handler work. Start local, create `pi-ship.json`, then invoke DB; assert local binding rejects newly created manifest until reload.

- [ ] **Step 2: Run binding tests; verify failure.**

  Run:

  ```bash
  npx vitest run test/providers/registry.test.ts test/index.test.ts
  ```

  Expected: FAIL because extension uses file existence gating and handlers reload manifest.

- [ ] **Step 3: Implement binding.**

  Replace separate `access(manifestPath(...))` decisions with `loadProviderRuntimeBinding`. Read raw bytes with `readFile`; only `ENOENT` selects local. Present bytes parse to object, call existing unambiguous package resolver, call `validateManifest`, verify profile is nonempty/known-safe, then retain package/manifest/profile. Store `createHash("sha256").update(bytes).digest("hex")`.

  Canonicalize startup cwd once with `realpath`/resolved canonical path and store it. `assertIntact(runtimeCwd)` canonicalizes runtime cwd first; mismatch throws `E_STATE_CONFLICT` before manifest read. It then reads current manifest bytes and compares startup digest without `JSON.parse`, `resolveManifest`, or `validateManifest`. Missing/unreadable/current-byte mismatch all throw `err("E_STATE_CONFLICT", "provider manifest changed since startup; reload or restart")`. For local binding, any newly present manifest is mismatch.

  Add registry facade only if needed:

  ```ts
  loadRuntimeBinding(cwd: string): Promise<ProviderRuntimeBinding>;
  ```

  Do not alter `loadPlan`, `persistPlan`, state ownership, or persisted validation.

- [ ] **Step 4: Re-run binding tests; verify pass.**

  Run:

  ```bash
  npx vitest run test/providers/registry.test.ts test/index.test.ts
  ```

  Expected: PASS. Startup accepts one validated package, invalid present config aborts, and changed bytes block dispatch.

### Task 3: Wire binding through startup, boundary, tools, and commands

**Files:**
- Modify: `src/index.ts`
- Modify: `src/boundary/integration/register.ts`
- Modify: `src/tools/ship/index.ts`
- Modify: `src/tools/db/index.ts`
- Modify: `src/gate.ts`
- Modify: `test/index.test.ts`
- Modify: `test/boundary/integration/register.test.ts`
- Modify: `test/tools/ship/index.test.ts`
- Modify: `test/tools/db/index.test.ts`
- Create or modify: `test/gate.test.ts`

**Consumes:** Task 2 immutable binding and Task 1 composed schemas.

**Produces:** selected tool schemas, selected command registration, one manifest source for boundary/fingerprints, dispatch drift guard.

- [ ] **Step 1: Write wiring regression tests.**

  Record tools and commands from default extension factory:

  ```ts
  expect(local.tools.map((x) => x.name)).toEqual(["DB"]);
  expect(railway.tools.map((x) => x.name)).toEqual(["ship", "DB"]);
  expect(railway.commands).toEqual([
    "ship-init", "ship-plan", "ship-apply", "ship-status", "ship-logs", "ship-rollback",
  ]);
  expect(vercel.commands).toEqual([]);
  expect(cloudflare.commands).toEqual([]);
  expect(neon.commands).toEqual([]);
  ```

  Assert registered `DB` schemas under Cloudflare/Vercel accept shared `inspect`, `query`, and `import`. Assert direct public `registerShip`/`registerDB` calls without binding retain broad schema and existing per-call manifest behavior. Assert denied `apply_plan` remains blocked by `registerGate`; exclusive-mode mutation still enters `runApprovedOperation` capability path. Add `executeApprovedOperation` tests: legacy three-argument call uses provider-map fallback; optional selected boundary-resource override wins; default extension rejects plan provider differing from selected package before capability minting.

- [ ] **Step 2: Run wiring tests; verify failure.**

  Run:

  ```bash
  npx vitest run test/index.test.ts test/boundary/integration/register.test.ts test/tools/ship/index.test.ts test/tools/db/index.test.ts test/gate.test.ts
  ```

  Expected: FAIL because current DB schema is universal, boundary rereads manifest, and registry registers commands for all packages when manifest exists.

- [ ] **Step 3: Implement single-binding wiring.**

  In `src/index.ts`, build binding before boundary. Register gate unconditionally. Pass binding and narrowed composed parameters to both registrations. Register `ship` only when `binding.profile.ship.length > 0`; always register `DB` with `composeDBSchema(binding.profile.databaseAdditions)`. Keep exported registration signatures optional/backward-compatible: direct callers without binding retain broad parameters and existing per-call behavior.

  Change `registerBoundary` to receive `ProviderRuntimeBinding`; derive `loadBoundaryConfig` from `binding.manifest` or default local config. Remove manifest file probing and raw re-read there.

  Default-bound `registerShip`/`registerDB` calls `await binding.assertIntact(ctx.cwd)` exactly once as first executable dispatch statement, before parameter validation, handler lookup, shared DB work, or provider dispatch. Do not call it again lower in stack. Use binding `manifest`/`package`, never `providerRegistry.loadManifest(cwd)` per bound call. `contextFingerprints` derives provider/manifest fingerprints from binding values.

  Preserve exported `executeApprovedOperation(vault, binding, fn)`; add optional resource override. Default extension passes `binding.profile.boundaryResource`, verifies approved plan provider equals `binding.package.id`, then mints. Legacy three-argument callers retain `PROVIDER_RESOURCE` fallback. Missing selected resource or provider mismatch fails closed. Keep broad static types in gate imports; gate still intercepts `apply_plan` independently from registration schema.

  Register commands only through selected package. Interpose recording/wrapping extension API so only names in `binding.profile.commands` may register; reject undeclared registrations with `E_CONFIG_INVALID`. Every accepted command handler calls `await binding.assertIntact(ctx.cwd)` exactly once at top before original handler. Pass command `RegistryServices` bound to startup binding: `loadManifest: async () => binding.manifest` returns cached validated manifest and never reads disk after guard; `loadState`, `saveState`, `loadPlan`, and `persistPlan` close over `binding.cwd`, not `ctx.cwd`, preventing post-guard command-context TOCTOU.

- [ ] **Step 4: Re-run wiring tests; verify pass.**

  Run:

  ```bash
  npx vitest run test/index.test.ts test/boundary/integration/register.test.ts test/tools/ship/index.test.ts test/tools/db/index.test.ts test/gate.test.ts
  ```

  Expected: PASS. Registration narrows surface only; approval and vault tests remain green.

### Task 4: Make ADR capability table executable

**Files:**
- Create: `test/docs/provider-capability-matrix.test.ts`
- Modify: `test/providers/capability-profile.test.ts`
- Modify: `docs/adr/0012-provider-scoped-tool-surfaces.md`

**Consumes:** Task 1 profile declarations and accepted ADR table.

**Produces:** profile-to-documentation drift test.

- [ ] **Step 1: Write failing documentation matrix test.**

  Read ADR as UTF-8. Extract actual markdown table rows delimited by `| Profile |` and next blank heading; split cells and compare each complete row against expected tokens, not provider names only. Assert local row has DB-only/eight actions; Railway row has `previewId`, `targetReleaseId`, `plan_migration`, and six command tokens; Vercel/Cloudflare rows have no preview-ID allowance, `targetReleaseId`, and common DB/no migration addition; Neon row has `development`, no logs, `targetReleaseId`, owned-restore-point wording, and `plan_migration`. Independently assert profile declarations contain matching schema variants/additions/command lists.

- [ ] **Step 2: Run matrix test; verify failure.**

  Run:

  ```bash
  npx vitest run test/providers/capability-profile.test.ts test/docs/provider-capability-matrix.test.ts
  ```

  Expected: FAIL until parser/profile expectations exist.

- [ ] **Step 3: Implement only test/parser support required by Task 1 profile exports.**

  Keep ADR table as approved human document. Do not generate docs, add a dependency, or duplicate provider runtime behavior in test.

- [ ] **Step 4: Re-run matrix test; verify pass.**

  Run:

  ```bash
  npx vitest run test/providers/capability-profile.test.ts test/docs/provider-capability-matrix.test.ts
  ```

  Expected: PASS. Any capability-token loss, rollback omission, or stale matrix cell fails explicitly.

### Task 5: Full verification

**Files:** all files above.

- [ ] **Step 1: Type-check.**

  Run:

  ```bash
  npm run typecheck
  ```

  Expected: PASS; no schema/type-cycle errors.

- [ ] **Step 2: Run provider-surface regressions.**

  Run:

  ```bash
  npx vitest run test/providers/capability-profile.test.ts test/providers/registry.test.ts test/tools/schema.test.ts test/index.test.ts test/boundary/integration/register.test.ts test/tools/ship/index.test.ts test/tools/db/index.test.ts test/gate.test.ts test/docs/provider-capability-matrix.test.ts
  ```

  Expected: PASS; invalid manifest has no downgrade, all profiles retain shared DB actions, drift fails before dispatch.

- [ ] **Step 3: Run project verification.**

  Run:

  ```bash
  npm test
  npm run acceptance
  git diff --check
  ```

  Expected: PASS; no persisted-format fixture changes and no whitespace errors.

## Files to Modify

- `src/providers/contracts.ts` — profile property.
- `src/persistence/manifest-store.ts` — startup binding and drift guard.
- `src/providers/registry.ts` — binding facade/selected package services.
- `src/tools/ship/schema.ts` — shared ship catalog/composer.
- `src/tools/db/schema.ts` — shared DB catalog/composer.
- `src/index.ts` — binding-first registration.
- `src/boundary/integration/register.ts` — binding-fed boundary config.
- `src/tools/ship/index.ts` — profile schema and bound dispatch.
- `src/tools/db/index.ts` — profile schema and bound fingerprint/dispatch.
- `src/gate.ts` — retain independent approval behavior under new types.
- `src/providers/{railway,vercel,cloudflare,neon}/package.ts` — profile declarations.
- Tests listed in File Structure.

## New Files

- `src/providers/capability-profile.ts` — profile types/local profile/matrix helpers.
- `test/providers/capability-profile.test.ts` — exact profile schema checks.
- `test/docs/provider-capability-matrix.test.ts` — ADR/profile matrix parity.

## Dependencies

```text
Task 1 catalog/profile
  └─ Task 2 binding
      └─ Task 3 startup/boundary/tool/command wiring
          └─ Task 4 executable ADR matrix
              └─ Task 5 full verification
```

## Risks

- `Type.Union` members must stay strict; profile tests must exercise forbidden extra `previewId` fields.
- `registerBoundary` currently parses independently. Binding must be built first or parse-once contract fails.
- Pi has no tool unregister. Invalid present manifest must throw before any registration.
- Byte digest treats formatting-only manifest edits as drift. This is intentional immutable-binding behavior; local binding also rejects later manifest creation.
- Canonical runtime cwd mismatch must fail before manifest access. Guard placement is exactly once at dispatch top to avoid duplicate reads or inconsistent error order.
- Public broad schemas and direct registration/helper APIs must stay source-compatible while default extension uses narrow immutable binding.
- Profile schema narrowing must not change gate/vault behavior or generic external/local DB routing.
