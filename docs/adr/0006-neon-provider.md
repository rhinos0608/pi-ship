# ADR 0006: Neon provider

## Status

Accepted

## Context

pi-ship needs a Neon (neon.tech) provider for approval-gated database provisioning, branching, and migration. Neon provides a REST API at `https://console.neon.tech/api/v2` with Bearer token auth. Neon's architecture uses copy-on-write branching — branches are instant, lightweight clones. All mutating operations are asynchronous: create/delete returns `operations[]` that must be polled to completion.

The existing codebase has two provider patterns:
- **Railway**: adapter-based, journal-based step-by-step engine
- **Vercel**: operation-engine based, hash-chained journal, immutable operations

Neon is CRUD-oriented (projects, branches, databases) with no deployment lifecycle. The Railway adapter pattern fits better — a simple `NeonAdapter` interface wrapping the REST client, with a journal-based step-by-step engine for idempotency.

Scope: Inspect, provision, migration status, preview branch, manifest-bound migration apply, and rollback via branch-restore with restore-point capture (see ADR 0008). Idempotency guidance below applies to all scoped operations.

## Decision

### Pattern: adapter + journal (Railway pattern)

Neon uses a `NeonAdapter` interface wrapping `NeonClient`. The engine (`applyNeonPlan`) uses journal-based step-by-step execution with a `completed` set for replay idempotency — identical to Railway's pattern. The adapter layer adds name-based existence checks (list + filter) before creation to prevent duplicate resources when the journal is absent. Neither mechanism provides concurrency-safe idempotency; concurrent apply calls may create duplicate projects or branches. Per-resource serialization or a provider-supported idempotency key would be required for that guarantee.

### Intents

Four plan intents:

1. **provision** — ensure project exists → ensure branch exists → get connection URI
2. **migration** — ensure branch → run migration command via `piExec` → get connection URI
3. **preview** — create preview branch with expiration → get connection URI
4. ~~recovery~~ — deferred per spec (PITR types retained in client for future use)

### Module structure (14 files)

```
src/providers/neon/
  client.ts         — NeonClient REST wrapper (async polling, cursor pagination)
  adapter.ts        — NeonAdapter (ensureProject, ensureBranch, createPreviewBranch)
  credentials.ts    — loadNeonCredentials (NEON_API_KEY)
  manifest.ts       — NeonManifest schema + detailed validation
  plan.ts           — NeonPlan schema, digest, buildNeonPlan
  state.ts          — NeonState schema, redactConnectionUri helper
  execution.ts      — NeonExecution type guard
  journal.ts        — JSONL journal entries (simple, no hash chain)
  authorization.ts  — Plan authorization (digest, staleness, approval)
  engine.ts         — applyNeonPlan (journal-based step execution)
  ship-ops.ts       — ShipHandler (validate, plan, apply_plan, status, logs)
  db-ops.ts         — DatabaseHandler (plan_migration, apply_plan)
  package.ts        — ProviderPackage facade
  index.ts          — Barrel exports
```

### Key design choices

- **Async operation polling in adapter** — `ensureProject`, `ensureBranch`, `createPreviewBranch` all poll Neon operations to completion before returning. Timeout: 60 seconds. Transparent to engine.
- **Connection URI redaction** — `redactConnectionUri()` parses `://user:pass@host` pattern and replaces password with `[REDACTED]` before persisting to state. Fresh URIs fetched when needed.
- **Preview branch expiry** — uses `expires_at` on the branch object (not endpoint TTL) for auto-deletion. Max 30 days per Neon API.
- **Migration DATABASE_URL injection** — migration commands receive `DATABASE_URL` via `process.env` mutation with try/finally cleanup because `piExec` lacks an explicit `env` option. This has process-wide side effects: other tools executing concurrently can observe the mutated `DATABASE_URL` during the migration window. The boundary layer mitigates this in exclusive mode by blocking non-protected tools from reading the credential, but the process-level mutation remains a known limitation. When `piExec` supports per-process environment overrides, the engine should switch to that mechanism.
- **No idempotency keys** — Neon API lacks `Idempotency-Key` header. pi-ship implements dedup via name-based existence checks (list + filter) before creation.
- **URL construction** — uses string concatenation (`${baseUrl}${path}`) instead of `new URL()` to preserve the `/api/v2` path segment in the base URL.

## Alternatives considered

### Vercel operation-engine pattern
Overkill for Neon. No deployment lifecycle, no immutable artifacts, no reconciliation needed. The operation-engine's hash-chained journal and immutable operations add complexity without benefit for CRUD-oriented provisioning.

### Direct SQL for migrations
Running migrations via direct SQL connection (bypassing `piExec`) would be simpler but loses the approval-gated execution model. Using `piExec` keeps migration commands within the same approval and execution framework as Railway migrations.

### Storing full connection URIs in state
Simpler but leaks database passwords to disk. Redaction with on-demand fresh URI fetching is more secure at the cost of an extra API call.

## Consequences

### Positive
- Journal-based idempotency prevents duplicate provisioning during replayed retries
- Async operation polling handles Neon's eventual-consistency model
- Connection URI redaction prevents credential leaks in state files
- Preview branches with auto-expiration prevent cost accumulation
- Detailed manifest validation with `Value.Errors` iteration

### Negative
- `process.env.DATABASE_URL` mutation has process-wide side effects during migration step
- Connection URI redaction uses indexOf-based string parsing — unusual URI formats (encoded credentials, embedded @ characters, IPv6 hosts) may not be fully redacted. A structural URL-parser-based redaction would handle these cases correctly.
- No version pinning for migration commands — migration command content can change between plan and apply
- `DOMException` usage in `delay()` requires Node.js ≥17

### Security
- API key redacted in all error messages via `redact()`
- Connection URIs redacted before state persistence
- Plan authorization validates digest, staleness (30 min), and approval
- Migration commands run within the same security context as other pi-ship operations

### Verification
- 127 unit tests across 8 test files (manifest, plan, state, client, adapter, engine, authorization, journal)
- Fake client with in-memory state and call recording
- All tests pass with `npx vitest run`
