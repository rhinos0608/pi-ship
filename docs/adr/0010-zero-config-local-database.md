# ADR 0010: Zero-config local database operations

## Status

Accepted

## Context

The `DB` tool currently requires `DATABASE_URL` and `PI_SHIP_DATABASE_ENVIRONMENT` for all shared actions (`inspect`, `browse`, `query`, `plan`, `apply_plan`). Without these, the tool is useless — even for local development where the user just wants a scratch database in their project directory.

ADR 0004 made the database apply kernel provider-free, establishing that database operations can function without a provider manifest. However, the tool still hard-requires `DATABASE_URL` at `src/tools/db/index.ts:41-49,125,146` and `PI_SHIP_DATABASE_ENVIRONMENT` at `src/database/environment.ts:8-17`. There is no fallback path when neither is configured.

Research evaluated two approaches for a zero-config local backend:

1. **Embedded PostgreSQL (PGlite):** Real PostgreSQL 17 compiled to WASM. Full `pg_catalog` introspection, identical SQL dialect, identical SQLSTATE error codes. Supports filesystem persistence. Zero npm dependencies (WASM bundle). ~13M weekly downloads across packages. Used by Prisma `prisma dev` and Drizzle Kit. Tradeoffs: ~500ms cold start, ~24MB unpacked, single-connection, pre-1.0 maturity.

2. **SQLite engines (`node:sqlite`, `better-sqlite3`):** Zero-dependency or near-zero. <3ms cold start. Mature. But: different SQL dialect — no `pg_catalog`, different types, different error codes. Would require replacing the `@pgsql/parser` classifier, rewriting all inspection queries, and forking the read/apply SQL paths.

PGlite is the only option that keeps the existing codebase's Postgres assumptions intact: the `@pgsql/parser` classifier, `pg_catalog` inspection SQL, cursor-based reads, `BEGIN`/`SET LOCAL`/`COMMIT` transactions, and SQLSTATE error mapping all work unchanged.

Prior art research across agent/MCP tools, CLI database clients, and ORM dev workflows identified these patterns: auto-create data file/directory on first access (usql, sqlite-utils, berthojoris SQLite MCP), read/write structural separation at the action level (Anthropic Postgres MCP, DBHub), import with automatic schema inference (sqlite-utils), and permission-granular action surfaces (berthojoris SQLite MCP). No existing tool combines zero-config startup, approval-gated safety, and import ergonomics.

## Decision

### Local database target

When `DATABASE_URL` is not set, shared DB actions (`inspect`, `browse`, `query`, `plan`, `apply_plan`) fall back to a **local target**: an embedded PGlite instance stored at `<cwd>/.pi-ship/local-db/`. The datadir is auto-created on first access. No configuration is required.

A new `resolveDatabaseTarget(credentialSource, cwd)` function in `src/database/target.ts` returns a discriminated union:
- `{ kind: "remote", url: string }` — `DATABASE_URL` is present; existing behavior preserved byte-for-byte.
- `{ kind: "local", dataDir: string }` — no `DATABASE_URL`; PGlite-backed project-local database.

`PI_SHIP_DATABASE_ENVIRONMENT` defaults to `"development"` for the local target only. It remains mandatory for remote targets.

Target fingerprinting is extended via a new `fingerprintLocalTarget(dataDir: string)` function in `src/database/plan.ts`. It produces a deterministic SHA-256 hash of `{ kind: "local", dataDir }` — independent of URL parsing and suitable for plan fingerprint matching in gated mode.

### Write-safety model: open by default

By default, the local target allows any classified `write` or `destructive` statement to execute directly through a plain `BEGIN`/execution/`COMMIT` transaction. No approval, no journal ceremony, no payload registry interaction. `blocked` classifications (SQL the parser rejects) are still refused.

A `PI_SHIP_LOCAL_DB_GATED=true` environment variable (opt-in) restores the full plan → classify → approve → apply ceremony for the local target. In gated mode, the local target behaves identically to a remote PostgreSQL target: plans are persisted, approvals are requested, the journal is written, and idempotency is enforced.

Remote target behavior is unchanged, regardless of the flag.

### Engine integration

PGlite (`@electric-sql/pglite`, pinned ~0.5.x) is added as an optional dependency, lazy-imported only when a local target is resolved. Deployment-only users who always set `DATABASE_URL` pay zero startup cost for the PGlite WASM bundle.

A `PGliteClient` class implements the existing `DatabaseClient` interface (`connect`/`query`/`end`). One instance is cached per datadir per process via `src/database/local/instance-cache.ts`. The `end()` method is a no-op for local clients (instance lives for the process lifetime).

### New actions

Two new `DB` tool actions are added, both local-target-only:

- **`import`** — accepts `{ table, format: "json" | "csv", rows: unknown[][], mode: "create" | "append" }`. Auto-creates the table when missing, infers column types from data (BIGINT, DOUBLE PRECISION, BOOLEAN, TEXT, JSONB), executes parameterized `INSERT` statements with `quoteIdentifier`-validated identifiers. Capped at 10,000 rows and 500KB serialized payload.

- **`reset`** — removes the `.pi-ship/local-db/` directory. The datadir is auto-recreated on the next operation.

Both outputs pass through `defendToolResult` spotlighting.

## Alternatives considered

### 1. SQLite (node:sqlite) as local backend

Rejected because SQLite's dialect differs from PostgreSQL: no `pg_catalog` introspection views, different type system (no arrays, JSONB, SERIAL), different SQL syntax for identifiers and DDL, different error codes. Using SQLite would require replacing the `@pgsql/parser` classifier, rewriting all seven `pg_catalog` inspection queries, forking the read/apply transaction SQL, and maintaining dual code paths. The maintenance burden exceeds the benefit of faster cold start.

### 2. Auto-discover localhost PostgreSQL

Research found no mainstream tool auto-discovers a running local PostgreSQL instance via port probing or `docker ps` scanning. The standard approach is libpq's layered fallback (Unix socket → `PGHOST`/`PGPORT` env vars → explicit connection string). Active port probing is avoided for security: connecting to a database without consent could leak credentials. Rejected as insecure and inconsistent with industry practice.

### 3. Global datadir (XDG/platform data directory)

A single shared PGlite datadir under `$XDG_DATA_HOME/pi-ship/` or `~/Library/Application Support/pi-ship/` was considered. Rejected because per-project scope matches the existing per-cwd conventions for plans, journals, and state. Different projects should not share a scratch database.

### 4. Gated writes by default

Starting with the full plan/approve ceremony and requiring a flag to relax was considered. Rejected because "maximum utility when nothing is configured" means zero friction. The local datadir is gitignored scratch data with no blast radius. Users who want ceremony set the flag.

### 5. Manifest `localDatabase` configuration object

Adding an optional `localDatabase: { gatedWrites: boolean }` field to `pi-ship.schema.json` was considered. Rejected because (a) zero-config users have no manifest by definition, (b) widening four strict provider manifest variants creates scope creep, (c) the environment variable approach already covers the gated-mode use case.

### 6. In-memory ephemeral mode (`memory://`)

Deferred. YAGNI until users ask — the per-cwd datadir already provides scratch semantics, and `reset` handles the lifecycle.

### 7. Export/dump action

Deferred. YAGNI — `query` results already return rows, and piped workflows are outside the MCP/agent tool pattern.

## Consequences

### Positive

- The `DB` tool is fully useful with zero configuration: no `DATABASE_URL`, no `pi-ship.json`, no env vars needed. The `ship` deployment tool and provider slash commands are not registered when `pi-ship.json` is absent — the extension operates in local-only mode with just the DB tool.
- All existing remote-target behavior is preserved byte-for-byte — no regression risk for deployed users.
- No new parser or SQL dialect needed — PGlite is real PostgreSQL.
- Lazy import keeps cold-start cost at zero for users who never hit the local path.
- Compatible with existing safety machinery: the classifier, error mapping, output budget enforcement, and spotlighting defense all work unchanged for local targets.

### Negative

- Adds ~24MB dependency (PGlite WASM bundle) to the package when used locally.
- ~500ms cold start on first local operation per process.
- PGlite is pre-1.0 (v0.5.x) — pinned version; API changes possible before 1.0. Mitigated by the thin `DatabaseClient` adapter which can be swapped.
- Single-connection engine — concurrent operations on the same cwd must serialize. Second process gets a clear lock error (documented, acceptable for scratch data).
- A manifest-present but `DATABASE_URL`-absent scenario silently activates local scratch instead of erroring — mitigated by labeling every response as "local embedded database."

### Risk accepted

- PGlite pre-1.0 API instability. Accepted because the `DatabaseClient` adapter is a thin wrapper (connect/query/end) that any future PGlite release would preserve.
- Surprise factor when manifest exists but `DATABASE_URL` doesn't. Accepted because explicit labeling in every response makes the target unambiguous. Users who want the old behavior (error on missing URL) set `PI_SHIP_LOCAL_DB_GATED=true` or provide a `DATABASE_URL`.

## Verification

- `npm run typecheck` — no type errors.
- `npm test` — all existing tests pass unchanged; new unit tests cover target resolution, PGlite client adapter, open-write execution, import inference/caps, reset lifecycle.
- `npm run acceptance` — cloud-free e2e test passes with no env vars set.
- On-disk `/.pi-ship/local-db/` directory contains only PGlite data files — no SQL, params, secrets, or credentials.
- Remote-target acceptance tests pass unchanged (no regression).
