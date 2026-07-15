# Provider Capability Matrix

> Research document for ADR 0008 — Post-MVP Provider Parity.
> Captures per-provider support across deployment, database, and operational features.

## Feature matrix

| Feature | Cloudflare Workers | Neon | Railway | Vercel |
|---|---|---|---|---|
| **Deploy** | ✓ Workers API | N/A (database provider) | ✓ | ✓ |
| **Rollback** | ✓ Version routing | ✓ Branch restore with restore-point capture | ✓ | ✓ |
| **Status** | ✓ | ✓ | ✓ | ✓ |
| **Logs** | Live tail only (Workers Tail API) — not historical | Use Neon Console — no API | ✓ | ✓ |
| **Preview environments** | ✓ Workers preview | ✓ Preview branches | ✓ Ephemeral environments (explicit `previewId` required) | ✓ |
| **Preview URLs** | Vendor-limited — not returned by API | N/A | ✓ | ✓ |
| **Source enumeration** | Vendor-limited — single-file only | N/A | ✓ (git-based) | ✓ |
| **DB inspect / browse / query** | N/A | Use Neon Console (vendor-limited — no management API; direct PostgreSQL access via `DATABASE_URL` supported) | ✓ (generic path via `DATABASE_URL`) | ✓ (generic path via `DATABASE_URL`) |
| **Postgres provisioning** | N/A | ✓ | ✓ (`templateDeployV2`) | N/A |
| **Migration plans** | N/A | ✓ | ✓ | N/A |
| **Secrets / env vars** | ✓ | ✓ | ✓ | ✓ |

## Vendor limitations

### Cloudflare Workers
- **Logs:** Tail API provides live-only streaming. No historical log replay. Limited to 10 concurrent tail sessions per worker. Worker-scoped (not deployment-scoped). Headers/URLs redacted by default.
- **Preview URLs:** The Workers API does not return preview URLs. Users must retrieve them from the Cloudflare Dashboard.
- **Source enumeration:** The Workers API supports single-file upload only. No automatic multi-file enumeration — source must be explicitly specified.

### Neon
- **Logs:** No self-serve log or audit endpoint exists. `pg_stat_activity` provides session metadata only (not an append-only log stream). HIPAA audit logs require a support ticket. OpenTelemetry is push-only (Console configuration, not API-queryable).
- **DB inspection:** No programmatic schema/table inspection API. Use Neon Console.
- **Rollback:** Only root branches support PITR with timestamp/LSN. No arbitrary timestamp or cross-branch restore from tool input. Destructive — replaces all data on target branch.

### Railway
- **Preview environments:** No auto-discovery of preview environments. Explicit `previewId` required for all preview operations. Cleanup is manual (operator-managed, no auto-cleanup).

### Vercel
- No significant vendor limitations beyond standard API rate limits.

## Capability status key

| Status | Meaning |
|---|---|
| ✓ | Fully supported |
| Detailed entry | Supported with noted constraints |
| N/A | Not applicable (provider scope mismatch) |
