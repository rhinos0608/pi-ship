# ADR 0012: Provider-scoped tool surfaces

## Status

Accepted — user approval recorded 2026-07-16.

## Context

`pi-ship.json` already identifies one provider manifest, but startup currently checks only file presence. `ship` and `DB` register broad static TypeBox unions, commands register for every package, and handlers reload manifest at dispatch. This exposes unsupported actions to agent, duplicates manifest reads, and permits runtime configuration drift between plan and apply.

`DB` is both provider-independent database surface and provider-extension surface. Generic `inspect`, `browse`, `query`, `plan`, `apply_plan`, `migration_status`, `import`, and `reset` must remain available for local and external targets under every selected provider. Provider migration is additive only.

Approval gate and credential vault enforce execution. Registration/schema narrowing improves discoverability; it is not authorization.

## Decision

### Startup selector and immutable binding

Root `pi-ship.json` is runtime selector. Startup constructs one `ProviderRuntimeBinding`:

1. Read manifest bytes once.
2. Missing file (`ENOENT`) selects local profile only.
3. Present file parses once, resolves exactly one `ProviderPackage`, and invokes package semantic validation once.
4. Invalid JSON, unreadable file, ambiguous package, unsupported provider/version, invalid semantics, or invalid profile aborts startup. Present invalid configuration never downgrades to local mode.
5. Binding stores selected package, manifest, profile, and SHA-256 digest of original bytes.

Binding captures canonical startup cwd as well as manifest digest. Before every `ship`, `DB`, and selected provider-command dispatch, `assertIntact(runtimeCwd)` first requires canonical runtime cwd to equal canonical startup cwd, then rereads manifest bytes and compares digest. Changed, newly created, missing, or unreadable manifest fails before provider handler dispatch; this includes a local binding followed by creation of `pi-ship.json`. Each tool/command dispatch calls guard exactly once at top of dispatch, then uses cached binding. Drift check reads and hashes only; it does not parse or validate again. `E_STATE_CONFLICT` is used for detected runtime cwd/manifest drift; startup contract failures retain `E_CONFIG_INVALID`.

Boundary registration receives selected binding/manifest. It does not reread configuration. DB plan fingerprints use binding provider/manifest data, not a second manifest load.

### Capability profiles and schemas

Each `ProviderPackage` declares one typed `ProviderCapabilityProfile` containing:

- exact TypeBox `ship` variants;
- provider DB additions;
- supported command names;
- boundary resource binding.

Shared TypeBox catalog owns common variants in `src/tools/ship/schema.ts` and `src/tools/db/schema.ts`. Profiles compose catalog variants; providers do not create arbitrary tool names or redefine common `apply_plan` shapes. Public compatibility `shipSchema`/`ShipInput` remains broad union of every profile variant, explicitly including Neon `development`; public `DBSchema`/`DBInput` remains broad union and retains `plan_migration`. Registration alone receives narrowed composed schemas. Registered tool names remain exact `ship` and `DB`. Persisted plan, state, journal, and approval formats remain unchanged.

Local profile has no `ship` tool, no provider commands, and this exact `DB` set:

`inspect`, `browse`, `query`, `plan`, `apply_plan`, `migration_status`, `import`, `reset`.

Every provider profile retains that complete shared DB set. `plan_migration` is an addition for Railway and Neon only. Cloudflare and Vercel retain external/local generic DB support; this decision does not create Cloudflare DB-provider operations.

| Profile | `ship` surface | DB addition | Commands | Boundary resource |
| --- | --- | --- | --- | --- |
| Local/no manifest | none | none | none | generic database resource |
| Railway | validate, plan, apply_plan, status, logs; preview plan requires `previewId`; production rollback requires `targetReleaseId` | plan_migration | ship-init, ship-plan, ship-apply, ship-status, ship-logs, ship-rollback | railway-deployment |
| Vercel | validate, preview/production plan without `previewId`, apply_plan, status, logs; production rollback requires `targetReleaseId` | none | none | vercel-deployment |
| Cloudflare | validate, preview/production plan without `previewId`, apply_plan, status, logs; production rollback requires `targetReleaseId` | none | none | cloudflare-deployment |
| Neon | validate, development/preview/production plan, apply_plan, status; no logs; production rollback requires `targetReleaseId` and resolves owned restore point | plan_migration | none | neon-control-plane |

Railway, Vercel, Cloudflare, and Neon retain production rollback plan variant requiring `targetReleaseId`; Neon resolves that ID to one owned restore point before creating rollback plan. Vercel and Cloudflare plan schemas reject `previewId`. Neon plan schemas accept `development`; Neon logs are omitted because vendor provides no supported log API.

Profile boundary resource binding is default-extension source for capability minting. Exported `executeApprovedOperation(vault, binding, fn)` remains compatible for legacy three-argument callers through existing provider-map fallback; optional resource override lets default extension pass selected profile binding. Default extension verifies approved plan provider equals selected package before minting. Registration permits only `ship` and `DB`; only selected package may register declared command names, and each selected handler is wrapped with one top-of-dispatch `assertIntact(ctx.cwd)` guard. Selected command `RegistryServices.loadManifest()` returns cached startup `binding.manifest`, never rereads disk after guard; its state/plan load/save/persist paths use startup binding cwd, not mutable command cwd.

### Enforcement invariant

Schema/registration narrowing is ergonomics, not authorization. `src/gate.ts` continues to gate all `apply_plan` calls. In exclusive mode, mutating provider work continues under vault capability minted from approved binding. Handler action checks remain defense in depth even when schema excludes unsupported actions.

### Neon apply binding

Without changing persisted formats, Neon authorization compares `plan.manifest` canonically and exactly with current manifest. For every non-provision intent, absent `state.projectName` fails closed with `E_STATE_CONFLICT`; present `state.projectName` must equal current `manifest.project`. Expected branch name is derived from plan environment plus current manifest and must exist in `state.branchIds` whenever operation requires existing target. Rollback additionally compares plan `sourceBranchId` and `targetBranchId` with current state and existing rollback fields before adapter mutation. Provision remains permitted only when absent project is expected by provision intent.

This proves current configuration and current named target. Same-name branch ID replacement between plan and apply cannot be proven without a persisted plan-time snapshot; that risk remains out of scope.

## Alternatives considered

### Universal static schemas as registration surface

Rejected. Broad public compatibility schemas remain, but registering them for every provider makes agent see invalid provider actions and discover unsupported operation only at handler runtime.

### Missing/invalid manifest local fallback

Rejected. Invalid present configuration is unsafe ambiguity; startup must fail closed.

### Resolve and validate manifest per call

Rejected. Repeated parsing allows provider/profile drift during extension lifetime and violates startup binding contract.

### Provider-owned arbitrary tools or commands

Rejected. Tool names must remain `ship` and `DB`; packages may not expand agent authority by declaring arbitrary tool names. Existing Railway commands are selected, not cloned for other providers.

### Persist Neon target snapshots now

Rejected. Approved scope forbids persisted format changes. Current-manifest/state checks provide bounded protection; same-name ID replacement residual risk is explicit.

### Fake vendor parity

Rejected. No Neon logs, no Cloudflare DB-provider operations, and no invented Vercel/Cloudflare/Neon commands.

## Consequences

### Positive

- Startup has one validated provider identity and a smaller agent-facing surface.
- Invalid present manifests fail before any pi-ship tool/command registration.
- Profile tests make provider capability matrix executable.
- Cloudflare/Vercel keep shared external and local DB workflows.
- Approval/vault enforcement remains independent from UI surface.

### Negative

- Binding plumbing reaches startup, boundary, tools, DB fingerprints, and command registration.
- Any edit to manifest during session requires reload/restart.
- Capability declarations and catalog need tests to prevent profile/handler drift.
- Neon same-name branch ID replacement remains undetectable without persisted snapshot.

## Verification

- Public-schema tests prove broad `shipSchema`/`ShipInput` accepts every profile form including Neon development and production rollback with `targetReleaseId` for Railway/Vercel/Cloudflare/Neon, broad `DBSchema`/`DBInput` accepts `plan_migration`, and composed registration schemas narrow only exposed surface.
- Public API tests prove direct legacy `registerShip`/`registerDB` calls retain broad/per-call behavior, while default extension passes immutable binding.
- Startup integration tests prove canonical-cwd mismatch, local-to-created-manifest drift, byte drift, invalid-present abort, selected declared commands only, one top-of-dispatch guard before handler work, and selected command services returning startup manifest/bound cwd without disk reread.
- Gate/vault and `executeApprovedOperation` tests prove narrowing does not bypass approval/capability; default binding requires plan provider match while legacy three-argument helper retains provider-map fallback.
- Capability-matrix test parses actual ADR table rows and compares exact cell tokens/expectations against profile declarations; provider-name-only checks are insufficient.
- `scripts/acceptance.mjs` explicit list includes Railway, Vercel, Cloudflare, Neon, and database acceptance files. Run `npm run typecheck`, `npm test`, `npm run acceptance`, and `git diff --check` after implementation.
