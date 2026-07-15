# ADR 0007: Database access boundary and credential isolation

## Status

Accepted

## Context

pi-ship's `DB` tool and provider engines read database credentials directly from `process.env`. This means `DATABASE_URL` — and transitively the production database password — is ambient to the entire Node.js process. Any tool call (bash, MCP, or extension) can read it, either through `$DATABASE_URL` shell expansion or by inspecting `process.env` in a script.

Three concrete leak vectors exist today:

1. `requireDatabaseUrl()` in `src/tools/db/index.ts` reads `DATABASE_URL` from the credential source, which wraps `process.env`.
2. Neon's migration engine (`src/providers/neon/engine.ts`) mutates `process.env.DATABASE_URL = dbUri` before calling `piExec` for migration commands.
3. All provider credential loaders (`loadRailwayCredentials`, `loadVercelCredentials`, `loadCloudflareCredentials`, `loadNeonCredentials`) read raw `process.env`.

The current approval flow (planId + planDigest + cwd) gates operations performed *through* pi-ship tools. It does not prevent credential access *outside* pi-ship. The accurate claim today is: "database operations performed through pi-ship are approval-gated." The stronger claim — "all agent database access is mediated through pi-ship" — requires credential isolation.

Pi has no built-in boundary or sandbox mechanism. Two mature third-party extensions exist (`pi-permission-system` for policy-based tool gating, `pi-sandbox` for OS-level sandboxing), but neither integrates with pi-ship's plan/approval model. Boundary enforcement must be extension-driven via the `tool_call` hook.

## Decision

### External boundary extension

Exclusive mode requires pi-permission-system to be installed and active. Detection uses the public runtime sentinel `globalThis.__piPermissionSystem` (documented in pi-permission-system's README). The sentinel exposes `getYoloMode`/`toggleYoloMode`/`setYoloMode` — its presence confirms the extension loaded.

pi-permission-system was chosen over pi-sandbox because:
- Public documented runtime API for detection (pi-sandbox has no equivalent readiness signal)
- Compatible Pi peer dependency range (^0.80.0 vs pi-sandbox's ^0.74.0)
- Complementary policy layer: pi-permission-system gates tools/bash/MCP/skills; pi-ship gates credential vault

Integration is shallow feature detection only — pi-ship never imports pi-permission-system as a dependency. Missing/disabled extension causes exclusive mode to fail closed at startup with: "exclusive databaseAccess mode requires an active boundary (install pi-permission-system); none detected".

### Three-tier security mode

A `databaseAccess.mode` field in `pi-ship.json` controls enforcement:

| Mode | Behavior |
|------|----------|
| `managed` | Default. No boundary registered. Existing approval flow unchanged. Accurate claim: "DB operations through pi-ship are approval-gated." |
| `warn` | Boundary active. Warns when protected credentials appear in non-protected tool calls (bash, MCP). Does not block. |
| `exclusive` | Fails closed at startup if no compatible boundary extension is detected. CredentialVault blocks direct credential reads without a valid capability. Tool-call inspection uses substring matching on serialized input to detect credential references. Accurate claim: "pi-ship's CredentialVault gates credential access; tool-call inspection warns or blocks when protected credential names appear in non-protected tool inputs." DATABASE_URL remains in process.env and is observable by any code running in the same process; full isolation requires an external boundary extension. |

### Protected resource descriptors

Resources are declared, not inferred. A `ProtectedResourceDescriptor` describes what is guarded:

```typescript
interface ProtectedResourceDescriptor {
  type: ResourceType;           // "database" | "deployment"
  name: string;                 // e.g., "production-database"
  credentialNames: string[];    // e.g., ["DATABASE_URL"]
  hostnames: string[];          // e.g., ["db.example.com"]
  ports: number[];              // e.g., [5432]
  filePaths: string[];          // e.g., ["/var/lib/pg/data"]
  allowedExecutors: string[];   // e.g., ["DB"]
}
```

The `ProtectedResourceRegistry` collects all registered resources and provides lookup by name, type, credential name, and executor.

Per-provider resource descriptors are defined in `src/boundary/resource.ts`:

| Descriptor | `type` | Protected Credentials |
|------------|--------|----------------------|
| `createDatabaseResource()` | `database` | `DATABASE_URL` |
| `createVercelResource()` | `deployment` | `VERCEL_TOKEN` |
| `createRailwayResource()` | `deployment` | `RAILWAY_API_TOKEN`, `RAILWAY_TOKEN` |
| `createCloudflareResource()` | `deployment` | `CLOUDFLARE_API_TOKEN` |
| `createNeonControlPlaneResource()` | `database` | `NEON_API_KEY` |

`CLOUDFLARE_ACCOUNT_ID` is intentionally **not** protected — it is an identifier, not a secret.
Neon control plane uses `type: "database"` because it is database infrastructure, not deployment.

### Credential vault

`CredentialVault` wraps a `CredentialSource` and mediates access based on security mode:

- **Managed**: passes through (no mediation).
- **Warn**: passes through (enforcement layer emits warnings).
- **Exclusive**: returns `undefined` for protected credentials unless the caller presents a valid, non-expired `BoundaryCapability`.

The vault implements `CredentialSource` (via `asCredentialSource()`) so it can be injected into existing tool registration without changing interfaces.

`CredentialVault` also exposes ALS-based context propagation:
- `runWithCapability(capability, fn)` — makes the capability available to all nested `get()` calls
- `runTrusted(fn)` — marks the callback as trusted, bypassing capability requirement for non-mutating operations

### Capability tokens

Capabilities are in-memory objects bound to a specific plan digest, resource, and expiry window (default 5 minutes):

```typescript
interface BoundaryCapability {
  resource: string;        // "production-database"
  operation: "read" | "write" | "execute";
  planId: string;          // plan identity for approval binding
  planDigest: string;      // SHA-256 of approved plan
  riskLevel: "read" | "write" | "destructive";
  issuedAt: string;        // ISO 8601
  expiresAt: string;        // ISO 8601, default +5min
}
```

`validateCapability` (in `src/boundary/capability.ts`) now performs full validation: planId match, resource match, planDigest match, expiry check, and approval-registry check via `registry.isApproved()` with domain/risk metadata. A `resourceType` parameter drives `ApprovalMetadata.domain` derivation (`"database"` vs `"deployment"`). `CredentialVault.get()` in exclusive mode calls `validateCapability` when the vault was constructed with an `approvalRegistry`, integrating full validation into every credential access path.

`CredentialVault` supports ALS-based capability propagation via `runWithCapability(capability, fn)` — callers inside `fn` can read protected credentials without passing the capability explicitly. `runTrusted(fn)` provides an escape hatch for non-mutating operations (plan inspection, status checks) that need credential access but are explicitly scoped to safe actions.

Capabilities are not signed (in-memory only) — this is acceptable because pi-ship tools and the boundary layer share the same process. Cross-process capability transfer would require Ed25519 signing (future work).

### Enforcement engine

`BoundaryEnforcer` checks two surfaces:

1. **Tool calls** (`checkToolCall`): DB and ship tools are always allowed (they ARE the boundary for their own operations). Other tools are checked for credential-name references in serialized input. In exclusive mode, non-protected tools referencing protected credentials are blocked.

2. **Credential access** (`checkCredentialAccess`): Protected credentials in exclusive mode require a valid capability. In warn mode, access is allowed but flagged.

### Startup validation

Exclusive mode calls `validateStartup()` which throws `E_CONFIG_INVALID` if pi-permission-system is not detected. Detection uses structural feature probing via `src/boundary/integration/permission-system.ts`. Internal boundary (vault + enforcer + capability + approval) is always active when warn/exclusive mode is configured; the external check gates exclusive mode specifically.

### Integration wiring

The extension entry point (`src/integration/register.ts`) creates the boundary components:

1. Reads `pi-ship.json` → `loadBoundaryConfig()`
2. If mode is `warn` or `exclusive`: creates `ProtectedResourceRegistry` (pre-registers all six resource descriptors), `CredentialVault` (with `approvalRegistry` for exclusive mode), `BoundaryEnforcer`
3. Passes `vault.asCredentialSource()` as the credential source to both `registerDB` and `registerShip`
4. If mode is `managed` or no manifest: falls back to raw `environmentSource()`

Ship tool wiring uses `CredentialVault.runTrusted()` for non-mutating ship actions (validate, plan, status, logs). Mutating apply actions use an approved-plan capability via `runApprovedOperation()` — a helper in `src/tools/ship/index.ts` used by all four providers.

### Config error propagation

Invalid `databaseAccess.mode` values (e.g., `"yolo"`) throw `E_CONFIG_INVALID` and propagate to the user. File-not-found or parse errors for `pi-ship.json` are caught and treated as managed mode (no boundary).

## Alternatives considered

### Shell command denylist

Pattern-matching shell commands for database clients (`psql`, `mysql`, `pg_dump`, etc.) was rejected. It cannot cover arbitrary scripts, Node.js code, or renamed binaries. Credential isolation is strictly stronger — if the shell never receives the credential, every conceivable client is blocked.

### Signed Ed25519 capability tokens

Per-call cryptographically signed tokens (Clampd scope-token pattern) were considered for cross-process enforcement. Rejected for v1 because pi-ship tools and the boundary layer share the same process — in-memory capabilities are sufficient. The `BoundaryCapability` interface is designed to be extended with signatures when cross-process isolation is needed.

### OS-level sandboxing

Using `sandbox-exec` (macOS) or `bubblewrap` (Linux) to isolate the entire agent process was considered. Rejected because pi-ship runs inside Pi's extension runtime, which is not sandbox-aware. The vault approach works within Pi's existing architecture without requiring OS-level changes.

### Credential proxy (separate process)

A separate credential-holding process (credwrap pattern) that injects credentials only into approved tool subprocesses was considered. Rejected because `piExec` (ExtensionAPI.exec) does not support environment variable overrides — credentials must be in `process.env` for subprocess access. The vault mitigates this by blocking non-protected tools from reading protected credentials.

### Extending `registerShip` credential interface

Ship tool already accepts `credentialSource` in deps but it was not being passed. Rather than adding a new parameter, we pass the same `effectiveSource` used by the DB tool. This is a one-line change in `src/index.ts`.

## Consequences

### Positive

- Credential isolation is enforced at the vault level, not by pattern-matching shell commands
- Three clearly named trust levels with distinct security guarantees
- Exclusive mode fails closed — requires pi-permission-system to be installed; cannot be accidentally activated without external boundary
- `ProtectedResourceDescriptor` covers database credentials, deployment provider tokens (Vercel, Railway, Cloudflare), and Neon control plane API key
- Existing approval flow unchanged in managed mode — zero behavioral change for default users
- Ship tool now also receives vault-backed credentials (previously bypassed)
- External boundary detection is shallow structural probing — no dependency on pi-permission-system internals

### Negative

- Exclusive mode requires pi-permission-system to be installed and active — adds a runtime prerequisite
- Substring match on serialized JSON for credential detection in tool calls — false positives possible with short credential names (low risk: default protected credential is `DATABASE_URL`, specific enough)
- `piExec` lacks env override support, so Neon migration engine still mutates `process.env.DATABASE_URL` — the vault blocks other tools from reading it, but the process-level mutation remains
- Capabilities are in-memory objects, not cryptographically signed — sufficient for single-process but not for cross-boundary enforcement

### Security

- Tool-call inspection blocks non-protected tools from referencing `DATABASE_URL` in exclusive mode
- Capabilities are plan-digest-bound and time-limited (5-minute default TTL)
- Protected credential names never appear in error messages (existing `redact.ts` handles this)
- `E_CONFIG_INVALID` for invalid mode values propagates to user (no silent degradation)
- Config file errors (missing/unreadable `pi-ship.json`) fall back to managed mode

### Migration

- No migration needed — `databaseAccess` is optional in `pi-ship.json`
- Default behavior (managed mode) is identical to pre-boundary behavior
- Existing test suite unaffected — 89 new boundary tests, zero regressions

### Known Limitations

#### Neon migration `process.env` mutation

Neon's migration engine temporarily sets `process.env.DATABASE_URL` before spawning a subprocess migration (`src/providers/neon/engine.ts:164-165`). This bypasses `CredentialVault` because global `process.env` cannot be gated. The `DATABASE_URL` value is visible to any concurrent operation during the migration window.

**Mitigation:** In exclusive mode, the ship tool's `runApprovedOperation` ensures only authorized apply operations can reach the migration code path. The global env mutation is a concurrency concern, not an authorization bypass.

**Future fix:** Requires `piExec` to support per-subprocess `env` overrides. Then the migration can pass `{ env: { ...process.env, DATABASE_URL: dbUri } }` instead of mutating global state.

## Related

- [ADR 0008: Deployment Resource Boundary](./0008-deployment-resource-boundary.md) — extends boundary protection to deployment provider credentials

## Verification

- `npx vitest --run test/boundary/` — 89 boundary tests pass (types, config, resource, vault, capability, enforcement, barrel, integration, full integration, permission-system detection)
- `npx vitest --run` — full suite passes (68 files, 999 tests)
- `npx tsc --noEmit` — zero new type errors
- Exclusive mode throws `E_CONFIG_INVALID` when pi-permission-system is not detected
- Exclusive mode succeeds when pi-permission-system sentinel is present
- Exclusive mode blocks `vault.get("DATABASE_URL")` without capability
- Exclusive mode allows `vault.get("DATABASE_URL")` with valid non-expired capability
- Warn mode allows credential access but enforcer returns warning reason
- Managed mode returns `null` from `registerBoundary` — no behavioral change
- Permission system detector: 8 unit tests covering absent/malformed/valid sentinel states
