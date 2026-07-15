# Research: Database Provider Parity — Neon, Railway, Vercel

## Summary

`src/tools/db/index.ts` handles `inspect`, `browse`, `query`, `plan`, and `db-plan/1` `apply_plan` generically — before provider dispatch — using only `DATABASE_URL`. Provider db-ops need only implement `plan_migration` (their own plan type) and non-db-plan/1 `apply_plan`. Vercel db-ops throw `E_PHASE_UNSUPPORTED` in Phase 0. `migration_status` is stubbed across all three providers with no implementation. The generic path has strong safety (BEGIN READ ONLY, timeouts, bounded rows, journal replay protection); provider-specific paths add authorization wrappers but bypass the generic journal for migration plans.

## Flow Diagram

```
DB tool execute()
│
├─ inspect ──────────────► generic: inspectDatabase()          [no provider dispatch]
├─ browse ───────────────► generic: executeBrowse()             [no provider dispatch]
├─ query ────────────────► generic: executeReadQuery()          [no provider dispatch]
├─ plan ─────────────────► generic: buildDatabasePlan()         [no provider dispatch]
│                           persists as db-plan/1
│
├─ apply_plan
│   ├─ plan.kind==="db-plan/1" ──► generic: applyDatabasePlan() [direct connection]
│   │                               Uses DATABASE_URL, journal, no provider
│   └─ plan.kind!=="db-plan/1" ──► provider dispatch             [plan_migration plans]
│
├─ plan_migration ───────► provider dispatch only
│   Neon:   buildNeonPlan() + approval
│   Railway: buildRailwayPlan() + approval
│   Vercel: E_PHASE_UNSUPPORTED
│
└─ migration_status ────► provider dispatch only (ALL STUBS)
    Neon:   "requires database connection"
    Railway: "requires provider deployment metadata"
    Vercel:  E_PHASE_UNSUPPORTED
```

## Findings

### 1. Generic path (db/index.ts) handles most DB actions before provider dispatch

**File:** `src/tools/db/index.ts` (lines 77–171)

The `DB` tool execute function has three sequential dispatch tiers:

**Tier 1 — Generic read/query (lines 78–117):**
- `inspect` → `inspectDatabase(url, clientFactory, signal)` in `src/database/inspect.ts`
- `browse` → `executeBrowse(url, clientFactory, { schema, table, columns, filters, orderBy, limit, offset }, signal)` in `src/database/browse.ts`
- `query` → `executeReadQuery(url, clientFactory, { sql, params, limit, signal })` in `src/database/read.ts`

All three require `DATABASE_URL` via `requireDatabaseUrl()` (line 79ff). No manifest or provider is loaded. These are pure PostgreSQL wire-protocol operations.

**Tier 2 — Generic plan + apply (lines 120–169):**
- `plan` → `classifySQL()` → `buildDatabasePlan()` → `persistDatabasePlan()` (line 120–138). Stores as `db-plan/1` kind.
- `apply_plan` checks `plan.kind === "db-plan/1"` (line 143). If matched, runs `applyDatabasePlan()` from `src/database/apply.ts` — which directly connects to PostgreSQL via `DATABASE_URL`, runs statements in a transaction with journaled replay protection. No provider involvement.

**Tier 3 — Provider dispatch (lines 171–179):**
Everything else (`plan_migration`, `migration_status`, and non-db-plan/1 `apply_plan`) loads the manifest and calls `providerRegistry.getDatabaseOpsHandler(manifest)`.

**Source:** `src/tools/db/index.ts`

---

### 2. What each provider db-ops actually needs beyond the generic path

**Neon** (`src/providers/neon/db-ops.ts`):
- `plan_migration`: Builds a `NeonPlan` (non-db-plan/1 kind), requests approval, persists via `services.persistPlan("neon", plan)`. Uses manifest `migrations.command`.
- `apply_plan`: Loads Neon plan, authorizes via `authorizeNeonPlanApply`, creates Neon API adapter, calls `applyNeonPlan()`.
- `inspect`: Stub — returns "Database inspection unavailable via Neon provider."
- `browse`, `query`, `plan`: Throw `E_PHASE_UNSUPPORTED`.
- `migration_status`: Stub — returns "Migration status requires database connection."

**Railway** (`src/providers/railway/db-ops.ts`):
- `plan_migration`: Builds a `RailwayPlan`, requests approval via `requestRailwayApproval`, persists.
- `apply_plan`: Loads Railway plan, authorizes via `authorizeRailwayPlanApply`, creates Railway execution adapter, calls `applyRailwayPlan()`.
- `inspect`: Stub — returns "Database inspection unavailable without provider query."
- `browse`, `query`, `plan`: Throw `E_PHASE_UNSUPPORTED`.
- `migration_status`: Stub — returns "Migration status requires provider deployment metadata."

**Vercel** (`src/providers/vercel/db-ops.ts`):
- All actions: Throw `E_PHASE_UNSUPPORTED` — "V2 database operations are unavailable in Phase 0."

**Conclusion:** Provider db-ops only need `plan_migration` and (non-db-plan/1) `apply_plan`. The three generic read/query actions (`inspect`, `browse`, `query`) are already handled upstream. The `plan` action for ad-hoc SQL (which creates db-plan/1) is also generic.

**Source:** `src/providers/neon/db-ops.ts`, `src/providers/railway/db-ops.ts`, `src/providers/vercel/db-ops.ts`

---

### 3. `migration_status` — journal-backed design gap

**Current state:** All three providers stub `migration_status`:

| Provider | Stub Message | File |
|----------|-------------|------|
| Neon | "Migration status requires database connection." | `src/providers/neon/db-ops.ts:169` |
| Railway | "Migration status requires provider deployment metadata." | `src/providers/railway/db-ops.ts:142` |
| Vercel | (throws `E_PHASE_UNSUPPORTED`) | `src/providers/vercel/db-ops.ts:10` |

**Architecture analysis:**

The generic `db-plan/1` path already has a journal (`src/database/journal.ts`):
- Path: `.pi-ship/database-journal.jsonl`
- Entries: `{ planId, planDigest, status: "started"|"committed"|"failed"|"ambiguous", at, errorCode?, hash chain }`
- Read via `readDatabaseJournal(cwd)` → validates hash chain integrity
- Used by `applyDatabasePlan()` for replay protection

For Neon and Railway **migration** plans (their own plan types, not `db-plan/1`), the current `plan_migration` + `apply` flow does **not** write to the generic journal. The `applyMigration()` functions in each provider call `applyNeonPlan()`/`applyRailwayPlan()` directly, which may have their own state tracking (e.g., Railway writes to `railway-state.json`, Neon writes to `neon-state.json`) but there's no unified `migration_status` query path.

**Design recommendation:**

A proper `migration_status` implementation should:
1. Read the generic database journal for all `db-plan/1` entries → provide status of ad-hoc SQL plans
2. For provider migration plans, either:
   a. **Option A**: Write generic journal entries during migration apply (extend `DatabaseJournalEntry` to accommodate non-db-plan/1 plans)
   b. **Option B**: Each provider implements its own `migration_status` by reading its own state/plan store and/or calling its API (Neon API for branch status, Railway API for deployment status)

Option A is cleaner for parity — the journal becomes the single source of truth for all database mutations.

**Source:** `src/database/journal.ts`, `src/providers/neon/db-ops.ts`, `src/providers/railway/db-ops.ts`

---

### 4. Railway DB actions — realistic constraints from Git-based deploy model

Railway uses a Git-based deployment model. The migration flow in `src/providers/railway/db-ops.ts`:

- `plan_migration`: Builds a `RailwayPlan` with metadata (projectId, environmentId, serviceIds). Requires `manifest.db.migrate.command` in the Railway manifest. Requests human approval.
- `apply_plan`: Loads the plan, authorizes, creates a Railway execution adapter (which wraps Railway API calls), and calls `applyRailwayPlan()`.

The Railway execution adapter (`src/providers/railway/adapter.ts`) interacts with Railway's REST API — it does NOT connect directly to PostgreSQL. Instead, it:
1. Runs migration commands via Railway's execution environment (triggered through Railway API)
2. Uses Railway's secret resolution for credentials

**Constraint:** Railway migrations run as commands inside Railway's infrastructure, not as direct SQL. This means:
- The generic `applyDatabasePlan()` path cannot handle Railway migrations — Railway's model requires command execution, not direct SQL.
- Railway `plan_migration` is conceptually different from the generic `plan` action (which classifies raw SQL).
- The `browse`, `query`, `inspect` stubs are correct — Railway cannot provide direct database access through its API; you'd need a separate PostgreSQL proxy/direct connection.

**Recommendation:** Railway db-ops should remain implementing only `plan_migration` and `apply_plan` with command-based execution. The generic read path is correct for any provider that has a `DATABASE_URL`. Railway users who need direct DB access should configure a separate DATABASE_URL (e.g., via Railway public networking) and the generic path handles it.

**Source:** `src/providers/railway/db-ops.ts`, `src/providers/railway/package.ts`, `src/providers/railway/adapter.ts`

---

### 5. Vercel `urlSecretName` → DATABASE_URL resolution contract

**Manifest schema** (`src/providers/vercel/manifest.ts`):

```typescript
database: Type.Optional(Type.Object({
    provider: Type.Literal("external"),
    config: Type.Object({ urlSecretName: NonEmpty }, Strict),
}, Strict))
```

**Validation** (same file, `validateVercelManifestSemantics`):
- `provider` must be `"external"` — Vercel Postgres/Neon managed databases are not supported.
- `urlSecretName` is the name of a Vercel secret (e.g., `"DATABASE_URL"` or `"PROD_DATABASE_URL"`).
- The secret name **must** appear in the top-level `secrets` array in the manifest.

**Resolution contract:**
When the Vercel provider needs a DATABASE_URL (for generic `inspect`/`browse`/`query`/`plan`/`apply_plan`), it:
1. Reads `manifest.database.config.urlSecretName`
2. Fetches that secret from Vercel's API via `requireVercelCredentials` / `createVercelClient`
3. Injects the resolved value as `DATABASE_URL` into the credential source

**Current status:** Phase 0 — `handleVercelDatabaseOps` throws `E_PHASE_UNSUPPORTED`. The Vercel `createExecution` factory (`src/providers/vercel/package.ts`) does not yet wire secret resolution into the credential source for DB actions.

**When implemented, the flow would be:**
```
Vercel manifest with database.config.urlSecretName
  → providerRegistry.getDatabaseOpsHandler resolves to handleVercelDatabaseOps
  → handler reads urlSecretName from manifest
  → handler fetches secret value via Vercel API (using vercelClient from execution)
  → credentialSource.get("DATABASE_URL") returns the resolved value
  → generic path (inspect/browse/query/plan/apply_plan) works automatically
  → OR handler implements plan_migration/apply_plan for Vercel-specific flows
```

**Source:** `src/providers/vercel/manifest.ts`, `src/providers/vercel/package.ts`, `src/providers/vercel/db-ops.ts`

---

### 6. Safety guardrails — generic path

**File** `src/database/read.ts` — `executeReadQuery()`:
| Guardrail | Value |
|-----------|-------|
| Transaction | `BEGIN READ ONLY` (line 79) — prevents any writes |
| `statement_timeout` | `5000ms` (line 83) |
| `lock_timeout` | `1000ms` (line 86) |
| Cursor | DECLARE NO SCROLL CURSOR + FETCH (lines 90–96) |
| Max LIMIT | 200 rows (`MAX_FETCH_LIMIT`, line 9) |
| Default LIMIT | 100 rows |
| Signal checks | Before every operation (connect, BEGIN, SET, DECLARE, FETCH) |
| Error mapping | `mapSQLError()` strips raw messages, SQL, params, URL, rows |

**File** `src/database/inspect.ts` — `inspectDatabase()`:
| Guardrail | Value |
|-----------|-------|
| Transaction | `BEGIN READ ONLY` (line 368) |
| `statement_timeout` | `5000ms` (line 372) |
| `lock_timeout` | `1000ms` (line 375) |
| Per-category limit | 500 rows (`CATEGORY_LIMIT`, line 6) |
| Total output budget | 512 KiB (`OUTPUT_MAX_BYTES`, line 7) — enforced via `enforceTotalBudget()` |
| Signal checks | Before each category query |

**File** `src/database/apply.ts` — `applyDatabasePlan()`:
| Guardrail | Value |
|-----------|-------|
| Transaction | `BEGIN` (not READ ONLY — this is for writes) |
| `statement_timeout` | `30000ms` (line 217) — longer for migrations |
| `lock_timeout` | `5000ms` (line 218) |
| Journal replay protection | `preflight()` checks journal for committed/ambiguous/dangling-started |
| Fingerprint verification | Target, provider, manifest fingerprints all checked before apply |
| Re-classification | SQL re-parsed at apply time, compared with plan fingerprints |
| Production guard | `PI_SHIP_ALLOW_PRODUCTION_DB_WRITES` env var (line 148) |
| Approval check | `registry.isApproved()` (line 137) |
| Signal checks | Before each statement, after COMMIT attempt |
| Error classification | `classifyError()` maps SQLSTATE codes to safe error types |
| Ambiguous state detection | If COMMIT fails after write dispatch, marks `"ambiguous"` in journal |

**File** `src/database/classifier.ts` — SQL classification:
- Max 20 statements per input
- Max 100 parameters
- Blocked function detection (pg_sleep, pg_advisory_lock, etc.)
- AST allowlist (PG17 `@pgsql/parser` v17) — unknown AST tags rejected
- DML/DDL risk classification (read, write, destructive, blocked)

**File** `src/database/plan.ts` — `DatabasePlan` schema:
- `kind: "db-plan/1"` literal
- All fingerprints are SHA-256 hex (64 chars)
- Max 20 statements, max 100 params, max 100 tables per statement
- Digest computed over deterministic canonical JSON — tamper-evident

**File** `src/database/journal.ts`:
- Hash chain: each entry includes `previousHash` of previous entry
- Append-only JSONL at `.pi-ship/database-journal.jsonl`
- Replay detection: `assertDatabaseReplayAllowed()` rejects committed, ambiguous, or dangling-started plans
- Status transitions: started → committed|failed|ambiguous (terminal)

**Provider-specific safety:**

**Neon** (`src/providers/neon/db-ops.ts`):
- `authorizeNeonPlanApply()` before apply (line 135)
- Plan environment must match current environment (line 123)
- Production writes require `PI_SHIP_ALLOW_PRODUCTION_DB_WRITES` (line 130)
- State validation via `requireState()` (line 134)

**Railway** (`src/providers/railway/db-ops.ts`):
- `authorizeRailwayPlanApply()` before apply (line 102)
- Preview environment not supported in MVP (line 41)
- Production migrations require `manifest.db.migrate.allowProductionMigrations` (line 47)
- Plan environment match check (line 94)
- Production writes require `PI_SHIP_ALLOW_PRODUCTION_DB_WRITES` (line 98)

**Source:** `src/database/read.ts`, `src/database/inspect.ts`, `src/database/apply.ts`, `src/database/classifier.ts`, `src/database/plan.ts`, `src/database/journal.ts`, `src/providers/neon/db-ops.ts`, `src/providers/railway/db-ops.ts`

---

## What each provider MUST implement vs generic path

| Action | Generic path | Neon | Railway | Vercel |
|--------|-------------|------|---------|--------|
| `inspect` | ✅ `inspectDatabase()` | Stub (redundant) | Stub (redundant) | ❌ Phase 0 |
| `browse` | ✅ `executeBrowse()` | Unsupported | Unsupported | ❌ Phase 0 |
| `query` | ✅ `executeReadQuery()` | Unsupported | Unsupported | ❌ Phase 0 |
| `plan` (ad-hoc SQL) | ✅ `buildDatabasePlan()` | Unsupported | Unsupported | ❌ Phase 0 |
| `plan_migration` | ❌ Provider ONLY | ✅ `buildNeonPlan()` | ✅ `buildRailwayPlan()` | ❌ Phase 0 |
| `apply_plan` (db-plan/1) | ✅ `applyDatabasePlan()` | N/A (db-plan/1) | N/A (db-plan/1) | ❌ Phase 0 |
| `apply_plan` (migration) | ❌ Provider ONLY | ✅ `applyNeonPlan()` | ✅ `applyRailwayPlan()` | ❌ Phase 0 |
| `migration_status` | ❌ Not implemented | ❌ Stub | ❌ Stub | ❌ Phase 0 |

**Key insight:** The Neon and Railway `inspect` stubs are dead code — `inspect` is caught by the generic path before provider dispatch. Same applies to `browse`, `query`, `plan`. These stubs never execute unless someone removes the generic handler.

**Source:** `src/tools/db/index.ts` lines 78–117 (generic catch), `src/providers/neon/db-ops.ts` lines 166–173 (dead stubs), `src/providers/railway/db-ops.ts` lines 139–146 (dead stubs)

---

## Vercel urlSecretName contract

### Schema
```typescript
// src/providers/vercel/manifest.ts:20-23
database: Type.Optional(Type.Object({
    provider: Type.Literal("external"),
    config: Type.Object({ urlSecretName: NonEmpty }, Strict),
}, Strict))
```

### Validation rules
```typescript
// src/providers/vercel/manifest.ts:38-41
if (manifest.database && !(manifest.secrets ?? []).includes(manifest.database.config.urlSecretName)) {
    throw err("E_CONFIG_INVALID", "database.config.urlSecretName must appear in secrets");
}
```

### Resolution contract
1. `database.provider` must be `"external"` — rules out Vercel Postgres/Neon managed DB
2. `database.config.urlSecretName` — name of a Vercel Project Secret or Environment Variable
3. The secret **must** appear in `manifest.secrets[]` — this ensures the secret is declared for deployment access
4. At runtime, the Vercel provider fetches the secret value via Vercel API (`GET /v9/projects/{projectId}/secrets/{secretName}`)
5. The resolved value becomes the `DATABASE_URL` for the generic DB path

### Open questions (Phase 0)
- Does the secret value contain the full connection string or just credentials?
- How is the secret cached/refreshed?
- Is the secret resolved per-environment (development/preview/production)? Vercel supports environment-scoped secrets.

---

## Safety guardrails summary

### Generic path (always active)
- `BEGIN READ ONLY` for all read operations
- `statement_timeout`: 5000ms reads, 30000ms writes
- `lock_timeout`: 1000ms reads, 5000ms writes
- Max rows: 200 (reads), 500 per category (inspect), unlimited (writes — bounded by transaction)
- Output budget: 512 KiB (inspect)
- SQL classification: AST allowlist (PG17), blocked functions, max 20 statements
- Parameter validation: finite scalars only, contiguous references
- Error safety: `mapSQLError()` — no raw text/SQL/URL/params/rows in errors
- Journal replay protection: hash chain, status checks, fingerprint verification
- Production guard: `PI_SHIP_ALLOW_PRODUCTION_DB_WRITES` must be `"true"`

### Provider-specific safety
- Neon: `authorizeNeonPlanApply()` — verifies plan integrity, approval, environment match
- Railway: `authorizeRailwayPlanApply()` — same pattern, plus Railway-specific state checks
- Both: Preview environment restrictions, production guard flags

---

## Recommendations

1. **Remove dead provider stubs** — Neon and Railway `inspect`, `browse`, `query`, `plan` stubs are unreachable. The generic path in `db/index.ts` catches these before provider dispatch. Removing them eliminates confusion about where each action is handled.

2. **Implement `migration_status` using the journal** — Extend `DatabaseJournalEntry` or create a provider-agnostic status query that reads `.pi-ship/database-journal.jsonl`. For provider migration plans (non-db-plan/1), either:
   - Write journal entries during provider `apply_plan`, or
   - Implement provider-specific `migration_status` that reads the provider's own state

3. **Keep provider db-ops minimal** — Only `plan_migration` and (non-db-plan/1) `apply_plan` are genuine provider responsibilities. Everything else is generic PostgreSQL.

4. **Vercel Phase 1 integration** — When implementing Vercel db-ops:
   - Resolve `urlSecretName` → DATABASE_URL via Vercel API
   - Let the generic path handle `inspect`, `browse`, `query`, `plan`, and db-plan/1 `apply_plan`
   - Only implement `plan_migration` / `apply_plan` if Vercel-specific migration commands are needed

5. **Plan type audit** — Ensure the plan kind convention (`db-plan/1` for generic, provider-specific for migrations) is documented and enforced in schema validation. Currently, Neon and Railway plans have their own `isPlan` validators that do not use the `db-plan/1` kind.

---

## Sources

### Kept
- `src/tools/db/index.ts` — Central DB tool dispatch, shows generic-vs-provider boundary
- `src/providers/neon/db-ops.ts` — Neon provider: migration plan/apply, stubs for rest
- `src/providers/railway/db-ops.ts` — Railway provider: same pattern as Neon
- `src/providers/vercel/db-ops.ts` — Vercel provider: all unsupported in Phase 0
- `src/database/classifier.ts` — SQL parsing, AST allowlist, risk classification
- `src/database/browse.ts` — Generic browse SELECT generation
- `src/database/plan.ts` — `db-plan/1` schema, fingerprinting, persistence
- `src/database/apply.ts` — Generic transaction-based plan apply with journal
- `src/database/journal.ts` — Append-only hash-chain journal for replay protection
- `src/database/read.ts` — Generic read-only cursor query execution
- `src/database/inspect.ts` — Fixed pg_catalog schema inspection
- `src/database/client.ts` — Client interface, factory, error mapping
- `src/providers/vercel/manifest.ts` — Vercel manifest schema with `urlSecretName` validation
- `src/providers/registry.ts` — Provider registry and dispatch
- `src/providers/contracts.ts` — ProviderPackage interface including `getDatabaseOpsHandler`
- `src/providers/neon/package.ts` — Neon package registration
- `src/providers/railway/package.ts` — Railway package registration
- `src/providers/vercel/package.ts` — Vercel package registration
- `src/tools/db/schema.ts` — DB input schema (all supported actions)
- `src/tools/db/contracts.ts` — DatabaseHandler type + context

### Dropped
- (none — all read files informed the analysis)

---

## Gaps

1. **Neon and Railway `inspect`/`browse`/`query`/`plan` stubs are dead code.** They exist in provider db-ops files but are never reached because the generic path catches these actions first. Confirmed by reading the dispatch order in `src/tools/db/index.ts` lines 78–117.

2. **`migration_status` has no implementation across any provider.** The schema defines it (`src/tools/db/schema.ts:54`), both Neon and Railway return placeholder strings, Vercel throws. No mechanism exists to query migration status.

3. **Vercel `urlSecretName` resolution is unaddressed.** The manifest schema and validation exist, but the Phase 0 handler throws. The resolution pipeline (fetch secret → inject as DATABASE_URL → generic path) is not wired.

4. **Provider migration plans bypass the generic journal.** Neon and Railway `apply_plan` write to their own state stores, not to `database-journal.jsonl`. This means `migration_status` cannot be answered by reading the journal alone — it needs provider-specific state access.

### Suggested next steps
- Audit and remove dead provider stubs after confirming generic path coverage
- Design `migration_status` — choose between unified journal entries vs provider-specific implementations
- Implement Vercel secret resolution pipeline for Phase 1
- Consider adding a `kind` discriminator to `DatabaseJournalEntry` to support both `db-plan/1` and provider-specific plan types

---