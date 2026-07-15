# ADR 0008 — Post-MVP Provider Parity & Capability Signing

- **Status:** draft
- **Date:** 2026-07-15
- **Affected:** `src/boundary/`, `src/providers/cloudflare/`, `src/providers/neon/`, `src/providers/railway/`, `src/providers/vercel/`, `src/tools/db/`

## Context

pi-ship is past MVP state. A 42-file implementation diff (729 insertions, 307 deletions) already addresses two of four planned post-MVP items: Neon `process.env.DATABASE_URL` documentation and Cloudflare `versionId: "pending"` execution-time resolution. Six remaining documented gaps span all four providers: capability signing, Cloudflare logs, Neon rollback, Railway preview environments, Railway Postgres auto-provisioning, and provider feature parity documentation.

## Decisions

### 1. Capability signing — ephemeral Ed25519

**Decision:** Use Node.js ≥22.19 built-in Ed25519 (`crypto.generateKeyPairSync('ed25519')`, `crypto.sign(null, ...)`, `crypto.verify(null, ...)`). No new dependency.

**Key management:** One ephemeral Ed25519 keypair generated at `CredentialVault` initialization, held in memory only. Never persisted. Key dies with the process. No key rotation.

**Token format:** `SignedCapability` extends `BoundaryCapability` with `version`, `keyId` (base64url raw public key), `issuer`, `audience`, `projectBinding`, `jti` (UUID v4 nonce), and `signature` (64-byte Ed25519, base64url-encoded). Claims are canonicalized via existing `deepSort` + `JSON.stringify` before signing.

**Cross-process flow:** Parent signs capability, passes to child via env var `PI_SHIP_CAPABILITY` along with `PI_SHIP_PUBLIC_KEY` (base64url raw public key). Child verifies by:
1. Checking `keyId` matches trusted public key.
2. Re-canonicalizing claims (excluding signature).
3. `crypto.verify(null, payload, publicKey, signature)`.
4. Checking expiry and `jti` non-replay (in-memory Set with TTL-bounded eviction).

**Replay prevention:** Three-layer: short 5-min TTL, `jti` per token, optional in-memory single-use tracking.

**Backward compatibility:** Unsigned `BoundaryCapability` continues to work in `managed` and `warn` modes. `exclusive` mode rejects unsigned tokens. No breaking change to existing capability types.

**Threat model / non-goals:** Replay window ≤5 min. Private key exfiltration = process compromise (game over regardless). No PKI, no CA, no federation, no hardware security module. No cross-process jti sharing (each process tracks independently). Signed capability does NOT prove approval — approval registry check remains separate.

### 2. Cloudflare logs — Workers Tail API

**Decision:** Implement Cloudflare worker log streaming via the Classic Tail API.

**API flow:** `POST /accounts/{id}/workers/scripts/{name}/tails` → get `{id, expires_at, url}` → WebSocket connect to `url` → collect JSON tail events → `DELETE /tails/{id}` for cleanup.

**Constraints:**
- **Live-only:** No historical replay. `lines` parameter means "collect up to N and stop", not "fetch last N".
- **Worker-scoped:** API addresses by `scriptName`, not deployment ID. pi-ship must resolve mapping from `releaseId` context.
- **10-session limit:** Must always delete tails in `finally` block. Use `AbortSignal` for timeout-based cleanup.
- **Redaction by default:** Headers/URLs are redacted. pi-ship accepts redacted output to avoid leaking secrets.

**New client methods:** `createTail(scriptName)`, `deleteTail(scriptName, tailId)`, `listTails(scriptName)`.

**Descriptor update:** Add `"logs"` to Cloudflare runtime `capabilities` array.

**Documentation:** Output labeled as `scope: "worker-live"` — never claim deployment-specific logs. Sampling under high traffic is documented.

### 3. Neon rollback — branch restore with restore-point binding

**Decision:** Implement Neon rollback via the Branch Restore API (`POST /projects/{pid}/branches/{bid}/restore`). Destructive approval required.

**Restore-point capture:** Before running migration, capture current timestamp via `new Date().toISOString()`. Store as restore point in state bound to `(projectId, branchId, planId, planDigest)`.

**Rollback flow:**
1. `ship.plan` with `intent: "rollback"` resolves `targetReleaseId` to an owned restore point.
2. Plan digest binds the restore point — prevents substitution.
3. `ship.apply_plan` calls `adapter.restoreBranch(projectId, branchId, { sourceTimestamp, sourceBranchId, preserveUnderName })`.
4. Destructive approval required (`riskLevel: "destructive"`).
5. Neon auto-creates `{branch}_old_{timestamp}` backup branch on restore.

**State additions:** `NeonState.restorePoints: Array<{planId, planDigest, projectId, branchId, timestamp, at}>`.

**Constraints:**
- Only root branches support PITR with timestamp/LSN.
- No arbitrary timestamp / cross-branch restore from tool input.
- Rollback is destructive — replaces all data on target branch.

### 4. Neon logs — vendor gap

**Decision:** No log API exists. Neon has no self-serve log/audit endpoint. `pg_stat_activity` is activity metadata, not a log stream. HIPAA audit logs exist but require a support ticket. OpenTelemetry forwarding is push-only (Console configuration, not API-queryable).

**Action:** Keep existing stub message directing users to Neon Console. Document as vendor limitation. Do not implement fake log output.

### 5. Railway preview environments

**Decision:** Implement preview environments as Railway ephemeral environments. Explicit `previewId` required — no auto-discovery.

**API flow:**
1. `ship.plan` accepts `previewId` parameter for `environment: "preview"` intent.
2. `environmentCreate({ projectId, name: previewId, ephemeral: true, sourceEnvironmentId, skipInitialDeploys: true })` — idempotent (check existence first).
3. `templateDeployV2` provisions Postgres into preview environment.
4. `variableCollectionUpsert` sets `DATABASE_URL` to `${{Postgres.DATABASE_URL}}` (reference variable, never plaintext).
5. `serviceInstanceDeployV2(serviceId, environmentId)` deploys to preview.

**State schema:** `RailwayState.previews: Record<previewId, { environmentId, serviceId, projectId, postgresServiceId?, createdAt }>`.

**Tool schema:** `ship.plan` requires `previewId` when `environment === "preview"`.

**Cleanup:** `environmentDelete(id)` when preview is torn down. Managed by operator (no auto-cleanup).

### 6. Railway Postgres auto-provisioning

**Decision:** Replace deprecated `pluginCreate` with `templateDeployV2` targeting the `postgres` template code.

**Flow:**
1. Query `template(code: "postgres") { id serializedConfig }` — cache template ID.
2. Query `project(id) { workspaceId }` for workspace discovery.
3. `templateDeployV2({ templateId, serializedConfig, projectId, environmentId, workspaceId })`.
4. Poll for deployment completion, then set reference variable on app service.
5. Idempotent: check for existing Postgres service instance before provisioning.

### 7. Database provider parity

**Decision:** Keep generic path as the single source of truth. Remove dead provider stubs.

**Key finding:** `src/tools/db/index.ts` handles `inspect`, `browse`, `query`, `plan` (ad-hoc SQL), and `db-plan/1` `apply_plan` generically before any provider dispatch. Provider db-ops files contain `inspect`/`browse`/`query` stubs that are **never reached** — dead code.

**Actions:**
- **Remove** `inspect`, `browse`, `query`, and `plan` stubs from Neon and Railway db-ops (dead code).
- **Remove** `E_PHASE_UNSUPPORTED` guard in `src/tools/db/index.ts` line 97 for ship actions — per the capability matrix, providers implement what they can; unsupported actions should dispatch to provider handlers which return appropriate errors or succeed.
- **Implement `migration_status`**: Read the generic database journal (`database-journal.jsonl`) for `db-plan/1` entries. For provider migration plans, either write to the generic journal or provide a provider-specific status query.
- **Vercel db-ops:** When Phase 1 is reached, resolve `manifest.database.config.urlSecretName` → fetch Vercel secret → inject as `DATABASE_URL` for the generic path. No separate DB implementations needed.

### 8. Provider feature matrix — documented gaps

| Gap | Provider | Status |
|-----|----------|--------|
| Logs | Cloudflare | Implement via Tail API (this ADR) |
| Logs | Neon | Vendor-limited — no API |
| Preview | Railway | Implement via ephemeral envs (this ADR) |
| Postgres | Railway | Implement via templateDeployV2 (this ADR) |
| Rollback | Neon | Implement via branch restore (this ADR) |
| DB inspection | Neon | Vendor-limited — use Neon Console |
| Preview URLs | Cloudflare | Vendor-limited — not returned by API |
| Source enumeration | Cloudflare | Vendor-limited — single-file only |

## Rejected Alternatives

- **Persistent signing keys:** Rejected for v1. Adds key file management, passphrase prompts, rotation ceremony. Ephemeral keys provide equivalent security with zero operational overhead for single-tenant deployments.
- **Railway `pluginCreate`:** Deprecated by Railway. `templateDeployV2` is the supported replacement.
- **Neon logs via `pg_stat_activity`:** Rejected. Activity metadata is not an append-only log. Presenting it as `ship log` output would mislead users.
- **Railway preview auto-discovery:** Rejected. Multiple concurrent previews without explicit identifiers creates state ambiguity. Explicit `previewId` required.
- **Per-provider DB read implementations:** Rejected. The generic `db/index.ts` path already handles all PostgreSQL read operations correctly. Duplicating it per provider adds no value and creates divergence risk.

## References

- [Provider Capability Matrix](../research/provider-capability-matrix.md) — detailed per-feature breakdown, vendor limitations, and status key.
- [ADR 0007 — Database Access Boundary](./0007-database-access-boundary.md) — credential isolation and boundary design.
- [ADR 0008 — Deployment Resource Boundary](./0008-deployment-resource-boundary.md) — resource boundary design.

## Rollout

- **No breaking changes** to existing APIs, plan schemas, or state schemas.
- All additions are additive: new fields in `BoundaryCapability` → `SignedCapability`, new `previews` map in `RailwayState`, new `restorePoints` in `NeonState`, new Cloudflare `logs` capability.
- Existing unsigned capabilities continue to work in `managed`/`warn` modes.
- `exclusive` mode gains signed-capability enforcement — requires pi-permission-system to be active before startup; absent enforcement now causes startup failure (`E_CONFIG_INVALID`).

## Test Matrix

| Area | What to test |
|------|-------------|
| Capability signing | Valid signature accepted; altered claim/signature rejected; expired rejected; wrong audience rejected; replay rejected |
| Capability backward compat | Unsigned cap accepted in managed/warn; rejected in exclusive |
| Cloudflare logs | Tail create → WS connect → consume events → delete; cleanup on abort/signal; 10-session limit handling |
| Neon rollback | Restore-point capture before migration; restore with valid point; reject foreign/stale restore point |
| Railway preview | Environment create idempotence; Postgres provision idempotence; reference variable binding; state isolation |
| DB parity | Generic inspect/browse/query works for all providers with DATABASE_URL; dead stubs removed; migration_status via journal |
## References

- `docs/research/capability-signing.md` — Ed25519 API research, token format, key management, threat model
- `docs/research/cloudflare-tail.md` — Cloudflare Workers Tail API: endpoints, WebSocket messages, lifecycle, limits
- `docs/research/neon-observability-rollback.md` — Neon branch restore API: semantics, restore-point capture, vendor log gap
- `docs/research/railway-preview-postgres.md` — Railway GraphQL API: ephemeral environments, templateDeployV2, reference variables
- `docs/research/database-provider-parity.md` — Generic vs provider DB path analysis, dead stub audit, migration_status design
- `docs/research/provider-capability-matrix.md` — 14-feature × 4-provider classification matrix
- `docs/adr/0007-database-access-boundary.md` — Preceding ADR for credential vault and boundary enforcement
- `node:crypto` Ed25519 — [Node.js ≥22.19 docs](https://nodejs.org/api/crypto.html#cryptogeneratekeypairsynctype-options)
