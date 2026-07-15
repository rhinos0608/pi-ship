# pi-ship

Pi extension for approval-gated deployments and database operations.

## Runtime tools

Two tools are registered:

### `ship` — deployment lifecycle

Actions: `validate`, `plan`, `apply_plan`, `status`, `logs`.

### `DB` — database operations

Actions: `inspect`, `browse`, `query`, `plan`, `apply_plan`, `plan_migration`, `migration_status`.

## DB actions

| Action | Description | DATABASE_URL required | Manifest required | Client created |
|---|---|---|---|---|
| `inspect` | Inspect database schema, relations, indexes, enums | Yes | No | Yes (read) |
| `browse` | Browse table rows with filters, ordering, pagination | Yes | No | Yes (read) |
| `query` | Execute a read-only SQL query (caller-supplied SQL is classified; only approved read queries execute) | Yes | No | Yes (read) |
| `plan` | Classify SQL, create metadata-only plan, persist, request approval | Yes | No | No |
| `apply_plan` (`db-plan/1`) | Apply a shared database plan | Yes | No | Yes (write) |
| `apply_plan` (provider plan) | Apply a provider migration plan | No | Yes | No |
| `plan_migration` | Create a Railway migration plan | No | Yes (Railway) | No |
| `migration_status` | Show migration status | No | Yes (Railway) | No |

Provider-specific actions require a provider manifest but not DATABASE_URL.

## Required environment variables

| Variable | Required for | Notes |
|---|---|---|
| `DATABASE_URL` | Shared DB actions (`inspect`, `browse`, `query`, `plan`, `apply_plan`) | PostgreSQL connection string. Never persisted or logged. |
| `PI_SHIP_DATABASE_ENVIRONMENT` | All DB actions | Must be `development`, `preview`, or `production`. |
| `PI_SHIP_ALLOW_PRODUCTION_DB_WRITES` | Production DB writes | Must be exactly `true` (lowercase). `TRUE`, `1`, or missing are denied. |
| `RAILWAY_API_TOKEN` or `RAILWAY_TOKEN` | Railway deploy | |
| `VERCEL_TOKEN` | Vercel deploy | |

## Examples

```bash
# Inspect database
DB.action: inspect

# Query read-only
DB.action: query, sql: "SELECT id, name FROM users WHERE active = $1", params: [true]

# Plan and apply a database mutation
DB.action: plan, sql: "INSERT INTO audit_log (event) VALUES ($1)", params: ["deploy"]
# ... approval ...
DB.action: apply_plan, planId: "<planId>", planDigest: "<planDigest>"
```

(Examples omit real credentials. Never share `DATABASE_URL` or plan IDs containing secrets.)

## Safety model

- Plans are metadata-only fingerprints — no SQL or parameter values on disk.
- SQL and parameters live only in process memory (`DatabasePayloadRegistry`).
- Process restart clears the payload registry and forces replanning.
- Database mutations require scoped approval: `{ domain: "database", risk: "write" | "destructive" }`.
- Production database writes require `PI_SHIP_ALLOW_PRODUCTION_DB_WRITES=true`.
- Transport errors after the first write produce ambiguous state — manual reconciliation required.
- No automatic retries for any database operation.
- Journal is hash-chained, SQL-free, and validated before every apply.

## Local checks

```bash
npm install
npm run typecheck
npm test
npm run acceptance
```

Live Railway or Vercel behavior is not exercised by tests. See `docs/railway-spike.md`.
