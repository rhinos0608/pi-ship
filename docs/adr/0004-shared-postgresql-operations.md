# ADR 0004: Shared PostgreSQL operations

## Status

Accepted

## Context

Phase 0 added the `DB` tool with three shared read actions (`inspect`, `browse`, `query`) and a shared `plan` action. The `apply_plan` action was only implemented per-provider: Railway used migration commands via CLI, and Vercel did not support database mutations.

The database planning and execution model diverges from deployment operations. Database plans are immutable metadata-only fingerprints — they store SQL fingerprints, parameter fingerprints, table references, risk levels, and environment bindings but never raw SQL or parameter values. The actual SQL and parameters live only in an in-memory `DatabasePayloadRegistry`. This means a process restart loses the registered payloads and forces replanning.

Deployment providers track persistent local state (project/service IDs, release history). Database operations need no such state — they only need the connection string, the persisted plan, the in-memory payload, approval, and a fresh PostgreSQL client per apply. Provider manifests (`pi-ship.json`) may be absent for database-only workflows; when present, their fingerprints guard against plan-manifest drift.

Existing ADRs 0001, 0002, and 0003 describe restrictions on database tool naming and public access. This ADR supersedes those restrictions to the extent that they limited shared database tooling design; it does not supersede the deployment provider architecture or provider-package boundaries.

## Decision

### Shared database apply kernel

A provider-free `applyDatabasePlan` function in `src/database/apply.ts` implements the shared database apply lifecycle:

1. **Strict plan loading** — `loadDatabasePlan` validates shape, identity, and digest.
2. **Environment match** — the operational environment must equal the plan's stored environment.
3. **Target fingerprint match** — `DATABASE_URL` must hash to the same target fingerprint.
4. **Provider and manifest fingerprints** — current context fingerprints must equal the plan's. Absent manifest uses deterministic `"none"` hashes.
5. **Scoped approval** — `{ domain: "database", risk: plan.riskLevel }` is required. Generic, deployment, or mismatched-risk approvals cannot unlock database plans.
6. **Production guard** — `PI_SHIP_ALLOW_PRODUCTION_DB_WRITES` must equal the exact lowercase string `true`. `TRUE`, `1`, whitespace, empty, or missing are all denied with `E_APPROVAL_REQUIRED`.
7. **Memory payload** — the SQL and parameters must be registered in the in-memory `DatabasePayloadRegistry`. Restart or registry clear forces replanning.
8. **Reclassification and comparison** — the payload is re-parsed and re-classified, then every fingerprint (SQL, params, risk, destructive reasons, statement fingerprints, tables, param counts) is compared against the persisted plan.
9. **Journal replay check** — the full hash-chained journal is read and validated. Committed, ambiguous, or dangling-started entries for the same plan digest block execution.

### Strict parser

The apply uses the same `@pgsql/parser` strict allowlist and walker as `classifySQL`. No SQL text is ever concatenated or interpolated. Bound parameters are exact prefixes of the payload params per statement (`payload.params.slice(0, statement.paramCount)`), which matches the classifier's contiguous-param-ref contract.

### Transaction execution

Each apply opens one fresh client, appends a `started` journal entry, runs `BEGIN`, `SET LOCAL statement_timeout = '30000ms'`, `SET LOCAL lock_timeout = '5000ms'`, executes all approved statement slices sequentially, then `COMMIT`. Abort checks run before each statement and before `COMMIT`. A dispatch flag is set immediately before each write/destructive query; a commit flag is set before `COMMIT`.

### Failure semantics

| Scenario | Journal outcome | Error |
|---|---|---|
| Connect failure before any statement | `failed` (error code) | mapped, manual retry allowed |
| Definitive SQLSTATE (non-class-08, including 57014) during statement | `failed` (SQLSTATE code) | `E_PROVIDER` / `E_CANCELLED`, manual retry |
| Transport/class-08 error after first write dispatch | `ambiguous` | `E_STATE_CONFLICT`, non-retryable |
| Local abort before write dispatch, clean rollback | `failed` (`E_CANCELLED`) | `E_CANCELLED`, manual retry |
| Local abort after write dispatch with successful rollback | `failed` (`E_CANCELLED`) | `E_CANCELLED`, manual retry |
| Local abort after write dispatch with failed rollback | `ambiguous` | `E_STATE_CONFLICT`, non-retryable |
| Transport/unknown during `COMMIT` | `ambiguous` | `E_STATE_CONFLICT`, non-retryable |
| `COMMIT` acknowledged but journal append fails | dangling `started` persists | `E_STATE_CONFLICT`, non-retryable |
| Factory throw after `started` append | `started` + `failed` | `E_PROVIDER`, non-retryable |

- No automatic retries anywhere.
- Journal entries never contain SQL, parameter values, URLs, credentials, or row data.
- `end()` is always best-effort; its errors are swallowed.
- Error classification inspects `.code` only (SQLSTATE or Node error code).

### Provider migration compatibility

Railway `plan_migration` and `applyMigration` retain existing provider-manifest-based paths. Railway `applyMigration` now additionally checks that `plan.environment` equals the resolved operational environment before mutation. Production legacy migrations additionally require `PI_SHIP_ALLOW_PRODUCTION_DB_WRITES === 'true'`, while retaining the manifest `allowProductionMigrations` flag and existing approval, digest, and state checks.

The `DB.apply_plan` tool action first reads the plan file. If `kind` is `db-plan/1`, it dispatches to the shared `applyDatabasePlan` without involving any provider manifest. Non-db-plan kinds fall through to the provider handler (e.g., Railway `applyMigration`).

### Concurrency

Apply is serialized per-cwd journal path via `withFileMutationQueue`. Multiple applies to the same cwd are queued; a second concurrent apply for the same plan is blocked by journal replay check after acquiring the lock. Different cwds or different journals are independent.

### Excluded features

The following are intentionally out of scope for this kernel:
- Database provisioning or destruction (CREATE/DROP DATABASE).
- Backup, restore, export, or import.
- Connection pooling or reuse.
- Multiple concurrent plan execution (serialized per-cwd journal via `withFileMutationQueue`).
- DDL-only execution (write/destructive risk classification required).
- Live environment or network-dependent tests.

## Alternatives considered

1. **Extend provider engine abstraction** — rejected because database operations have fundamentally different state, journal, and safety requirements from deployment lifecycle operations. A shared abstraction would either be leaky or limit both domains.

2. **Embed all preflight in the tool layer** — rejected because the preflight constraints (fingerprint comparison, reclassification, journal validation) are intrinsic to the apply operation and must travel with it, not be distributed across callers.

3. **Put SQL and parameters in the persisted plan** — rejected to keep on-disk plans safe for audit, git, and sidecar export. The in-memory payload registry provides the same replay-protection guarantees without persistent secret exposure.

4. **Allow generic or deployment-scoped approval to unlock database plans** — rejected because database mutations (especially destructive ones like `DROP` or `TRUNCATE`) require explicit database-scoped consent distinct from deployment approval.

## Consequences

- Database apply no longer requires a provider manifest or provider package — the `DB` tool can plan and apply with only `DATABASE_URL` and `PI_SHIP_DATABASE_ENVIRONMENT`.
- Restart or payload-registry clear forces replanning; this is a safety property, not a limitation.
- Transport errors after the first write dispatch always produce ambiguous state — manual reconciliation is required before replay.
- Journal integrity failures or dangling `started` entries block further applies for that plan digest.
- Railway and Vercel legacy migration paths remain functional but gain environment and production-flag checks.
- All tests use fake PostgreSQL clients — no live database is required.

## Verification

- `npm test` — unit tests pass.
- `npm run typecheck` — no type errors.
- `npm run acceptance` — cloud-free e2e tests pass for Railway deploy, Vercel deploy, and shared DB apply.
- `git diff --check` — no whitespace errors.
- `npm audit --omit=dev` — no new vulnerabilities.
- On-disk plan files and journal entries contain none of the distinctive SQL, parameter values, passwords, or URLs used in tests.
