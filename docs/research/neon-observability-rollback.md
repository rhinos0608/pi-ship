# Research: Neon API — Observability (Logs) & Rollback (Branch Restore)

## Summary

Neon provides **no self-serve log/audit API**. `pg_stat_activity` is real-time query metadata, not a log stream. HIPAA audit logs exist but require a support ticket to access. The **Branch Restore API** (`POST /projects/{pid}/branches/{bid}/restore`) enables point-in-time rollback via timestamp or LSN. Restore is **destructive overwrite** — it replaces all data on the target branch. Automatic backup branches are created for rollback safety. The current Neon provider codebase has `RestoreBranchParams`/`restoreBranch` in `client.ts` but `planAction` throws unsupported for rollback intent.

## Findings

1. **No Neon Log/Audit API** — The Neon API reference lists no endpoints for retrieving query logs, audit events, or application-level logs. The only "operations" endpoint (`GET /projects/{pid}/operations`) tracks control-plane operations (create_branch, start_compute, etc.) — these are infrastructure events, not SQL query logs. [Neon API Reference — endpoint list](https://neon.com/docs/reference/api-reference) [Neon Operations docs](https://neon.com/docs/manage/operations)

2. **pg_stat_activity is NOT a log API** — `pg_stat_activity` is a Postgres system view showing current connection/query state at a point in time. It is ephemeral, not an append-only log. The existing `logsAction` in `ship-ops.ts` correctly rejects this: `"Neon logs not supported via ship handler; use Neon Console."` [Source](src/providers/neon/ship-ops.ts#L218-L226)

3. **HIPAA audit logs exist but require support ticket** — Neon maintains console/API audit logs and Postgres pgAudit logs for HIPAA projects, but states: "Self-serve access to HIPAA audit logs is currently not supported. Access to audit logs can be requested by raising a Support request." [Neon HIPAA docs](https://neon.com/docs/security/hipaa)

4. **OpenTelemetry log forwarding (not queryable via API)** — Neon's Scale plan can forward Postgres logs to external OTEL-compatible backends (Grafana, New Relic, Honeycomb) via Console configuration. These logs are pushed — not queryable via Neon API. [Neon OpenTelemetry docs](https://neon.com/docs/guides/opentelemetry)

5. **Branch Restore API shape** — `POST /projects/{project_id}/branches/{branch_id}/restore` with request body:
   - `source_branch_id` (required) — source branch for restore data
   - `source_timestamp` (optional) — ISO 8601 point-in-time on source branch
   - `source_lsn` (optional) — LSN on source branch
   - `preserve_under_name` (optional) — saves current state as new branch
   If both `source_timestamp` and `source_lsn` omitted, restores to source HEAD. If `source_branch_id` == target `branch_id`, one of timestamp/LSN is required. If branch has children or restoring from self, `preserve_under_name` is required. [Neon Restore API](https://api-docs.neon.tech/reference/restoreprojectbranch) [Neon Instant Restore docs](https://neon.com/docs/introduction/branch-restore)

6. **Restore is destructive overwrite** — "Everything on your current branch, data and schema, is replaced with the contents from the historical source." All databases on the branch are restored. Connections are briefly interrupted but connection string stays the same. [Neon Instant Restore docs](https://neon.com/docs/introduction/branch-restore)

7. **Automatic backup branch on restore** — Before restoring, Neon creates `{branch_name}_old_{head_timestamp}` as an automatic backup. Both restored branch and backup become root branches. Backup branches from cross-branch restores cannot be deleted. [Neon Instant Restore docs](https://neon.com/docs/introduction/branch-restore)

8. **Root branches only for PITR** — Point-in-time restore (with timestamp/LSN) is only supported on root branches. Child branches cannot be target or source for PITR. Restoring to HEAD from another branch works for any branch. [Neon Instant Restore docs](https://neon.com/docs/introduction/branch-restore)

9. **Restore-point capture via GET branch** — `GET /projects/{pid}/branches/{bid}` returns `parent_lsn` and `parent_timestamp` from which the branch was created. This can be called before running a migration to capture the current state identifier for rollback targeting. However, the branch's own HEAD LSN is not directly exposed — the `parent_lsn` is the LSN on the *parent* branch. For self-restore, a `source_timestamp` captured at migration start is the reliable mechanism. [Neon Get Branch API](https://api-docs.neon.tech/reference/getprojectbranch)

10. **Current codebase state** — `client.ts` defines `RestoreBranchParams`, `RestoreBranchResponse`, and `restoreBranch()` method. `ship-ops.ts:planAction` throws `E_PHASE_UNSUPPORTED` for rollback. `logsAction` returns unsupported message. `state.ts` tracks `history: Array<{planId, digest, status, at}>`. `journal.ts` has append-only per-step tracking with `planId`, `planDigest`, `step`, `status`. [client.ts](src/providers/neon/client.ts#L94-L115) [ship-ops.ts](src/providers/neon/ship-ops.ts#L99-L101) [state.ts](src/providers/neon/state.ts#L35-L43)

## Sources

### Kept
- **Neon API Reference — endpoint index** — authoritative list of all API endpoints; confirms no log/audit endpoint. (https://neon.com/docs/reference/api-reference)
- **Neon Restore Branch API** — exact request/response schemas and rules. (https://api-docs.neon.tech/reference/restoreprojectbranch)
- **Neon Instant Restore docs** — restore semantics, overwrite behavior, automatic backup, root-branch limitation. (https://neon.com/docs/introduction/branch-restore)
- **Neon HIPAA compliance** — confirms audit logs exist but only accessible via support ticket. (https://neon.com/docs/security/hipaa)
- **Neon OpenTelemetry docs** — confirms log forwarding is push-only (Console config), not API-queryable. (https://neon.com/docs/guides/opentelemetry)
- **Neon Metrics & Logs reference** — confirms `neon_connection_counts` from `pg_stat_activity` is a metric, not a log stream. (https://neon.com/docs/reference/metrics-logs)
- **Neon Operations docs** — system operations (create_branch, start_compute) are infrastructure events, not application logs. (https://neon.com/docs/manage/operations)
- **Neon Get Branch API** — confirms `parent_lsn` and `parent_timestamp` fields for restore-point capture. (https://api-docs.neon.tech/reference/getprojectbranch)
- **Source: client.ts** — confirms existing `RestoreBranchParams` and `restoreBranch` implementation. (src/providers/neon/client.ts)
- **Source: ship-ops.ts** — confirms `rollback` and `logs` throw unsupported. (src/providers/neon/ship-ops.ts)
- **Source: state.ts** — confirms `history` array for tracking applied plans. (src/providers/neon/state.ts)
- **Source: journal.ts** — confirms per-step append-only journal for migration tracking. (src/providers/neon/journal.ts)

### Dropped
- **Neon Branching guide** — good background but recoverable from other sources.
- **Neon PITR blog** — marketing overview, not API reference.
- **Neon CLI branches docs** — CLI syntax; API shape already captured from API docs.
- **Third-party copies (One/knowledge, API Tracker)** — not authoritative; original Neon docs used instead.

## Gaps

1. **No self-serve log API** — Cannot query Neon for SQL query history or application logs via any API. Gap is permanent for the Neon provider; logs must be retrieved from external OTEL backends or Neon Console.
2. **No branch HEAD LSN exposure** — `GET /branch` returns `parent_lsn` (from parent), not the branch's own current LSN. Timestamp capture at migration start is the practical restore-point mechanism.
3. **Rollback implementation not yet built** — `planAction` rejects rollback intent. The restore infra exists in `client.ts` but the orchestration (snapshot → migrate → rollback on failure) is absent.
4. **Consumption history API** — `GET /consumption_history/v2/branches` exists but provides billing metrics, not granular log data.
5. **Snapshot API** — `POST /projects/{pid}/branches/{bid}/snapshot` and `POST /projects/{pid}/snapshots/{sid}/restore` exist for explicit snapshot-based restore. Could supplement PITR but adds complexity.

## Supervisor coordination

None needed. Research complete — this brief documents the gap and the available API surfaces for future rollback implementation.

---

<!-- acceptance-report -->