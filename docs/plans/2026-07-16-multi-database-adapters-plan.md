# Multi-Database Adapters Implementation Plan

> **For agentic workers:** Implement task-by-task per the dependency DAG. Design: docs/plans/2026-07-16-multi-database-adapters-design.md. ADR: docs/adr/0011-multi-database-adapters.md.

## Goal
Build scheme-routed SQLite and MySQL/MariaDB adapters without changing PostgreSQL behavior, safety contracts, or tool actions.

## File Structure

- `docs/adr/0011-multi-database-adapters.md` — accepted decision record.
- `docs/plans/2026-07-16-multi-database-adapters-plan.md` — persisted worker handoff using this task breakdown.
- `src/database/dialect/contracts.ts` — adapter, classifier, target, transaction, inspection contracts.
- `src/database/dialect/registry.ts` — explicit scheme-to-adapter registry; no self-registration side effects.
- `src/database/dialect/postgres.ts` — wrapper over existing PostgreSQL functions. No SQL refactor.
- `src/database/dialect/apply.ts` — dialect-aware shared preflight/journal lifecycle, preserving `applyDatabasePlan` public behavior.
- `src/database/dialect/sqlite/*` — SQLite client, classifier, inspect/read/browse, import capability, error mapper.
- `src/database/dialect/mysql/*` — mysql2 client, classifier, inspect/read/browse, executor, error mapper.
- `src/database/target.ts`, `src/database/plan.ts`, `src/database/import.ts`, `src/tools/db/index.ts` — Track 1 seams extended only in assigned tasks.

## Tasks

1. **Task 1: Record ADR 0011 and Track 2 handoff plan.**
   - File: `docs/adr/0011-multi-database-adapters.md`
   - File: `docs/plans/2026-07-16-multi-database-adapters-plan.md`
   - Changes:
     - Use ADR 0004/0010 headings: Status, Context, Decision, Alternatives considered, Consequences, Verification.
     - Record accepted decisions:
       - explicit `DialectAdapter` registry routes `postgres`/`postgresql`, `mysql`/`mariadb`, `sqlite`, and Track 1 PGlite target;
       - SQLite uses `node:sqlite` plus exact-pinned `sqlite3-parser`; reads use read-only connection opening and write connections install authorizer defense; user-pointed files stay gated by default;
       - exact lowercase `PI_SHIP_SQLITE_OPEN=true` enables direct writes for SQLite files; unset, `TRUE`, `1`, whitespace remain gated; `PI_SHIP_LOCAL_DB_GATED` remains PGlite-only;
       - MySQL/MariaDB use exact-pinned `mysql2` at version `>=3.19.1`, with `multipleStatements: false`, plus exact-pinned `node-sql-parser`; reads run `START TRANSACTION READ ONLY`;
       - engine-native SQL/placeholders; parser failure blocks execution.
     - Reject MSSQL, MongoDB/Redis, SQL translation, `PRAGMA query_only`, and Knex/SQLAlchemy-style framework delegation. State exact reasons from approved design.
     - Put this implementation DAG, interfaces, ownership, test matrix, and Track 1 block in implementation-plan doc.
   - Acceptance:
     - ADR has no unapproved scope.
     - Plan names `PI_SHIP_SQLITE_OPEN=true` exact semantics.
     - `grep -R "TODO\|TBD" docs/adr/0011-multi-database-adapters.md docs/plans/2026-07-16-multi-database-adapters-plan.md` finds nothing.

2. **Task 2: Create adapter foundation and scheme-aware target contract.**
   - Depends on: Track 1 Task 1 interfaces present: `DatabaseTarget`, `resolveDatabaseTarget`, `fingerprintTarget`.
   - Files:
     - Create: `src/database/dialect/contracts.ts`
     - Create: `src/database/dialect/registry.ts`
     - Create: `src/database/dialect/postgres.ts`
     - Modify: `src/database/target.ts`
     - Modify: `src/database/environment.ts`
     - Modify: `package.json`, `package-lock.json`
     - Test: `test/database/dialect/registry.test.ts`
     - Test: `test/database/target.test.ts`
     - Test: `test/database/environment.test.ts`
   - Changes:
     - Exact-pin dependencies: `sqlite3-parser`, `node-sql-parser`, `mysql2` with a pinned installed version no lower than `3.19.1`. Do not add `better-sqlite3`, Knex, Kysely, SQLAlchemy bridge, MSSQL, MongoDB, or Redis driver.
     - Extend Track 1 target union without breaking old branches:
       ```ts
       export type DatabaseTarget =
         | { kind: "remote"; dialect: "postgres" | "mysql"; url: string }
         | { kind: "local"; dialect: "pglite"; dataDir: string }
         | { kind: "file"; dialect: "sqlite"; path: string };
       ```
     - `resolveDatabaseTarget(source, cwd)` rules:
       - absent/blank `DATABASE_URL` => existing PGlite target;
       - `postgres:`/`postgresql:` => remote postgres;
       - `mysql:`/`mariadb:` => remote MySQL;
       - `sqlite:` URL or plain `.db`/`.sqlite`/`.sqlite3` path => SQLite file target;
       - reject unsupported schemes, malformed SQLite syntax, absolute paths outside cwd, and `..` escape after `resolve(cwd, input)` using safe generic `E_CONFIG_INVALID` messages.
     - Preserve plain remote PostgreSQL URL result semantics for existing callers/tests. `resolveDatabaseEnvironment` treats only `kind: "remote"` as env-required; PGlite and SQLite default to `development` when absent.
     - Define contract, no driver imports:
       ```ts
       export type DatabaseDialectId = "postgres" | "pglite" | "sqlite" | "mysql";
       export type DialectReadMode = "read" | "write";
       export interface DialectAdapter {
         readonly id: DatabaseDialectId;
         readonly schemes: readonly string[];
         readonly label: string;
         readonly local: boolean;
         classify(sql: string, params: readonly unknown[]): Promise<Classification>;
         assertPublicQuery(sql: string, params: readonly unknown[]): Promise<Classification>;
         assertPublicPlan(sql: string, params: readonly unknown[]): Promise<Classification>;
         fingerprint(target: DatabaseTarget): string;
         connect(target: DatabaseTarget, mode: DialectReadMode): Promise<DatabaseClient>;
         inspect(target: DatabaseTarget, signal?: AbortSignal): Promise<InspectResult>;
         browse(target: DatabaseTarget, input: DialectBrowseInput, signal?: AbortSignal): Promise<DialectBrowseResult>;
         read(target: DatabaseTarget, input: ReadQueryOptions): Promise<ReadQueryResult>;
         executeApproved(target: DatabaseTarget, input: DialectApplyInput): Promise<ApplyDatabasePlanResult>;
         quoteIdentifier(value: string): string;
       }
       ```
     - `DialectBrowseInput` has existing browse fields; `DialectBrowseResult` has existing browse result fields. `DialectApplyInput` carries cwd, plan identity/digest, environment, production flag, registry, payloads, and signal. It never carries raw URL in an error value.
     - Registry API stays explicit/testable:
       ```ts
       export function createDialectRegistry(adapters: readonly DialectAdapter[]): DialectRegistry;
       export interface DialectRegistry {
         resolve(target: DatabaseTarget): DialectAdapter;
         supportedSchemes(): readonly string[];
       }
       ```
     - Postgres adapter delegates existing `classifySQL`, `assertPublicQuery`, `assertPublicPlan`, `inspectDatabase`, `executeBrowse`, `executeReadQuery`, `applyDatabasePlan`, `createDefaultClientFactory`, and `quoteIdentifier`; no SQL text changes.
   - Acceptance:
     - Test routing PostgreSQL aliases, MySQL/MariaDB aliases, PGlite absence fallback, SQLite URL/plain-path acceptance, traversal/outside-cwd rejection, unsupported scheme rejection.
     - Test adapter registry rejects duplicate ids/schemes and resolves adapter by target dialect.
     - Existing PostgreSQL target/environment tests still pass.
     - Run: `npx vitest run test/database/dialect/registry.test.ts test/database/target.test.ts test/database/environment.test.ts`.

3. **Task 3: Extract dialect-neutral journal/preflight apply lifecycle while keeping PostgreSQL wrapper identical.**
   - Depends on: Task 2 contracts.
   - Files:
     - Create: `src/database/dialect/apply.ts`
     - Modify: `src/database/apply.ts`
     - Test: `test/database/dialect/apply.test.ts`
     - Modify: `test/database/apply.test.ts`
   - Changes:
     - Move reusable plan load, digest/environment/provider/manifest checks, approval scope, production flag, payload lookup, reclassification comparison, journal replay, start/terminal journal writes, abort handling, and cleanup into `applyDialectPlan(input)`.
     - Make classifier and statement executor injected from `DialectAdapter`; generic kernel must compare all existing metadata (`risk`, statement count/index/tag/fingerprint/param count/tables/reasons) before dispatch.
     - Define executor behavior:
       ```ts
       export interface DialectMutationExecutor {
         classifyError(cause: unknown): DialectError;
         begin(client: DatabaseClient): Promise<void>;
         execute(client: DatabaseClient, sql: string, params: readonly unknown[]): Promise<DatabaseQueryResult>;
         commit(client: DatabaseClient): Promise<void>;
         rollback(client: DatabaseClient): Promise<boolean>;
       }
       ```
       `DialectError` normalizes only code/category/retryability/definiteness; never copies driver message.
     - Keep exported `applyDatabasePlan(options)` and its PostgreSQL options shape. Implement it as compatibility wrapper supplying existing PG classifier/client/transaction/error semantics to generic kernel. Existing tests prove byte-for-byte behavior.
     - SQLite/MySQL adapter `executeApproved` uses generic kernel, its own target fingerprint, classifier, connection creator, transaction semantics, and normalized error behavior.
   - Acceptance:
     - Existing `test/database/apply.test.ts` passes unchanged.
     - New fake-executor tests prove: wrong target blocks before connect; unapproved plan blocks; production guard exact lowercase; parser reclassification drift blocks; journal replay blocks; definitive error is `failed`; transport after write is `ambiguous`.
     - Run: `npx vitest run test/database/apply.test.ts test/database/dialect/apply.test.ts`.

4. **Task 4: Implement SQLite adapter, structural read enforcement, inspection, browse/read, and SQLite import dialect.**
   - Depends on: Tasks 2–3.
   - Files:
     - Create: `src/database/dialect/sqlite/client.ts`
     - Create: `src/database/dialect/sqlite/classifier.ts`
     - Create: `src/database/dialect/sqlite/inspect.ts`
     - Create: `src/database/dialect/sqlite/read.ts`
     - Create: `src/database/dialect/sqlite/browse.ts`
     - Create: `src/database/dialect/sqlite/error.ts`
     - Create: `src/database/dialect/sqlite/index.ts`
     - Modify: `src/database/import.ts`
     - Modify: `test/database/import.test.ts`
     - Test: `test/database/dialect/sqlite/client.test.ts`
     - Test: `test/database/dialect/sqlite/inspect.test.ts`
     - Test: `test/database/dialect/sqlite/read-browse.test.ts`
     - Test: `test/database/dialect/sqlite/error.test.ts`
     - Test: `test/database/dialect/sqlite/import.test.ts`
   - Changes:
     - Wrap `node:sqlite` `DatabaseSync` with async `DatabaseClient`. Read connection opens `{ readOnly: true }`; write connection installs `setAuthorizer()` to deny mutation/attach/pragma-write opcodes not needed for approved statement execution. Do not use `PRAGMA query_only`.
     - Use `prepare()` for every statement. Reject driver-level multi-statement execution; classifier splits/returns individual statement slices, generic apply executes slices inside SQLite `BEGIN`/`COMMIT`/`ROLLBACK` transaction.
     - `classifySQLiteSQL(sql, params)` produces existing `Classification`/`ClassifiedStatement` shape. Rules: `SELECT`/known read PRAGMA => read; INSERT/UPDATE/DELETE-with-WHERE => write; DELETE-without-WHERE, DROP, TRUNCATE, ALTER, CREATE => destructive; unknown/parse failure/unsafe PRAGMA => `E_CONFIG_INVALID` blocked. Validate `?` parameter count exactly against supplied params.
     - SQLite inspection maps `sqlite_master`, `PRAGMA table_info`, `index_list`, `index_info`, and `foreign_key_list` to existing `InspectResult`; unsupported PG-only categories return empty arrays, never invented metadata.
     - SQLite browse uses `?` binds, quoted identifiers, `LIKE` not `ILIKE`, documented null ordering emulation only when requested, and bounded `LIMIT/OFFSET`; read uses statement execution plus `limit + 1` and `buildSafeDetails`.
     - Extend `importData` with injected import dialect `{ quoteIdentifier, placeholder(index), inferredType(value), serializeValue(value) }`; Postgres/PGlite remains `$n` + `JSONB`, SQLite uses `?` + `INTEGER`/`REAL`/`TEXT` and JSON string storage. Preserve existing import validation/caps.
     - Map `SQLITE_BUSY`/`SQLITE_LOCKED` retryable to `E_PROVIDER`, `SQLITE_READONLY` and constraints non-retryable to safe `E_PROVIDER`, abort to `E_CANCELLED`; never expose raw SQLite message/path.
   - Acceptance:
     - Real in-memory `DatabaseSync(":memory:")` tests prove read-only opening blocks mutation, write transaction applies approved inserts, inspection/browse/read normalize results, `DELETE FROM t` is destructive, `DROP` destructive, unknown PRAGMA blocked, and no `exec()` use.
     - Import tests prove SQLite `?` bind generation, text JSON serialization, type mapping, and existing PostgreSQL import test expectations unchanged.
     - Run: `npx vitest run test/database/dialect/sqlite test/database/import.test.ts`.

5. **Task 5: Implement MySQL/MariaDB adapter, native read-only reads, inspection, browse/read, and safe error mapping.**
   - Depends on: Tasks 2–3.
   - Files:
     - Create: `src/database/dialect/mysql/client.ts`
     - Create: `src/database/dialect/mysql/classifier.ts`
     - Create: `src/database/dialect/mysql/inspect.ts`
     - Create: `src/database/dialect/mysql/read.ts`
     - Create: `src/database/dialect/mysql/browse.ts`
     - Create: `src/database/dialect/mysql/error.ts`
     - Create: `src/database/dialect/mysql/index.ts`
     - Test: `test/database/dialect/mysql/client.test.ts`
     - Test: `test/database/dialect/mysql/inspect.test.ts`
     - Test: `test/database/dialect/mysql/read-browse.test.ts`
     - Test: `test/database/dialect/mysql/error.test.ts`
   - Changes:
     - Lazy-load `mysql2/promise`. Parse only `mysql:`/`mariadb:` URLs; create one connection per operation; hard-code `multipleStatements: false`; call `execute(sql, params)` only. Never spread URL query options into driver options.
     - `classifyMySQLSQL(sql, params)` uses `node-sql-parser` MySQL dialect and returns existing `Classification`. Fail closed on parse error, unknown node, unsupported statement, or placeholder mismatch. Detect DELETE without WHERE, DROP/TRUNCATE/ALTER/CREATE as destructive.
     - Read execution order: connect → `START TRANSACTION READ ONLY` → bound `SELECT ... LIMIT ?`/browse query → `ROLLBACK` → end. Enforce output/boundary limits using existing output helpers. Do not use PostgreSQL cursor SQL.
     - Browse uses backtick identifier quoting, `?` placeholders, exact operator allowlist, MySQL-compatible case-insensitive `LIKE`, and no PostgreSQL `ILIKE`/`NULLS FIRST` syntax.
     - Inspection uses fixed `information_schema` queries for schemas, tables/views, columns, statistics, and key constraints. Map unavailable PG-specific triggers/policies/enums to empty normalized categories.
     - Error mapping uses only `code`/`errno`: auth (`ER_ACCESS_DENIED_ERROR`, `ER_DBACCESS_DENIED_ERROR`) => `E_AUTH_MISSING`; connection (`ECONNREFUSED`, reset, timeout, host lookup) => retryable `E_PROVIDER`; other MySQL execution errors => non-retryable `E_PROVIDER`; never parse message.
     - Fingerprint includes normalized `mysql` protocol, lower-cased host, default `3306`, database, username, and safe TLS selector fields; excludes password/raw URL.
   - Acceptance:
     - Fake `mysql2` client tests assert `multipleStatements` false, `execute` receives `?` params, transaction order includes `START TRANSACTION READ ONLY`, multi-statement query never reaches driver, inspection only sends fixed SQL, and errno mapping is safe.
     - Run: `npx vitest run test/database/dialect/mysql`.

6. **Task 6: Add cross-engine classifier corpus and contract fixtures.**
   - Depends on: Tasks 4–5.
   - Files:
     - Create: `test/fixtures/database/dialect-classification.json`
     - Test: `test/database/dialect/classifier-fixtures.test.ts`
     - Test: `test/database/dialect/contracts.test.ts`
   - Changes:
     - Fixture rows declare `dialect`, SQL, params, expected result/error, risk, statement count, destructive reasons, and expected parameter count. Keep only public SQL examples — no URLs/secrets.
     - Cover PostgreSQL regression, SQLite, and MySQL/MariaDB: read, INSERT, UPDATE, DELETE-with-WHERE, DELETE-without-WHERE, DROP, TRUNCATE, CREATE, multi-statement, bind count mismatch, parser rejection; SQLite known-read PRAGMA and unsafe/unknown PRAGMA; MySQL `?` placeholders and MariaDB alias routing.
     - Contract tests verify all adapters preserve same classification invariants: `blocked` cannot produce a successful result, statement index starts at zero, risk is valid, fingerprints are 64 lower-case hex, and public-query classifier rejects any non-single-read result.
   - Acceptance:
     - Run: `npx vitest run test/database/dialect/classifier-fixtures.test.ts test/database/dialect/contracts.test.ts`.
     - Fixture failure pinpoints dialect + SQL case without embedding raw source database values.

7. **Task 7: Final tool wiring, boundary parity, docs, integration, acceptance.**
   - **BLOCKED:** Do not start until Track 1 Task 6 has landed and exports its final `resolveDatabaseTarget`, PGlite client, `executeLocalQuery`, `importData`, `resetLocalDatabase`, and local response labels. Also blocked on Tasks 2–6 passing.
   - Files:
     - Modify: `src/tools/db/index.ts`
     - Modify: `src/database/plan.ts`
     - Modify: `src/boundary/resource.ts`
     - Modify: `README.md`
     - Modify: `test/tools/db/index.test.ts`
     - Modify: `test/boundary/resource.test.ts`
     - Create: `test/database/dialect/sqlite.integration.test.ts`
     - Modify: `test/acceptance/database.e2e.test.ts`
   - Changes:
     - Replace hard-coded PostgreSQL branches with `resolveDatabaseTarget` then registry resolution. Preserve Track 1 behavior exactly:
       - no `DATABASE_URL` => PGlite scratch; `PI_SHIP_LOCAL_DB_GATED=true` changes only that scratch target;
       - postgres URL => same current functions/output/approval flow;
       - MySQL/MariaDB URL => remote environment, plan approval, production guard, journal lifecycle;
       - SQLite target => local environment default, gated plan/approve/apply by default; `PI_SHIP_SQLITE_OPEN === "true"` alone enables direct local mutation executor;
       - `import` works only PGlite/SQLite; `reset` remains PGlite-only; provider-dispatched actions unchanged.
     - Keep `deps.clientFactory` as PostgreSQL test seam. Do not route injected PG fake through mysql/sqlite adapters.
     - Make plan and apply use resolved adapter fingerprint/classifier/executor. Existing `fingerprintTarget(string | DatabaseTarget | undefined)` remains backward-compatible for PostgreSQL/PGlite callers; tool uses adapter fingerprint for SQLite/MySQL.
     - Extend database resource default ports to `[5432, 3306]` while retaining `DATABASE_URL` as sole protected credential. This makes MySQL raw-network enforcement match PostgreSQL boundary parity.
     - Label output target engine safely: `local embedded PostgreSQL`, `local SQLite database`, `remote PostgreSQL database`, `remote MySQL database`. Continue `defendToolResult` for inspect/browse/query/import-like external results.
     - Document connection forms, engine-native parameter style, SQLite containment/gating, exact `PI_SHIP_SQLITE_OPEN=true`, existing PGlite flag scope, MySQL safety (`multipleStatements` disabled), and unsupported engines. Do not advertise SQL translation.
   - Acceptance:
     - Real `node:sqlite` integration: temp file inside cwd; inspect, browse, read query, gated plan+apply, `PI_SHIP_SQLITE_OPEN=true` direct mutation; `TRUE`/`1` do not open writes; outside-cwd path rejected without echoing path.
     - Tool tests: no-regression PG injected fake route; MySQL route gets approval/environment requirement; SQLite default gate and exact open flag; unsupported scheme fails safely; provider migration path unchanged.
     - Acceptance test: SQLite fixture file in temporary cwd works without remote environment; MySQL fake path verifies no live network.
     - Run in order:
       ```bash
       npm run typecheck
       npm test
       npm run acceptance
       git diff --check
       npm audit --omit=dev
       ```

## Files to Modify

- `docs/adr/0011-multi-database-adapters.md` — ADR record.
- `docs/plans/2026-07-16-multi-database-adapters-plan.md` — persisted worker plan.
- `src/database/target.ts` — target union and secure scheme/path resolver.
- `src/database/environment.ts` — remote-only environment requirement.
- `src/database/apply.ts` — PostgreSQL compatibility wrapper over generic lifecycle.
- `src/database/import.ts` — injected import dialect while preserving PostgreSQL behavior.
- `src/database/plan.ts` — adapter-aware fingerprints at tool boundary; legacy path unchanged.
- `src/tools/db/index.ts` — final scheme routing after Track 1 Task 6.
- `src/boundary/resource.ts` — MySQL port parity.
- `package.json`, `package-lock.json`, `README.md` — exact dependencies and user contract.

## New Files

- `src/database/dialect/contracts.ts` — stable adapter contract.
- `src/database/dialect/registry.ts` — explicit scheme router.
- `src/database/dialect/postgres.ts` — existing-function wrapper.
- `src/database/dialect/apply.ts` — reusable guarded plan executor.
- `src/database/dialect/sqlite/{client,classifier,inspect,read,browse,error,index}.ts` — SQLite implementation.
- `src/database/dialect/mysql/{client,classifier,inspect,read,browse,error,index}.ts` — MySQL/MariaDB implementation.
- Tests and fixtures listed in Tasks 2–7.

## Dependencies

```text
Task 1 docs ──────────────────────────────────────────────┐
Task 2 foundation + dependencies ─┬─> Task 3 generic apply ├─> Task 7 final wiring
                                  ├─> Task 4 SQLite ───────┤
                                  └─> Task 5 MySQL ─────────┤
Task 4 + Task 5 ─────────────────────> Task 6 corpus ──────┘

Track 1 Task 6 landing ────────────────────────────────────> Task 7 only
```

Parallel work after Task 2: Task 3, Task 4, Task 5. Task 6 starts after adapters. Task 7 is sole shared-file writer and must wait for all prior tasks plus Track 1 Task 6.

## Risks

- `sqlite3-parser` pre-1.0 AST drift. Exact pin plus corpus gate.
- `node-sql-parser` MySQL/MariaDB gaps. Parse failure blocks before driver dispatch.
- SQLite user file path is sensitive metadata. Resolver/error tests must prove no path echo and cwd containment.
- Generic apply extraction can alter PostgreSQL ambiguity semantics. Existing `test/database/apply.test.ts` must remain unchanged and green before SQLite/MySQL wiring.
- MySQL tests use fakes; no live server in CI. Driver SQL/order/config assertions must be exhaustive.
- Approved wording "existing local-relax flag" was imprecise. Superseding exact decision: `PI_SHIP_SQLITE_OPEN=true` opens user-pointed SQLite writes; Track 1 `PI_SHIP_LOCAL_DB_GATED` remains PGlite-only.
