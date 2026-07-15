# ADR 0005: Cloudflare Workers provider

## Status

Accepted

## Context

pi-ship needs a Cloudflare Workers provider for approval-gated deployment of Worker scripts. Cloudflare Workers API uses REST at `https://api.cloudflare.com/client/v4` with Bearer token auth. Workers have a version/deployment lifecycle: upload creates an immutable version, deploy promotes a version to traffic. Secrets are encrypted per-script. Rollback creates a new deployment pointing to an old version.

The existing codebase has two provider patterns:
- **Railway**: adapter-based, journal-based step-by-step engine
- **Vercel**: operation-engine based, hash-chained journal, immutable operations

Cloudflare Workers' version/deployment model is structurally similar to Vercel's release model — both have immutable artifacts promoted to traffic via deployments. The Vercel pattern (operation-engine with `runOperationPlan`) fits better than Railway's simpler adapter pattern.

Scope: Auth, Worker discovery, stable script deployment, encrypted secrets, deployment/version inspection, preview support, rollback. Excluded: Pages, D1, KV, R2, Durable Objects, DNS, gradual traffic, Deploy Hooks, beta-only APIs.

## Decision

### Pattern: operation-engine (Vercel pattern)

Cloudflare Workers uses `runOperationPlan` from `src/deployment/operation-engine.ts` with hash-chained journal entries. Operations are immutable after plan creation. The engine handles idempotency via journal replay and reconciliation.

### Operations

Four operations with topological dependencies:

1. **ensure_worker** — create or verify worker exists via multipart PUT
2. **upload_version** — upload script content as a new version (POST /versions, multipart)
3. **set_secrets** — bulk PATCH secrets via `/secrets-bulk` endpoint
4. **deploy** — create deployment with latest version at 100% traffic

Rollback intent produces a single **rollback** operation: create deployment pointing to target version with `force: true`.

### Module structure (14 files)

```
src/providers/cloudflare/
  types.ts              — TypeBox schemas (Script, Version, Deployment, Secret)
  credentials.ts        — loadCloudflareCredentials (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID)
  client.ts             — CloudflareClient REST wrapper (multipart upload, bulk secrets)
  manifest.ts           — CloudflareManifest schema + validation
  plan.ts               — CloudflarePlan schema, operation builder, digest
  state.ts              — CloudflareState schema (worker, deployments, history)
  execution.ts          — CloudflareExecution type guard
  runtime.ts            — CloudflareRuntime (execute, reconcile, checkAuth)
  operation-journal.ts  — Hash-chained journal entries
  authorization.ts      — Plan authorization (digest, staleness, identity, topology)
  engine.ts             — applyCloudflarePlan via runOperationPlan
  ship-ops.ts           — ShipHandler (validate, plan, apply_plan, status, logs)
  package.ts            — ProviderPackage facade
  index.ts              — Barrel exports
```

### Key design choices

- **Deploy picks latest version at execution time** — `upload_version` creates a version, `deploy` calls `listVersions` and picks the first (latest). The uploaded version ID is not propagated from `upload_version` into the deploy operation by the generic engine; instead the runtime re-queries the API. Risk: race condition if a concurrent upload creates a newer version between `upload_version` and `deploy`. The `versionId` field in the deploy operation stores `"pending"` at plan time. Future work: propagate version ID through `resourceRef` chaining.
- **Script source via manifest `source` field** — path to worker script file relative to cwd. Runtime reads file content at execution time.
- **Secrets via bulk PATCH** — single API call for all secrets. Cloudflare's `/secrets-bulk` endpoint applies secrets sequentially; partial failures leave some secrets written and others not. The engine handles this by retrying the full bulk operation and reporting per-secret errors when they occur.
- **Token redaction** — `safeMsg` captures `config.apiToken` and `config.accountId` in `secretValues` array, passed to `redact()` for error message sanitization.
- **No source directory upload** — Workers use single script files, not directory uploads like Vercel.

## Alternatives considered

### Railway adapter pattern
Simpler but lacks operation-level idempotency and reconciliation. Workers' version/deployment lifecycle benefits from the operation-engine's immutable operation model and hash-chained journal.

### Wrangler CLI
Using `wrangler deploy` via CLI would be simpler but loses API-level control over version/deployment separation, secret management granularity, and rollback precision. The REST API gives finer control.

## Consequences

### Positive
- Operation-level idempotency via hash-chained journal
- Reconciliation support for worker existence and deployment status
- Fine-grained secret management via bulk PATCH
- Version/deployment separation enables preview without deploy

### Negative
- Deploy picks latest version at execution time — no version pinning between plan and deploy
- Source fingerprinting — the plan computes a `requestFingerprint` over the operation payload including source content. Authorization validates operation fingerprints against the approved plan. However, because the deploy operation's `versionId` is resolved at execution time (see above), the deploy fingerprint uses `"pending"` as a placeholder — script content is fingerprinted for `ensure_worker` and `upload_version` but not for the deploy step itself.
- Manifest `source` field is required for deployment — manifests without a `source` field fail validation during planning. Placeholder script content (`// placeholder …`) is used only in isolated test fixtures where the runtime bypasses manifest validation.

### Security
- API token redacted in all error messages via `redact()`
- Secrets never stored in state or journal
- Plan authorization validates digest, staleness (30 min), identity, operation fingerprints, and dependency topology

### Verification
- 123 unit tests across 7 test files (manifest, plan, state, client, runtime, operation-journal, authorization)
- Fake client with in-memory state and call recording
- All tests pass with `npx vitest run`
