# ADR 0008: Deployment Resource Boundary

## Status

Accepted

## Context

The boundary system described in ADR 0007 originally protected only database credentials (`DATABASE_URL`) via `ProtectedResourceDescriptor`. As pi-ship expanded to support multiple deployment providers (Vercel, Railway, Cloudflare) and the Neon control plane, additional credential types needed the same protection.

Each provider holds API tokens that grant access to production infrastructure:

| Provider | Credentials | Risk if leaked |
|----------|------------|----------------|
| Vercel | `VERCEL_TOKEN` | Deploy, rollback, modify projects and environment variables |
| Railway | `RAILWAY_API_TOKEN`, `RAILWAY_TOKEN` | Deploy, modify services, access variables |
| Cloudflare | `CLOUDFLARE_API_TOKEN` | Upload workers, modify DNS, access account |
| Neon | `NEON_API_KEY` | Create/drop databases, branches, read connection strings |

These credentials are currently ambient in `process.env` — any tool call (bash, MCP, or extension) can read them. In `exclusive` mode, this is an unacceptable leak surface.

`CLOUDFLARE_ACCOUNT_ID` is intentionally excluded from protection — it is a public identifier, not a secret.

## Decision

### Per-provider resource descriptors

Each deployment provider gets a dedicated `ProtectedResourceDescriptor` in `src/boundary/resource.ts`:

- `createVercelResource()` — type `deployment`, protects `VERCEL_TOKEN`
- `createRailwayResource()` — type `deployment`, protects `RAILWAY_API_TOKEN`, `RAILWAY_TOKEN`
- `createCloudflareResource()` — type `deployment`, protects `CLOUDFLARE_API_TOKEN`
- `createNeonControlPlaneResource()` — type `database`, protects `NEON_API_KEY`

Neon control plane uses `type: "database"` because its operations (provision, migrate, branch) are database infrastructure actions, not application deployment.

### Resource type drives approval domain

`validateCapability` accepts a `resourceType` parameter of type `ResourceType = "database" | "deployment"`. This parameter is passed to `registry.isApproved()` as `ApprovalMetadata.domain`:

- `{ domain: "database", risk }` for database resources
- `{ domain: "deployment", risk }` for deployment resources

This ensures that a capability minted for a database operation cannot authorize a deployment action and vice versa.

### Provider approval metadata

All provider `requestPlanApproval()` calls now pass `{ domain, risk }` metadata:

| Provider | Domain | Risk |
|----------|--------|------|
| Vercel (approval.ts) | `deployment` | `destructive` |
| Railway (approval.ts) | `deployment` | `destructive` |
| Cloudflare (ship-ops.ts) | `deployment` | `destructive` |
| Neon (ship-ops.ts) | `database` | `destructive` |
| Neon (db-ops.ts) | `database` | `destructive` |
| DB tool (index.ts) | `database` | `write` or `destructive` |

The `isApproved()` check enforces both domain and risk matching.

### Ship tool wiring

- `CredentialVault.runTrusted(fn)` is used for non-mutating ship actions (validate, plan, status, logs) that need credential access only for safe reads.
- Mutating ship actions (apply_plan, rollback) use an approved-plan capability via `runWithCapability()`. A `runApprovedOperation` helper in `src/tools/ship/index.ts` encapsulates this pattern for all four providers.

### Bootstrap registration

At startup, `registerBoundary` in `src/boundary/integration/register.ts` pre-registers the database resource plus all four provider resources into the `ProtectedResourceRegistry`. This ensures `CredentialVault` and `BoundaryEnforcer` recognise all protected credential names without additional configuration.

## Consequences

### Positive

- All provider tokens are now gated by the same credential vault in exclusive mode — no special casing per provider
- Resource type parameterisation prevents cross-domain capability reuse (database plan cannot authorise a deployment)
- Approval metadata domain/risk binding provides fine-grained authorisation at the registry level
- `CLOUDFLARE_ACCOUNT_ID` exclusion avoids false-positive credential matches for non-secret identifiers
- Existing managed/warn mode behaviour unchanged — zero impact on users not using exclusive mode

### Negative

- New providers must add both a resource descriptor and a provider→resource mapping in `registerBoundary`
- Capability TTL (5-minute default) bounds apply execution time — very long applies may need capability refresh
- `runApprovedOperation` helper is implemented in `src/tools/ship/index.ts`, used by all four providers.
- Tool-call hook wired via `pi.on("tool_call", ...)` in `registerBoundary` — DB and ship events bypass the enforcer, other tools are checked for credential references.

### Security

- Deployment provider tokens are no longer ambient to shell commands in exclusive mode
- Domain separation prevents database capabilities from authorising deployment actions
- All protected credentials follow the same redaction path (`redact.ts`) as `DATABASE_URL`

### Migration

- No migration needed — resource descriptors are additive; existing configuration unchanged
- Provider approval metadata is backwards-compatible: `isApproved` without metadata returns `true` for existing records that predate domain/risk tracking

## Alternatives considered

### Single resource descriptor for all deployments

Rejected. Different providers protect different credential names and may have different hostnames/ports. Per-provider descriptors are more maintainable and allow executor-level granularity (e.g., restricting `NEON_API_KEY` to `ship` only).

### Treat `CLOUDFLARE_ACCOUNT_ID` as protected

Rejected. Account IDs are public identifiers, not secrets. Protecting them would cause false-positive matches in tool-call inspection without meaningful security benefit.

### Hardcode credential lists in the enforcer

Rejected. The registry-based approach means new providers self-declare their protected credentials without modifying enforcement logic.

## Related

- [ADR 0007: Database Access Boundary](./0007-database-access-boundary.md) — foundational credential isolation design
