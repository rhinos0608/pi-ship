# Zero-Config Local Database Operations Design

**Date:** 2026-07-16
**Status:** Approved
**Owner:** Pi (orchestrator) — approved by Rhine Sharar

## Goal

Make the `DB` tool fully useful with nothing configured — no `DATABASE_URL`, no `pi-ship.json`, no env vars — by falling back to an embedded project-local PostgreSQL (PGlite).

## Non-goals

- No changes to remote-target behavior (env gating, approvals, production flag stay byte-for-byte identical).
- No SQLite/MySQL dialect support (tracked separately as the multi-database adapter expansion).
- No export/dump action, no `memory://` ephemeral mode (deferred; YAGNI until asked).
- No local-server (localhost:5432) auto-discovery or port probing.

## Context

- `DATABASE_URL` is hard-required at `src/tools/db/index.ts:41-49,125,146`; `PI_SHIP_DATABASE_ENVIRONMENT` mandatory at `src/database/environment.ts:8-17`.
- The DB kernel (plan → classify → approve → apply, hash-chained journal, payload registry) is provider-free per ADR 0004.
- Postgres coupling is concentrated in `client.ts` (pg.Client, SQLSTATE mapping), `inspect.ts` (pg_catalog), `read.ts` (cursor transaction), `apply.ts` (BEGIN/SET LOCAL/COMMIT), `classifier.ts` (@pgsql/parser), `plan.ts:196-217` (fingerprintTarget URL parsing).
- Research: PGlite (@electric-sql/pglite, v0.5.x) is real Postgres 17 in WASM — full pg_catalog, same dialect, same SQLSTATE codes, filesystem persistence, zero deps, ~13M weekly downloads (Prisma `prisma dev` runs on it). ~500ms cold start, ~24MB unpacked, single connection, pre-1.0.
- Prior art: no existing agent/MCP tool combines zero-config startup + approval-gated safety + import ergonomics. Winning patterns: auto-create on first access (sqlite-utils), read/write structural separation (Anthropic postgres MCP), import with schema inference (sqlite-utils).

## Approved decisions

| Decision | Choice |
|---|---|
| Local DB scope | **A1** — project-scoped PGlite datadir at `<cwd>/.pi-ship/local-db/`, auto-created, gitignored |
| Write-safety model | **B3** — fully open local writes |
| Flag polarity | **C1** — open by default; `PI_SHIP_LOCAL_DB_GATED=true` restores full plan/approve/apply ceremony |
| Action surface | **D2** — parity + `import` + `reset` |

## Design

### Target resolution (new seam)

- New resolver replaces `requireDatabaseUrl` for shared actions: returns `{ kind: "remote", url }` when `DATABASE_URL` is set, else `{ kind: "local", dataDir: <cwd>/.pi-ship/local-db }`.
- Remote path: behavior unchanged (including mandatory `PI_SHIP_DATABASE_ENVIRONMENT`).
- Local path: environment defaults to `development` (env var still honored if set). Every tool response labels the target as "local embedded database".
- `fingerprintTarget` extended: local targets fingerprint deterministically from `local::<datadir>` without URL parsing.
- Fallback applies to shared actions regardless of manifest presence; provider-dispatched actions unchanged.

### Engine integration

- New dependency `@electric-sql/pglite` (pinned), lazy-imported only when a local target is resolved.
- `PGliteClient` implements the existing `DatabaseClient` interface (`connect/query/end`), mapping PGlite results to `DatabaseQueryResult` (fields with name/dataTypeID, rows, rowCount, command).
- Because PGlite is real Postgres: `@pgsql/parser` classification, `pg_catalog` inspect SQL, cursor-based reads, SQLSTATE error mapping (`mapSQLError`), and `BEGIN`/`SET LOCAL`/`COMMIT` apply transactions all work unchanged.
- Instance lifecycle: one cached PGlite instance per datadir per process (single-connection engine; ~500ms cold start paid once). Operations serialized per datadir. `end()` is a no-op/refcount for local clients. Process exit closes instances best-effort.

### Write model

- Local + open (default): `query` classifies SQL as today; `read` risk uses the existing read path; `write`/`destructive` execute directly in a plain transaction and return affected rows. No approval, no journal ceremony. `blocked` classifications still refuse.
- Local + gated (`PI_SHIP_LOCAL_DB_GATED=true`): local target behaves exactly like remote — plan → approve → apply, journaled.
- Remote: unchanged.

### New actions

- `import` — `{ table, format: "json" | "csv", path? , rows?, mode?: "create" | "append" }`: auto-create table when missing, schema inference (BIGINT, DOUBLE PRECISION, BOOLEAN, TEXT, JSONB for objects/arrays), parameterized inserts, identifier validation/quoting matching `browse`. Local target only; `E_PHASE_UNSUPPORTED` on remote. Row/byte caps at the boundary.
- `reset` — wipe and recreate the local datadir. Local target only; `E_PHASE_UNSUPPORTED` on remote.
- Both outputs pass through `defendToolResult` spotlighting.

### Unchanged

Provider dispatch and packages, ship tool, boundary/vault (no credential exists for local targets — nothing to protect), plan store, journal format, classifier, approval registry, spotlighting defense.

## Error handling

- PGlite init failure → `E_PROVIDER`, safe generic message (no paths beyond datadir label, no internals).
- Corrupt datadir → error message suggests `reset`.
- Import boundary validation: reject non-scalar cells (except objects/arrays → JSONB), invalid identifiers, oversized payloads (reuse output-budget constants conventions).
- Abort signal checks follow existing `checkAborted` conventions.

## Testing and verification

- Unit: target-resolution matrix (URL present/absent × env present/absent × flag), open-write routing by risk level, gated-mode parity, import schema inference and caps, reset, PGliteClient adapter mapping — using existing fake-client patterns.
- Integration: real in-memory PGlite (`memory://`) suite proving inspect/browse/query/import/plan-apply parity and SQLSTATE `.code` fidelity through `mapSQLError`. Cloud-free, CI-safe.
- Acceptance: zero-config e2e in `test/acceptance/` with no env vars set.
- Commands: `npm run typecheck`, `npm test`, `npm run acceptance`.

## Risks and open questions

- PGlite pre-1.0: pinned version; thin `DatabaseClient` adapter keeps it swappable.
- PGlite error `.code` SQLSTATE fidelity: verified by integration suite before ship.
- Surprise factor: manifest present but `DATABASE_URL` unset now reaches local scratch instead of erroring — mitigated by explicit labeling in every response.
- Concurrency: multiple pi processes on one cwd share the datadir; PGlite holds a lock — second process gets a clear error (documented, acceptable for scratch data).
