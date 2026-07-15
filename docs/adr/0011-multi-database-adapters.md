# ADR 0011: Multi-database adapters (SQLite + MySQL/MariaDB)

## Status

Accepted

## Context

Track 1 (ADR 0010) introduced a zero-config local database using PGlite — embedded PostgreSQL via WASM — behind a `DatabaseTarget` discriminated union and `resolveDatabaseTarget` function. The `DB` tool now works without `DATABASE_URL` by falling back to `<cwd>/.pi-ship/local-db/`.

However, PostgreSQL (remote or PGlite-embedded) is not the only database developers use. Research across agent/MCP tools, CLI database clients, and ORM developer workflows identified two engines with broad adoption that fit the existing safety model (classifier → plan → approve → apply):

1. **SQLite** — most widely deployed database engine; built into Node.js ≥22.5 via `node:sqlite`; used for local dev, single-file databases, embedded data.
2. **MySQL/MariaDB** — second-most-adopted remote database after PostgreSQL; `mysql2` is the standard Node.js driver.

Key findings from the research:
- **Classification**: `sqlite3-parser` (justjake) is a pure-JS port of SQLite's grammar (~32KB) that handles PRAGMA and multi-statement via CmdList. `node-sql-parser` (mysql dialect) reliably classifies MySQL DML/DDL. Both support DELETE-without-WHERE/DROP/TRUNCATE detection via AST field inspection.
- **Enforcement**: SQLite supports structural read-only via the `{ readOnly: true }` open flag and `setAuthorizer()` defense-in-depth on write connections. MySQL supports `START TRANSACTION READ ONLY`. `PRAGMA query_only` is compile-time-fragile and must not be relied upon.
- **mysql2 CVE**: A configuration injection / prototype pollution vulnerability in `mysql2` was fixed in version 3.19.1. The driver must be pinned at ≥3.19.1 and `multipleStatements` must be hard-coded `false`.

Track 2 extends the dialect adapter layer from Track 1's seams while preserving all existing PostgreSQL behavior byte-for-byte.

## Decision

### Dialect adapter registry

A new `DialectAdapter` interface in `src/database/dialect/contracts.ts` defines the seam for each engine: client factory, SQL classifier (same `read | write | destructive | blocked` risk levels), introspection, read-only enforcement, identifier quoting, and error normalization. An explicit `DialectRegistry` in `src/database/dialect/registry.ts` routes by URL scheme — no self-registration side effects.

The registry resolves these scheme-to-adapter mappings:
- `postgres:` / `postgresql:` → existing PostgreSQL path (unchanged behavior byte-for-byte)
- `mysql:` / `mariadb:` → MySQL/MariaDB adapter
- `sqlite:` URL or a plain `.db` / `.sqlite` / `.sqlite3` file path → SQLite adapter
- No `DATABASE_URL` at all → Track 1 PGlite scratch fallback (unchanged)

The PGlite target remains a Track 1 concept; it does not get a dedicated adapter in this registry. `resolveDatabaseTarget` returns `{ kind: "local", dialect: "pglite", dataDir }` for the absent-URL case, and existing code routes PGlite directly.

### SQLite adapter

- **Driver**: `node:sqlite` (`DatabaseSync`), built into Node ≥22.5. Zero new runtime dependency. Sync API is wrapped behind the async `DatabaseClient` interface.
- **Classifier**: `sqlite3-parser` (exact-pinned) feeding the existing risk levels. PRAGMA classified conservatively — only a known-read allowlist (e.g., `PRAGMA table_info`, `PRAGMA index_list`, `PRAGMA foreign_key_list`) passes as read; all others are blocked unless on the allowlist. Parse failure → `blocked`.
- **Read enforcement**: Connection opened with `{ readOnly: true }`. No reliance on `PRAGMA query_only`.
- **Write enforcement**: Full plan → approve → apply ceremony by default for user-pointed files. Write connections install `setAuthorizer()` to deny mutation/attach/pragma-write opcodes not needed for approved statement execution.
- **Path rules**: Resolve relative to cwd; must stay inside cwd (reject traversal and absolute paths outside cwd). A local file path is not a credential — no vault involvement. Environment defaults to `development`.
- **Execution model**: `prepare()`-only execution rejects multi-statement injection structurally. Multi-statement input is handled by the classifier's statement split, executed one prepared statement at a time inside a transaction.
- **Error mapping**: `SQLITE_BUSY` / `SQLITE_LOCKED` → retryable `E_PROVIDER`. `SQLITE_READONLY` and constraint violations → non-retryable `E_PROVIDER`. Abort → `E_CANCELLED`. Never exposes raw SQLite message or path.

### Write gating and the superseding flag decision

The approved design doc (2026-07-16) referred to "the existing local-relax flag" — this was imprecise and is superseded by the following exact decision:

- **`PI_SHIP_SQLITE_OPEN=true`** — exact lowercase string `true`. When set, the SQLite adapter allows direct mutation execution for user-pointed SQLite files without the plan/approve/apply ceremony. Unset, `TRUE`, `1`, whitespace, or any value other than exactly `true` (lowercase) keeps the gate closed — writes require approval.
- **`PI_SHIP_LOCAL_DB_GATED`** — remains PGlite-scratch-only. This flag does not affect SQLite targets.
- **Default**: Both flags absent → PGlite scratch is open-write (per ADR 0010); SQLite user-pointed files are gated (require plan/approve/apply).

This split exists because the PGlite scratch datadir is auto-created gitignored scratch data with zero blast radius, while SQLite user-pointed files reference an existing database that may contain valuable data. Different default postures are justified.

### MySQL/MariaDB adapter

- **Driver**: `mysql2` (pinned ≥3.19.1), lazy-imported only when a MySQL/MariaDB target is resolved. `multipleStatements: false` hard-coded — never spread URL query options into driver options. One connection per operation.
- **Classifier**: `node-sql-parser` (mysql dialect, exact-pinned) feeding existing risk levels. Parse failure → `blocked`.
- **URL parsing**: Only `mysql:` and `mariadb:` schemes are accepted. Reject unsupported schemes.
- **Read enforcement**: `START TRANSACTION READ ONLY` wrapping reads, with row limits and output budgets per existing conventions.
- **Write enforcement**: Identical contract to remote PostgreSQL — plan/approve/apply, journal, environment match, production flag, target fingerprint from normalized URL (protocol/host/port/database, no password in hash input).
- **Boundary/vault**: MySQL-scheme `DATABASE_URL` is protected exactly like postgres-scheme — via the boundary layer and vault.
- **Error mapping**: Auth errors (`ER_ACCESS_DENIED_ERROR`, `ER_DBACCESS_DENIED_ERROR`) → `E_AUTH_MISSING`. Connection errors (ECONNREFUSED, reset, timeout, host lookup) → retryable `E_PROVIDER`. Other MySQL execution errors → non-retryable `E_PROVIDER`. Never parse or expose the driver message text.

### SQL dialect

Engine-native SQL and placeholders — no cross-dialect SQL translation.

- PostgreSQL: `$1`, `$2` parameters.
- SQLite: `?` parameters.
- MySQL/MariaDB: `?` parameters.

Parser failure always blocks execution before any driver dispatch. Agents write engine-native SQL.

### Import dialect

`importData` is extended with an injected import dialect `{ quoteIdentifier, placeholder(index), inferredType(value), serializeValue(value) }`. PostgreSQL/PGlite uses `$n` + `JSONB`. SQLite uses `?` + `INTEGER` / `REAL` / `TEXT` and JSON string storage. Existing import validation and caps (10,000 rows, 500KB) are preserved.

### Tool surface

No new tool actions. Existing actions (`inspect`, `browse`, `query`, `plan`, `apply_plan`, `import`, `reset`) route through the adapter registry:
- `import` works on SQLite targets and the PGlite scratch.
- `reset` remains PGlite-scratch-only.
- Provider-dispatched actions unchanged.

Every response labels the engine and target kind. All externally-influenced outputs pass through `defendToolResult`.

## Alternatives considered

### 1. MSSQL (Microsoft SQL Server)

Rejected for v1. T-SQL does not support per-transaction read-only mode. The parser landscape for T-SQL is fragmented (no single reliable pure-JS parser matching `sqlite3-parser` or `node-sql-parser` quality). Adds significant surface area without proportional adoption benefit. Deferred for a future track.

### 2. MongoDB / Redis

Rejected. Both use non-SQL paradigms that break the classifier-risk-and-plan model. The `DB` tool is defined around SQL classification, statement-level risk, and deterministic plan fingerprints. Adding document or key-value stores would require a fundamentally different safety model.

### 3. Cross-dialect SQL translation

Rejected. Translation layers (e.g., Knex, SQLAlchemy bridge) introduce semantic drift, query reinterpretation risk, and debugging complexity. Agents write engine-native SQL with engine-native placeholders. Translation is out of scope for the safety model — the classifier must see the exact SQL that the engine will execute.

### 4. `PRAGMA query_only` for SQLite read enforcement

Rejected. `PRAGMA query_only` is a compile-time option that may not be available in all SQLite builds. It can be silently ignored if the library was compiled without it. Using the `{ readOnly: true }` open flag and `setAuthorizer()` provides structural enforcement independent of compile-time options.

### 5. Framework-level delegation (Knex, Kysely, SQLAlchemy)

Rejected. Adding an ORM or query-builder framework as an adapter dependency would add large dependency trees, version compatibility risk, and abstraction layers that hide the actual SQL sent to the engine. The dialect adapter layer is a thin interface over engine-native drivers and parsers — no query generation or builder abstraction.

### 6. Auto-discovery of local MySQL/PostgreSQL instances

Rejected for same reasons as ADR 0010: no mainstream tool auto-discovers running databases via port probing. Active port probing is insecure — connecting to a database without consent could leak credentials.

## Consequences

### Positive

- The `DB` tool supports SQLite and MySQL/MariaDB in addition to PostgreSQL, covering the three most widely-adopted SQL engines.
- Existing PostgreSQL behavior (remote and PGlite) is preserved byte-for-byte — no regression risk for deployed users.
- No cross-dialect SQL translation — the classifier sees the exact SQL the engine will execute.
- Engine-native write-safety contracts: read-only connections for SQLite, read-only transactions for MySQL, plan/approve/apply for writes.
- `PI_SHIP_SQLITE_OPEN=true` with exact-lowercase comparison avoids ambiguous truthy-value pitfalls.
- SQLite user-pointed files are gated by default, unlike PGlite scratch — appropriate default for existing databases with real data.
- Lazy loading: `mysql2` and `sqlite3-parser` are only imported when their dialect is resolved.
- The dialect adapter pattern is extensible — future engines can be added without modifying existing adapter code.

### Negative

- Two new pinned parser dependencies (`sqlite3-parser`, `node-sql-parser`) — both are pre-1.0, requiring exact pinning and fixture-based compatibility gates.
- One new driver dependency (`mysql2` ≥3.19.1) — CVE mitigation requires staying above the 3.19.1 floor.
- SQLite's synchronous `DatabaseSync` API must be wrapped behind the async `DatabaseClient` interface — minor indirection cost.
- MySQL/MariaDB test coverage uses faked `mysql2` clients (no live MySQL server in CI), similar to how PostgreSQL tests use faked `pg` clients.

### Risk accepted

- `sqlite3-parser` pre-1.0 AST drift. Mitigated by exact pin and classifier fixture gate (Task 6 corpus).
- `node-sql-parser` MySQL/MariaDB gaps. Mitigated by parse-failure → blocked — failures are safe-closed.
- SQLite user file path is sensitive metadata. Mitigated by resolver/error tests that prove no path echo and cwd containment.
- Generic apply extraction (Task 3) may alter PostgreSQL ambiguity semantics. Mitigated by requiring `test/database/apply.test.ts` unchanged and green.
- Sequencing risk: Track 2 final wiring (Task 7) depends on Track 1 Task 6 merged interfaces. Mitigated by defining the integration boundary explicitly.

## Verification

- `npm run typecheck` — no type errors.
- `npm test` — all existing tests pass unchanged; new dialect adapter tests cover scheme routing, per-adapter classification, error mapping, identifier quoting, path containment, and import dialect.
- `npm run acceptance` — cloud-free e2e tests pass; SQLite fixture file in temporary cwd works without remote environment; MySQL fake path verifies no live network.
- `git diff --check` — no whitespace errors.
- `npm audit --omit=dev` — no new vulnerabilities.
- On-disk plan files and journal entries contain none of the SQL, parameter values, passwords, URLs, or file paths used in tests.
- `PI_SHIP_SQLITE_OPEN=true` enables direct SQLite writes; `TRUE`, `1`, whitespace, unset do not. `PI_SHIP_LOCAL_DB_GATED` affects only PGlite scratch.
