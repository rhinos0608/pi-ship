# Production Expansion Design

**Date:** 2026-07-14
**Status:** Approved
**Decision:** Option A — versioned capability runtime, Vercel first, Cloudflare Workers second, Neon first database connector.

## Goal

Expand pi-ship beyond its Railway MVP with production-grade multi-provider deployment and database automation while preserving approval, digest, secret, and rollback safety.

## Non-goals for initial delivery

- Raw or model-supplied SQL, shell commands, connection strings, dump paths, or DNS values.
- Database restore, deletion, reverse migrations, local backup export, or unattended production mutation.
- Generic Cloudflare connector covering Pages, D1, KV, R2, Durable Objects, and DNS.
- Vercel domains, webhooks, log drains, custom environments, or marketplace databases.
- Rewriting persisted V1 Railway plans or changing their digests.

## Architecture

Use shared versioned planning, approval, journaling, and reconciliation around separate capability runtimes:

- **App runtime:** discover target, write secrets, deploy, inspect status, read bounded logs, rollback, optionally preview/promote.
- **Database runtime:** inspect, provision, branch, inspect migration state, create provider-managed recovery point, apply manifest-bound migration. Restore remains separate and deferred.
- **Domain runtime:** ownership verification and restricted attachment/DNS mutation. Deferred.

Current `ProviderAdapter` remains the Railway V1 path. New providers use V2 operation contracts rather than pretending Vercel projects or Cloudflare Workers are Railway services.

## Versioned contracts

- Preserve current manifest, plan, and state as V1 Railway contracts.
- Add strict Typebox V2 discriminated unions with `additionalProperties: false`.
- V2 manifest separates `app` and optional `database` provider/config sections.
- V2 plans include version, operation domain, provider/account/project/environment fingerprints, typed operations, and provider-specific target hashes.
- V2 state stores independent application and database targets.
- Runtime-validate persisted V1 and V2 plans/state. Never cast unvalidated JSON.
- Transparently read V1 Railway state; write V2 only after validated migration.

## Execution safety

1. `discover → plan → approve → execute → reconcile`.
2. Journal success alone cannot authorize ambiguous retry; provider state must match expected state.
3. Unsupported capability returns `E_PHASE_UNSUPPORTED`, never no-op success.
4. Production mutation remains interactive and fails closed headlessly.
5. App deployment, database mutation, restore, and DNS use separate plans and approvals.
6. Approval summary prominently displays provider, account/project/environment, target fingerprint, and impact.
7. Provider credential loader passes each adapter only its own token and approved identifiers.
8. Secret values remain write-only and never enter plans, state, journals, logs, or tool results.
9. Provider responses receive runtime validation; malformed/missing responses remain unverified.
10. Database migrations reference repository-owned artifacts or package scripts whose hash enters the plan. No package download during production migration.

## Capability policy

Adopt `allow | ask | deny` by capability and environment:

- Read-only inspection: allow.
- Remote preview mutation: ask.
- Production mutation: always ask.
- Destructive database/domain mutation: separate plan, always ask.
- Headless production/destructive mutation: deny.

## Provider phases

### Phase 0 — Safety and contract foundation

Add missing engine/tool/gate/index tests, V1/V2 validators, provider-scoped credential loading, adapter factory, provider-visible approval, typed operation journal, corruption rejection, runtime response schemas, and ambiguous-result reconciliation. Preserve Railway behavior.

### Phase 1 — Vercel

Auth, project discovery/create, write-only sensitive environment-variable upsert, preview/production deploy, status, bounded build/runtime logs, rollback.

### Phase 2 — Cloudflare Workers

Auth, Worker discovery, stable script deployment, encrypted secrets, deployment/version inspection, preview support, rollback where binding constraints permit. Exclude Pages, D1, KV, R2, Durable Objects, DNS, gradual traffic, Deploy Hooks, and beta-only APIs.

### Phase 3 — Neon

Inspect, provision, migration status, preview branch, provider-managed recovery point, and manifest-bound migration apply. Restore remains deferred.

### Phase 4 — Destructive and ancillary operations

Separate threat review and product approval for restore/PITR, DNS, deletion, KV/R2 lifecycle, local backup/export, and unattended production automation.

## Testing and verification

- Test-first behavioral changes.
- Native `fetch` with injectable fake clients and strict response schemas; avoid new SDK dependencies until proven necessary.
- Fake capability runtimes for cloud-free engine tests.
- Provider contract tests cover auth, error mapping, rate limits, malformed responses, idempotency, cancellation, secret non-disclosure, and ambiguous reconciliation.
- Required checks: `npm test`, `npm run typecheck`, `npm run acceptance`, `git diff --check`.
- Live cloud behavior remains manually verified in disposable accounts and never claimed from unit tests.

## Approved decisions

- Capability-oriented V2 architecture.
- V1/V2 side-by-side compatibility.
- Vercel before Cloudflare Workers.
- Cloudflare Workers scope only for app connector.
- Neon as first database connector.
- Provider-managed recovery points only initially.
- Restore and automatic database rollback deferred.
- Provider-isolated process environment credentials.
- No unattended production/destructive apply.
- DNS/domain work remains separate.
