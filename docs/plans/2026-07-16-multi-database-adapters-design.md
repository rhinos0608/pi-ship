# Multi-Database Adapters Design (SQLite + MySQL/MariaDB)

**Date:** 2026-07-16
**Status:** Approved
**Owner:** Pi (orchestrator) — approved by Rhine Sharar

## Goal

Extend the `DB` tool beyond PostgreSQL to the largest-adoption local databases — SQLite and MySQL/MariaDB — behind a dialect adapter layer, preserving the risk-classification and approval safety model per engine.

## Non-goals

- No MSSQL (no per-transaction read-only in T-SQL, parser gaps — deferred; record as rejected alternative).
- No MongoDB/Redis (non-SQL paradigm breaks the classifier/plan model).
- No cross-dialect SQL translation — agents write engine-native SQL with engine-native placeholders (`$1` pg, `?` sqlite/mysql).
- No connection pooling, no localhost auto-discovery/port probing.
- No changes to deployment providers or the ship tool.

## Context

- Track 1 (zero-config local DB, ADR 0010) introduces `DatabaseTarget` resolution (`src/database/target.ts`), the `DatabaseClient` seam, open-write local execution, and import/reset actions. Track 2 builds on those seams. **Track 2 implementation must start only after Track 1's diff lands** (shared files: `src/tools/db/index.ts`, `src/database/target.ts`, `client.ts` surroundings).
- Research (artifacts under `.pi-subagents/artifacts/4a00c167-*`):
  - Adoption: SQLite #1 for local dev (embedded, `node:sqlite` built into Node ≥22.5), MySQL/MariaDB #2 (`mysql2`), MSSQL #3, MongoDB declining.
  - Classification: `sqlite3-parser` (justjake) is a pure-JS port of SQLite's own grammar (~32KB, handles PRAGMA, multi-statement via CmdList); `node-sql-parser` (mysql dialect) reliably classifies MySQL DML/DDL; DELETE-without-WHERE/DROP/TRUNCATE are reliable AST-field checks in both.
  - Enforcement: SQLite supports structural read-only (`{ readOnly: true }` open flag) and `setAuthorizer()`; MySQL supports `START TRANSACTION READ ONLY`. `PRAGMA query_only` is compile-time-fragile — do not rely on it.
  - Adapter prior art: scheme-routed registry (usql/dburl, DBHub), capability flags (Kysely), tagged-union error normalization (Prisma).
  - mysql2 CVE (config injection/prototype pollution) fixed in 3.19.1 — pin ≥3.19.1; `multipleStatements` must stay off.

## Approved decisions

| Decision | Choice |
|---|---|
| Engine scope | **E2** — SQLite + MySQL/MariaDB; MSSQL and MongoDB rejected for v1 |
| SQLite write model | Plan/approve/apply **gated by default** for user-pointed files (C1 "open" default applies only to the pi-ship-created PGlite scratch datadir); relaxable via the existing local-relax flag |
| SQLite reads | Structural enforcement: connection opened `{ readOnly: true }`; `setAuthorizer()` defense-in-depth on write connections |
| MySQL contract | Same as Postgres remote: `DATABASE_URL` (mysql scheme) protected by boundary/vault, `PI_SHIP_DATABASE_ENVIRONMENT` mandatory, production flag honored |
| SQL dialect | Engine-native SQL + placeholders; no translation |

## Design

### Dialect adapter layer

- `DialectAdapter` registry keyed by URL scheme (extends Track 1's `resolveDatabaseTarget`):
  - `postgres://`, `postgresql://` → existing pg path (unchanged)
  - `mysql://`, `mariadb://` → MySQL adapter
  - `sqlite:<path>`, `sqlite://<path>`, or a plain `.db`/`.sqlite`/`.sqlite3` file path → SQLite adapter
  - No `DATABASE_URL` at all → Track 1 PGlite scratch fallback (unchanged)
- Each adapter isolates: client factory (implements existing `DatabaseClient`), SQL classifier (same `read | write | destructive | blocked` risk levels and `Classification` shape), introspection (normalized schemas/relations/columns/indexes result shape shared with `inspect`), read-only enforcement strategy, identifier quoting, error normalization into existing `ShipError` codes, and capability flags.
- The pg-specific pieces (`@pgsql/parser` classification, `pg_catalog` inspect SQL, cursor reads, `BEGIN/SET LOCAL` transactions, SQLSTATE mapping) become the Postgres adapter implementation; behavior stays byte-for-byte identical.

### SQLite adapter

- Driver: `node:sqlite` (`DatabaseSync`) — zero new runtime dependency (engines already require Node ≥22.19). Sync API wrapped behind the async `DatabaseClient` interface.
- Classifier: new dependency `sqlite3-parser` (pinned) feeding the existing risk levels; PRAGMA classified conservatively (write-risk unless a known-read pragma allowlist matches); parse failure → `blocked`.
- Reads (`inspect`, `browse`, `query`): connection opened read-only; introspection via `sqlite_master` + `PRAGMA table_info/index_list/foreign_key_list`, mapped to the normalized inspect shape.
- Writes: full plan → approve → apply ceremony by default, journaled, `fingerprintTarget` extended for `sqlite:` targets (deterministic hash of kind + resolved path). Relax flag opts into direct writes.
- Path rules: resolve relative to cwd; must stay inside cwd (reject traversal/absolute paths outside cwd). A local file path is not a credential — no vault involvement. Environment defaults to `development`.
- `prepare()`-only execution (rejects multi-statement injection structurally); multi-statement input handled by the classifier's statement split, executed one prepared statement at a time inside a transaction.
- SQLite error codes (e.g. `SQLITE_BUSY`, `SQLITE_READONLY`, `SQLITE_CONSTRAINT`) mapped to safe generic ShipErrors.

### MySQL/MariaDB adapter

- Driver: new dependency `mysql2` (pinned ≥3.19.1), lazy-imported; `multipleStatements: false` hard-coded.
- Classifier: new dependency `node-sql-parser` (mysql dialect) feeding existing risk levels; parse failure → `blocked`.
- Reads: `START TRANSACTION READ ONLY` wrapping, row limits and output budgets per existing conventions.
- Writes: identical contract to Postgres — plan/approve/apply, journal, environment match, production flag, target fingerprint from mysql URL (protocol/host/port/database, no password in hash input beyond existing URL-fingerprint conventions).
- Boundary/vault: mysql-scheme `DATABASE_URL` protected exactly like postgres-scheme today.
- MySQL errno values mapped to safe generic ShipErrors (auth → `E_AUTH_MISSING`, connection → `E_PROVIDER` retryable, etc.).

### Tool surface

- No new actions. Existing actions (`inspect`, `browse`, `query`, `plan`, `apply_plan`, `import`, `reset`) route through the adapter registry. `import` works on SQLite targets (same schema-inference rules mapped to SQLite types) and the PGlite scratch; `reset` remains scratch-only. Provider-dispatched actions unchanged.
- Every response labels the engine and target kind. All externally-influenced outputs pass through `defendToolResult`.

## Error handling

- Unknown/unsupported scheme → `E_CONFIG_INVALID` with safe message listing supported schemes.
- Driver module load failure → `E_PROVIDER` safe generic.
- Per-engine error normalization never leaks SQL, params, URLs, file paths, or driver internals.

## Testing and verification

- Unit: scheme routing matrix, per-adapter classifier fixtures (risk levels incl. DELETE-without-WHERE, DROP, TRUNCATE, PRAGMA), error mapping tables, identifier quoting, path-containment rules — fake clients per existing conventions.
- Integration: real `node:sqlite` in-memory suite (inspect/browse/query/plan-apply/import parity); MySQL covered by fakes only (no live server in CI), mirroring how pg is tested today.
- Regression: full existing suite green; Postgres behavior byte-for-byte identical.
- Commands: `npm run typecheck`, `npm test`, `npm run acceptance`.

## Risks and open questions

- `sqlite3-parser` is pre-1.0 — pin exactly; classifier fixtures act as the compatibility gate.
- `node-sql-parser` MySQL edge cases (operator precedence, MariaDB RETURNING) — parse-failure→blocked keeps failures safe-closed.
- SQLite `PRAGMA query_only` compile-time gotcha — avoided by using open-flag read-only connections instead.
- Sequencing risk: Track 2 wiring depends on Track 1's merged seams; plan must define the integration boundary against Track 1's final interfaces.
