import { access } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defendToolResult } from "../../defense/spotlight.js";
import { Value } from "typebox/value";
import { ApprovalRegistry, requestPlanApproval } from "../../core/approval.js";
import { canonicalize } from "../../core/canonicalize.js";
import { resolveDatabaseEnvironment } from "../../database/environment.js";
import { assertPublicPlan, classifySQL } from "../../database/classifier.js";
import { buildDatabasePlan, fingerprintTarget, persistDatabasePlan } from "../../database/plan.js";
import { DatabasePayloadRegistry } from "../../database/payload.js";
import { err, isShipError } from "../../core/errors.js";
import type { CredentialSource } from "../../deployment/credentials.js";
import { providerRegistry } from "../../providers/registry.js";
import { readPlanFile } from "../../persistence/plan-store.js";
import { DBSchema, type DBInput } from "./schema.js";
import type { DatabaseHandlerContext } from "./contracts.js";
import type { DatabaseClient, DatabaseClientFactory } from "../../database/client.js";
import { createDefaultClientFactory } from "../../database/client.js";
import { executeReadQuery } from "../../database/read.js";
import { executeBrowse } from "../../database/browse.js";
import { inspectDatabase } from "../../database/inspect.js";
import { applyDatabasePlan } from "../../database/apply.js";
import { applyDialectPlan, type DialectMutationExecutor, type DialectError } from "../../database/dialect/apply.js";
import { readDatabaseJournal } from "../../database/journal.js";
import { resolveDatabaseTarget } from "../../database/target.js";
import { createPGliteClient } from "../../database/local/pglite-client.js";
import { executeLocalQuery } from "../../database/execute-local.js";
import { importData, sqliteImportDialect } from "../../database/import.js";
import { resetLocalDatabase } from "../../database/reset.js";
import { sqliteAdapter } from "../../database/dialect/sqlite/index.js";
import { mysqlAdapter } from "../../database/dialect/mysql/index.js";
import type { DialectApplyInput } from "../../database/dialect/contracts.js";
import type { TSchema } from "typebox";
import type { ProviderRuntimeBinding } from "../../providers/capability-profile.js";
export type { DBFilter, DBInput, DBOrder, DBValue } from "./schema.js";
export { DBFilterSchema, DBOrderSchema, DBSchema, DBValueSchema } from "./schema.js";

const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : canonicalize(value)).digest("hex");

function containsNonFiniteNumber(value: unknown): boolean { if (typeof value === "number") return !Number.isFinite(value); if (Array.isArray(value)) return value.some(containsNonFiniteNumber); if (value && typeof value === "object") return Object.values(value).some(containsNonFiniteNumber); return false; }

async function contextFingerprints(cwd: string, binding?: ProviderRuntimeBinding): Promise<{ providerFingerprint: string; manifestFingerprint: string }> {
  if (binding) {
    if (binding.manifest === undefined) {
      return { providerFingerprint: hash("none::provider"), manifestFingerprint: hash("none::manifest") };
    }
    return {
      providerFingerprint: hash(binding.package!.id),
      manifestFingerprint: hash(binding.manifest),
    };
  }
  try { await access(join(cwd, "pi-ship.json")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; return { providerFingerprint: hash("none::provider"), manifestFingerprint: hash("none::manifest") }; } const { manifest, packageId } = await providerRegistry.loadManifest(cwd); return { providerFingerprint: hash(packageId), manifestFingerprint: hash(manifest) }; }

const pgliteExecutor: DialectMutationExecutor = {
  paramBinding: 'positional-prefix',
  classifyError(cause: unknown): DialectError {
    if (isShipError(cause)) {
      const e = cause as { code: string; retryable: boolean };
      if (e.code === "E_CANCELLED") {
        return { code: e.code, shipCode: "E_CANCELLED", retryable: true, definitive: true };
      }
      return { code: e.code, shipCode: e.code, retryable: e.retryable, definitive: false };
    }
    if (cause instanceof Error && typeof (cause as unknown as Record<string, unknown>).code === "string") {
      const raw = (cause as unknown as Record<string, unknown>).code as string;
      const upper = raw.toUpperCase();
      if (upper === "ERR_ABORTED") {
        return { code: raw, shipCode: "E_CANCELLED", retryable: false, definitive: true };
      }
      if (/^[0-9A-Z]{5}$/.test(upper)) {
        return { code: raw, shipCode: "E_PROVIDER", retryable: false, definitive: true };
      }
      return { code: raw, shipCode: "E_PROVIDER", retryable: false, definitive: false };
    }
    return { code: "E_PROVIDER", shipCode: "E_PROVIDER", retryable: false, definitive: false };
  },
  async begin(client: DatabaseClient): Promise<void> {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL statement_timeout = '30000ms'");
      await client.query("SET LOCAL lock_timeout = '5000ms'");
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* best-effort */ }
      throw e;
    }
  },
  async execute(client: DatabaseClient, sql: string, params: readonly unknown[]): Promise<import("../../database/client.js").DatabaseQueryResult> {
    return client.query(sql, params);
  },
  async commit(client: DatabaseClient): Promise<void> {
    await client.query("COMMIT");
  },
  async rollback(client: DatabaseClient): Promise<boolean> {
    try { await client.query("ROLLBACK"); return true; }
    catch { return false; }
  },
};

export interface DatabaseRegistration { cleanup(): void; payloads: DatabasePayloadRegistry; }

export function registerDB(
  pi: ExtensionAPI,
  registry: ApprovalRegistry,
  deps: {
    credentialSource?: CredentialSource;
    payloads?: DatabasePayloadRegistry;
    clientFactory?: DatabaseClientFactory;
    binding?: ProviderRuntimeBinding;
    parameters?: TSchema;
  } = {},
): DatabaseRegistration {
  const payloads = deps.payloads ?? new DatabasePayloadRegistry();
  const clientFactory = deps.clientFactory ?? createDefaultClientFactory();
  const effectiveSchema = deps.parameters ?? DBSchema;

  pi.registerTool({
    name: "DB",
    label: "Database Operations",
    description: "Inspect, query, plan, and apply database operations",
    parameters: effectiveSchema,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      // ── Drift guard (first dispatch statement) ───────────────────────
      if (deps.binding) {
        await deps.binding.assertIntact(ctx.cwd);
      }

      if (!Value.Check(effectiveSchema, rawParams) || containsNonFiniteNumber(rawParams)) {
        throw err("E_CONFIG_INVALID", "DB parameters invalid");
      }
      const params = rawParams as DBInput;
      const cwd = ctx.cwd;
      const credentialSource = deps.credentialSource ?? (await import("../../deployment/credentials.js")).environmentSource();

      // ── Resolve target and environment ──────────────────────────────
      const target = resolveDatabaseTarget(credentialSource, cwd);
      const environment = resolveDatabaseEnvironment(credentialSource, target.kind);
      const isLocal = target.kind === "local";

      const isMySQL = target.kind === "remote" && target.dialect === "mysql";
      const isSQLite = target.kind === "file";
      const gatedLocal = isLocal && credentialSource.get("PI_SHIP_LOCAL_DB_GATED") === "true";
      const sqliteOpen =
        isSQLite && credentialSource.get("PI_SHIP_SQLITE_OPEN") === "true";

      // ── import action (PGlite or SQLite only) ──────────────────────
      if (params.action === "import") {
        if (isLocal) {
          if (gatedLocal) throw err("E_APPROVAL_REQUIRED", "local database writes require plan approval; use plan + apply_plan");
          const client = await createPGliteClient(target.dataDir);
          try {
            const result = await importData(client, {
              table: params.table,
              format: params.format,
              path: params.path,
              rows: params.rows as Record<string, unknown>[] | undefined,
              mode: params.mode,
            }, signal);
            const label = "local embedded database";
            return defendToolResult({
              content: [{ type: "text", text: `[${label}] Imported ${result.rowsImported} rows into ${result.table}${result.created ? " (table created)" : ""}` }],
              details: { table: result.table, rowsImported: result.rowsImported, created: result.created, target: label },
            });
          } finally {
            try { await client.end(); } catch { /* best-effort */ }
          }
        }
        if (isSQLite) {
          if (!sqliteOpen) throw err("E_APPROVAL_REQUIRED", "SQLite database writes require PI_SHIP_SQLITE_OPEN=true");
          const client = await sqliteAdapter.connect(target, "write");
          try {
            const result = await importData(client, {
              table: params.table,
              format: params.format,
              path: params.path,
              rows: params.rows as Record<string, unknown>[] | undefined,
              mode: params.mode,
            }, signal, sqliteImportDialect);
            const label = "local SQLite database";
            return defendToolResult({
              content: [{ type: "text", text: `[${label}] Imported ${result.rowsImported} rows into ${result.table}${result.created ? " (table created)" : ""}` }],
              details: { table: result.table, rowsImported: result.rowsImported, created: result.created, target: label },
            });
          } finally {
            try { await client.end(); } catch { /* best-effort */ }
          }
        }
        throw err("E_PHASE_UNSUPPORTED", "import action requires local database target");
      }

      // ── reset action (local only) ───────────────────────────────────
      if (params.action === "reset") {
        if (!isLocal) throw err("E_PHASE_UNSUPPORTED", "reset action requires local database target");
        if (gatedLocal) throw err("E_APPROVAL_REQUIRED", "local database reset blocked by PI_SHIP_LOCAL_DB_GATED");
        await resetLocalDatabase(target.dataDir);
        return {
          content: [{ type: "text", text: "Local database reset complete. Empty database ready." }],
          details: { target: "local embedded database", status: "reset" },
        };
      }

      // ── inspect (shared read) ──────────────────────────────────────
      if (params.action === "inspect") {
        if (isLocal) {
          const client = await createPGliteClient(target.dataDir);
          const factory: DatabaseClientFactory = () => client;
          try {
            const result = await inspectDatabase("pglite://local", factory, signal);
            return defendToolResult({
              content: [{ type: "text", text: `[local embedded database] Inspected ${result.schemas.length} schemas, ${result.relations.length} relations` }],
              details: result as unknown as Record<string, unknown>,
            });
          } finally {
            try { await client.end(); } catch { /* best-effort */ }
          }
        }
        if (isMySQL) {
          const result = await mysqlAdapter.inspect(target, signal);
          return defendToolResult({
            content: [{ type: "text", text: `[remote MySQL database] Inspected ${result.schemas.length} schemas, ${result.relations.length} relations` }],
            details: result as unknown as Record<string, unknown>,
          });
        }
        if (isSQLite) {
          const result = await sqliteAdapter.inspect(target, signal);
          return defendToolResult({
            content: [{ type: "text", text: `[local SQLite database] Inspected ${result.schemas.length} schemas, ${result.relations.length} relations` }],
            details: result as unknown as Record<string, unknown>,
          });
        }
        // Remote PostgreSQL: existing behavior
        if (target.kind !== "remote") throw err("E_PHASE_UNSUPPORTED", "inspect requires remote database target");
        const inspectUrl = target.url;
        const inspectResult = await inspectDatabase(inspectUrl, clientFactory, signal);
        return defendToolResult({
          content: [{ type: "text", text: `Inspected ${inspectResult.schemas.length} schemas, ${inspectResult.relations.length} relations` }],
          details: inspectResult as unknown as Record<string, unknown>,
        });
      }

      // ── browse (shared read) ──────────────────────────────────────
      if (params.action === "browse") {
        if (isLocal) {
          const client = await createPGliteClient(target.dataDir);
          const factory: DatabaseClientFactory = () => client;
          try {
            const result = await executeBrowse("pglite://local", factory, {
              schema: params.schema,
              table: params.table,
              columns: params.columns,
              filters: params.filters,
              orderBy: params.orderBy,
              limit: params.limit ?? 100,
              offset: params.offset ?? 0,
            }, signal);
            return defendToolResult({
              content: [{ type: "text", text: `[local embedded database] Browsed ${result.rowCount} rows from ${result.schema}.${result.table}${result.hasMore ? " (truncated)" : ""}` }],
              details: { columns: result.columns, rows: result.rows, rowCount: result.rowCount, hasMore: result.hasMore, schema: result.schema, table: result.table, target: "local embedded database" },
            });
          } finally {
            try { await client.end(); } catch { /* best-effort */ }
          }
        }
        if (isMySQL) {
          const browseInput = {
            schema: params.schema,
            table: params.table,
            columns: params.columns,
            filters: params.filters,
            orderBy: params.orderBy,
            limit: params.limit ?? 100,
            offset: params.offset ?? 0,
          };
          const result = await mysqlAdapter.browse(target, browseInput, signal);
          return defendToolResult({
            content: [{ type: "text", text: `[remote MySQL database] Browsed ${result.rowCount} rows from ${result.schema}.${result.table}${result.hasMore ? " (truncated)" : ""}` }],
            details: { columns: result.columns, rows: result.rows, rowCount: result.rowCount, hasMore: result.hasMore, schema: result.schema, table: result.table, target: "remote MySQL database" },
          });
        }
        if (isSQLite) {
          const browseInput = {
            schema: params.schema,
            table: params.table,
            columns: params.columns,
            filters: params.filters,
            orderBy: params.orderBy,
            limit: params.limit ?? 100,
            offset: params.offset ?? 0,
          };
          const result = await sqliteAdapter.browse(target, browseInput, signal);
          return defendToolResult({
            content: [{ type: "text", text: `[local SQLite database] Browsed ${result.rowCount} rows from ${result.schema}.${result.table}${result.hasMore ? " (truncated)" : ""}` }],
            details: { columns: result.columns, rows: result.rows, rowCount: result.rowCount, hasMore: result.hasMore, schema: result.schema, table: result.table, target: "local SQLite database" },
          });
        }
        // Remote PostgreSQL: existing behavior
        if (target.kind !== "remote") throw err("E_PHASE_UNSUPPORTED", "browse requires remote database target");
        const browseUrl = target.url;
        const browseResult = await executeBrowse(browseUrl, clientFactory, {
          schema: params.schema,
          table: params.table,
          columns: params.columns,
          filters: params.filters,
          orderBy: params.orderBy,
          limit: params.limit ?? 100,
          offset: params.offset ?? 0,
        }, signal);
        return defendToolResult({
          content: [{ type: "text", text: `Browsed ${browseResult.rowCount} rows from ${browseResult.schema}.${browseResult.table}${browseResult.hasMore ? " (truncated)" : ""}` }],
          details: { columns: browseResult.columns, rows: browseResult.rows, rowCount: browseResult.rowCount, hasMore: browseResult.hasMore, schema: browseResult.schema, table: browseResult.table },
        });
      }

      // ── query on local + open (writes allowed) — PGlite ──────────────
      if (params.action === "query" && isLocal && !gatedLocal) {
        const client = await createPGliteClient(target.dataDir);
        try {
          const result = await executeLocalQuery(client, params.sql, params.params ?? [], signal);
          const label = "local embedded database";
          if (result.kind === "read") {
            return defendToolResult({
              content: [{ type: "text", text: `[${label}] Query returned ${result.rowCount} rows${result.hasMore ? " (truncated)" : ""}` }],
              details: { columns: result.columns, rows: result.rows, rowCount: result.rowCount, hasMore: result.hasMore, target: label },
            });
          }
          return defendToolResult({
            content: [{ type: "text", text: `[${label}] Mutation: ${result.statementCount} statements, ${result.rowCount} rows affected` }],
            details: { kind: "mutation", rowCount: result.rowCount, statementCount: result.statementCount, target: label },
          });
        } finally {
          try { await client.end(); } catch { /* best-effort */ }
        }
      }

      // ── query on SQLite + open flag (writes allowed) ────────────────
      if (params.action === "query" && isSQLite && sqliteOpen) {
        const client = await sqliteAdapter.connect(target, "write");
        try {
          const classification = await sqliteAdapter.classify(params.sql, params.params ?? []);
          const label = "local SQLite database";
          if (classification.riskLevel === "read") {
            const result = await sqliteAdapter.read(target, { sql: params.sql, params: params.params ?? [], limit: params.limit, signal });
            return defendToolResult({
              content: [{ type: "text", text: `[${label}] Query returned ${result.rowCount} rows${result.hasMore ? " (truncated)" : ""}` }],
              details: { columns: result.columns, rows: result.rows, rowCount: result.rowCount, hasMore: result.hasMore, target: label },
            });
          }
          let totalAffected = 0;
          let paramOffset = 0;
          for (const stmt of classification.statements) {
            const stmtParams = (params.params ?? []).slice(paramOffset, paramOffset + stmt.paramCount);
            const result = await client.query(stmt.sql, stmtParams);
            if (result.rowCount !== null) totalAffected += result.rowCount;
            paramOffset += stmt.paramCount;
          }
          return defendToolResult({
            content: [{ type: "text", text: `[${label}] Mutation: ${classification.statements.length} statements, ${totalAffected} rows affected` }],
            details: { kind: "mutation", statementCount: classification.statements.length, rowCount: totalAffected, target: label },
          });
        } finally {
          try { await client.end(); } catch { /* best-effort */ }
        }
      }

      // ── Shared read-only query (remote or local+gated or sqlite+gated) ──
      if (params.action === "query") {
        if (isLocal) {
          const client = await createPGliteClient(target.dataDir);
          const factory: DatabaseClientFactory = () => client;
          const values = params.params ?? [];
          const result = await executeReadQuery("pglite://local", factory, {
            sql: params.sql,
            params: values,
            limit: params.limit,
            signal,
          });
          return defendToolResult({
            content: [{ type: "text", text: `[local embedded database] Query returned ${result.rowCount} rows${result.hasMore ? " (truncated)" : ""}` }],
            details: { columns: result.columns, rows: result.rows, rowCount: result.rowCount, hasMore: result.hasMore, target: "local embedded database" },
          });
        }
        if (isMySQL) {
          await mysqlAdapter.assertPublicQuery(params.sql, params.params ?? []);
          const result = await mysqlAdapter.read(target, { sql: params.sql, params: params.params ?? [], limit: params.limit, signal });
          return defendToolResult({
            content: [{ type: "text", text: `[remote MySQL database] Query returned ${result.rowCount} rows${result.hasMore ? " (truncated)" : ""}` }],
            details: { columns: result.columns, rows: result.rows, rowCount: result.rowCount, hasMore: result.hasMore, target: "remote MySQL database" },
          });
        }
        if (isSQLite) {
          await sqliteAdapter.assertPublicQuery(params.sql, params.params ?? []);
          const result = await sqliteAdapter.read(target, { sql: params.sql, params: params.params ?? [], limit: params.limit, signal });
          return defendToolResult({
            content: [{ type: "text", text: `[local SQLite database] Query returned ${result.rowCount} rows${result.hasMore ? " (truncated)" : ""}` }],
            details: { columns: result.columns, rows: result.rows, rowCount: result.rowCount, hasMore: result.hasMore, target: "local SQLite database" },
          });
        }
        // Remote PostgreSQL: existing behavior
        if (target.kind !== "remote") throw err("E_PHASE_UNSUPPORTED", "query requires remote database target");
        const queryUrl = target.url;
        const queryValues = params.params ?? [];
        const queryResult = await executeReadQuery(queryUrl, clientFactory, {
          sql: params.sql,
          params: queryValues,
          limit: params.limit,
          signal,
        });
        return defendToolResult({
          content: [{ type: "text", text: `Query returned ${queryResult.rowCount} rows${queryResult.hasMore ? " (truncated)" : ""}` }],
          details: { columns: queryResult.columns, rows: queryResult.rows, rowCount: queryResult.rowCount, hasMore: queryResult.hasMore },
        });
      }

      // ── Plan action (shared, persisted, no client) ──────────────────
      if (params.action === "plan") {
        const values = params.params ?? [];
        const fingerprints = await contextFingerprints(cwd, deps.binding);

        let classification;
        let targetFingerprint: string;
        let label: string;

        if (isMySQL) {
          classification = await mysqlAdapter.assertPublicPlan(params.sql, values);
          targetFingerprint = mysqlAdapter.fingerprint(target);
          label = "remote MySQL database";
        } else if (isSQLite) {
          classification = await sqliteAdapter.assertPublicPlan(params.sql, values);
          targetFingerprint = sqliteAdapter.fingerprint(target);
          label = "local SQLite database";
        } else {
          // PGlite or PostgreSQL — use existing PG classifier
          classification = await assertPublicPlan(params.sql, values);
          targetFingerprint = fingerprintTarget(target);
          label = isLocal ? "local embedded database" : "remote PostgreSQL database";
        }

        const plan = buildDatabasePlan({ environment, targetFingerprint, ...fingerprints, sql: params.sql, params: values, classification });
        await persistDatabasePlan(cwd, plan);
        payloads.register(plan.planId, plan.planDigest, { sql: params.sql, params: [...values], statements: classification.statements });
        const destructive = plan.riskLevel === "destructive";
        let approved = false;
        if (!isLocal || gatedLocal || isSQLite) {
          // Remote, gated local, or SQLite (gated by default) — require approval
          const approval = await requestPlanApproval(ctx, {
            planId: plan.planId, planDigest: plan.planDigest,
            metadata: { domain: "database", risk: destructive ? "destructive" : "write" },
            title: destructive ? "High-risk destructive database plan" : "Approve database plan",
            summary: destructive
              ? `Destructive statements: ${plan.destructiveReasons.join(", ")}`
              : `Statements: ${plan.statements.map((s) => `${s.tag} ${s.tables.join(",")}`).join("; ")}`,
          }, registry);
          approved = approval.approved;
        } else {
          // Local+open PGlite — auto-approve
          registry.approve(plan.planId, plan.planDigest, cwd, { domain: "database", risk: destructive ? "destructive" : "write" });
          approved = true;
        }
        return { content: [{ type: "text", text: `[${label}] Database plan ${plan.planId}: ${plan.riskLevel}` }], details: { planId: plan.planId, planDigest: plan.planDigest, riskLevel: plan.riskLevel, statements: plan.statements, destructiveReasons: plan.destructiveReasons, approved, target: label } };
      }

      // ── Shared apply_plan (db-plan/1 kind, no manifest/provider) ─────
      if (params.action === "apply_plan") {
        const rawPlan = await readPlanFile(cwd, params.planId);
        if (rawPlan && typeof rawPlan === "object" && (rawPlan as Record<string, unknown>).kind === "db-plan/1") {
          const fingerprints = await contextFingerprints(cwd, deps.binding);
          const applyEnvironment = resolveDatabaseEnvironment(credentialSource, target.kind);
          const productionFlag = credentialSource.get("PI_SHIP_ALLOW_PRODUCTION_DB_WRITES");

          if (isMySQL) {
            const input: DialectApplyInput = {
              cwd, planId: params.planId, planDigest: params.planDigest,
              environment: applyEnvironment,
              providerFingerprint: fingerprints.providerFingerprint,
              manifestFingerprint: fingerprints.manifestFingerprint,
              productionFlag, registry, payloads, signal,
            };
            const result = await mysqlAdapter.executeApproved(target, input);
            return defendToolResult({
              content: [{ type: "text", text: `[remote MySQL database] Database plan ${result.planId} committed (${result.statementCount} statements, ${result.affectedRows} rows)` }],
              details: { planId: result.planId, planDigest: result.planDigest, status: result.status, statementCount: result.statementCount, affectedRows: result.affectedRows },
            });
          }

          if (isSQLite) {
            // SQLite gated (default) — use executeApproved which goes through full lifecycle
            const input: DialectApplyInput = {
              cwd, planId: params.planId, planDigest: params.planDigest,
              environment: applyEnvironment,
              providerFingerprint: fingerprints.providerFingerprint,
              manifestFingerprint: fingerprints.manifestFingerprint,
              productionFlag, registry, payloads, signal,
            };
            const result = await sqliteAdapter.executeApproved(target, input);
            return defendToolResult({
              content: [{ type: "text", text: `[local SQLite database] Database plan ${result.planId} committed (${result.statementCount} statements, ${result.affectedRows} rows)` }],
              details: { planId: result.planId, planDigest: result.planDigest, status: result.status, statementCount: result.statementCount, affectedRows: result.affectedRows },
            });
          }

          if (isLocal) {
            // PGlite (gated or un-gated) — use applyDialectPlan with PGlite executor
            const input: DialectApplyInput = {
              cwd, planId: params.planId, planDigest: params.planDigest,
              environment: applyEnvironment,
              providerFingerprint: fingerprints.providerFingerprint,
              manifestFingerprint: fingerprints.manifestFingerprint,
              productionFlag, registry, payloads, signal,
            };
            const targetFingerprint = fingerprintTarget(target);
            const result = await applyDialectPlan(
              input,
              targetFingerprint,
              classifySQL,
              pgliteExecutor,
              async () => createPGliteClient(target.dataDir),
            );
            return defendToolResult({
              content: [{ type: "text", text: `[local embedded database] Database plan ${result.planId} committed (${result.statementCount} statements, ${result.affectedRows} rows)` }],
              details: { planId: result.planId, planDigest: result.planDigest, status: result.status, statementCount: result.statementCount, affectedRows: result.affectedRows },
            });
          }

          // PostgreSQL remote (existing path)
          const databaseUrl = credentialSource.get("DATABASE_URL");
          if (!databaseUrl) throw err("E_AUTH_MISSING", "DATABASE_URL required for database plan apply");
          const result = await applyDatabasePlan({
            cwd,
            planId: params.planId,
            planDigest: params.planDigest,
            environment: applyEnvironment,
            databaseUrl,
            providerFingerprint: fingerprints.providerFingerprint,
            manifestFingerprint: fingerprints.manifestFingerprint,
            productionFlag,
            registry,
            payloads,
            clientFactory,
            signal,
          });
          return defendToolResult({
            content: [{ type: "text", text: `Database plan ${result.planId} committed (${result.statementCount} statements, ${result.affectedRows} rows)` }],
            details: { planId: result.planId, planDigest: result.planDigest, status: result.status, statementCount: result.statementCount, affectedRows: result.affectedRows },
          });
        }
        // Non-db-plan/1: fall through to provider handler
      }

      // ── Shared migration_status (reads generic journal) ──────────────
      if (params.action === "migration_status") {
        const allEntries = await readDatabaseJournal(cwd);
        const MAX_DISPLAY = 100;
        const entries = allEntries.slice(-MAX_DISPLAY);
        if (entries.length === 0) {
          return {
            content: [{ type: "text", text: "No database migration entries found in journal." }],
            details: { count: 0, entries: [] },
          };
        }
        const total = allEntries.length;
        const prefix = total > entries.length ? `Showing ${entries.length} of ${total} migration entries:` : `Found ${entries.length} migration entr${entries.length === 1 ? "y" : "ies"}:`;
        const lines: string[] = [prefix];
        for (const entry of entries) {
          const kind = entry.planKind ?? "db-plan/1";
          const errInfo = entry.errorCode ? ` (error: ${entry.errorCode})` : "";
          const planLabel = entry.planId.slice(0, 12);
          lines.push(`  [${kind}] ${planLabel}  ${entry.status}  at ${entry.at}${errInfo}`);
        }
        return defendToolResult({
          content: [{ type: "text", text: lines.join("\n") }],
          details: { count: entries.length, entries: entries.map((e) => ({ planId: e.planId, planDigest: e.planDigest, status: e.status, at: e.at, errorCode: e.errorCode, planKind: e.planKind })) },
        });
      }

      // ── Provider-dispatched actions ─────────────────────────────────
      let manifest: unknown;
      let packageId: string;
      if (deps.binding && deps.binding.manifest !== undefined) {
        manifest = deps.binding.manifest;
        packageId = deps.binding.package!.id;
      } else {
        const loaded = await providerRegistry.loadManifest(cwd);
        manifest = loaded.manifest;
        packageId = loaded.packageId;
      }
      const handlerContext: DatabaseHandlerContext = {
        manifest, cwd, pi, ctx, registry, credentialSource, environment, signal,
        services: providerRegistry.services(cwd),
      };
      const handler = providerRegistry.getDatabaseOpsHandler(manifest);
      if (!handler) throw err("E_PHASE_UNSUPPORTED", `DB not supported for ${packageId} provider`);
      return handler(params, handlerContext);
    },
  });

  return { payloads, cleanup: () => payloads.clear() };
}
