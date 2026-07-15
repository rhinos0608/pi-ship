import { access } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { ApprovalRegistry, requestPlanApproval } from "../../core/approval.js";
import { canonicalize } from "../../core/canonicalize.js";
import { resolveDatabaseEnvironment } from "../../database/environment.js";
import { assertPublicPlan } from "../../database/classifier.js";
import { buildDatabasePlan, fingerprintTarget, persistDatabasePlan } from "../../database/plan.js";
import { DatabasePayloadRegistry } from "../../database/payload.js";
import { err } from "../../core/errors.js";
import type { CredentialSource } from "../../deployment/credentials.js";
import { providerRegistry } from "../../providers/registry.js";
import { readPlanFile } from "../../persistence/plan-store.js";
import { DBSchema, type DBInput } from "./schema.js";
import type { DatabaseHandlerContext } from "./contracts.js";
import type { DatabaseClientFactory } from "../../database/client.js";
import { createDefaultClientFactory } from "../../database/client.js";
import { executeReadQuery } from "../../database/read.js";
import { executeBrowse } from "../../database/browse.js";
import { inspectDatabase } from "../../database/inspect.js";
import { applyDatabasePlan } from "../../database/apply.js";
export type { DBFilter, DBInput, DBOrder, DBValue } from "./schema.js";
export { DBFilterSchema, DBOrderSchema, DBSchema, DBValueSchema } from "./schema.js";

const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : canonicalize(value)).digest("hex");

function containsNonFiniteNumber(value: unknown): boolean { if (typeof value === "number") return !Number.isFinite(value); if (Array.isArray(value)) return value.some(containsNonFiniteNumber); if (value && typeof value === "object") return Object.values(value).some(containsNonFiniteNumber); return false; }

async function contextFingerprints(cwd: string): Promise<{ providerFingerprint: string; manifestFingerprint: string }> { try { await access(join(cwd, "pi-ship.json")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; return { providerFingerprint: hash("none::provider"), manifestFingerprint: hash("none::manifest") }; } const { manifest, packageId } = await providerRegistry.loadManifest(cwd); return { providerFingerprint: hash(packageId), manifestFingerprint: hash(manifest) }; }

/**
 * Require DATABASE_URL for shared read operations.
 * Throws E_AUTH_MISSING (not E_CONFIG_INVALID) when missing.
 * Validates through fingerprintTarget for safe URL structure.
 * No raw URL in error message.
 */
function requireDatabaseUrl(source: CredentialSource): string {
  const url = source.get("DATABASE_URL");
  if (!url || typeof url !== "string" || url.length === 0) {
    throw err("E_AUTH_MISSING", "DATABASE_URL required for read operation");
  }
  // Validate URL structure without leaking it
  fingerprintTarget(url);
  return url;
}

export interface DatabaseRegistration { cleanup(): void; payloads: DatabasePayloadRegistry; }

export function registerDB(
  pi: ExtensionAPI,
  registry: ApprovalRegistry,
  deps: {
    credentialSource?: CredentialSource;
    payloads?: DatabasePayloadRegistry;
    clientFactory?: DatabaseClientFactory;
  } = {},
): DatabaseRegistration {
  const payloads = deps.payloads ?? new DatabasePayloadRegistry();
  const clientFactory = deps.clientFactory ?? createDefaultClientFactory();

  pi.registerTool({
    name: "DB",
    label: "Database Operations",
    description: "Inspect, query, plan, and apply database operations",
    parameters: DBSchema,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      if (!Value.Check(DBSchema, rawParams) || containsNonFiniteNumber(rawParams)) {
        throw err("E_CONFIG_INVALID", "DB parameters invalid");
      }
      const params = rawParams as DBInput;
      const cwd = ctx.cwd;
      const credentialSource = deps.credentialSource ?? (await import("../../deployment/credentials.js")).environmentSource();
      const environment = resolveDatabaseEnvironment(credentialSource);

      // ── Shared read actions (no pi-ship.json required) ──────────────
      if (params.action === "inspect") {
        const url = requireDatabaseUrl(credentialSource);
        const result = await inspectDatabase(url, clientFactory, signal);
        return {
          content: [{ type: "text", text: `Inspected ${result.schemas.length} schemas, ${result.relations.length} relations` }],
          details: result as unknown as Record<string, unknown>,
        };
      }

      if (params.action === "browse") {
        const url = requireDatabaseUrl(credentialSource);
        const result = await executeBrowse(url, clientFactory, {
          schema: params.schema,
          table: params.table,
          columns: params.columns,
          filters: params.filters,
          orderBy: params.orderBy,
          limit: params.limit ?? 100,
          offset: params.offset ?? 0,
        }, signal);
        return {
          content: [{ type: "text", text: `Browsed ${result.rowCount} rows from ${result.schema}.${result.table}${result.hasMore ? " (truncated)" : ""}` }],
          details: { columns: result.columns, rows: result.rows, rowCount: result.rowCount, hasMore: result.hasMore, schema: result.schema, table: result.table },
        };
      }

      if (params.action === "query") {
        const url = requireDatabaseUrl(credentialSource);
        const values = params.params ?? [];
        const result = await executeReadQuery(url, clientFactory, {
          sql: params.sql,
          params: values,
          limit: params.limit,
          signal,
        });
        return {
          content: [{ type: "text", text: `Query returned ${result.rowCount} rows${result.hasMore ? " (truncated)" : ""}` }],
          details: { columns: result.columns, rows: result.rows, rowCount: result.rowCount, hasMore: result.hasMore },
        };
      }

      // ── Plan action (shared, persisted, no client) ──────────────────
      if (params.action === "plan") {
        const values = params.params ?? [];
        const classification = await assertPublicPlan(params.sql, values);
        const targetFingerprint = fingerprintTarget(credentialSource.get("DATABASE_URL"));
        const fingerprints = await contextFingerprints(cwd);
        const plan = buildDatabasePlan({ environment, targetFingerprint, ...fingerprints, sql: params.sql, params: values, classification });
        await persistDatabasePlan(cwd, plan);
        payloads.register(plan.planId, plan.planDigest, { sql: params.sql, params: [...values], statements: classification.statements });
        const destructive = plan.riskLevel === "destructive";
        const approval = await requestPlanApproval(ctx, {
          planId: plan.planId, planDigest: plan.planDigest,
          metadata: { domain: "database", risk: destructive ? "destructive" : "write" },
          title: destructive ? "High-risk destructive database plan" : "Approve database plan",
          summary: destructive
            ? `Destructive statements: ${plan.destructiveReasons.join(", ")}`
            : `Statements: ${plan.statements.map((s) => `${s.tag} ${s.tables.join(",")}`).join("; ")}`,
        }, registry);
        return { content: [{ type: "text", text: `Database plan ${plan.planId}: ${plan.riskLevel}` }], details: { planId: plan.planId, planDigest: plan.planDigest, riskLevel: plan.riskLevel, statements: plan.statements, destructiveReasons: plan.destructiveReasons, approved: approval.approved } };
      }

      // ── Shared apply_plan (db-plan/1 kind, no manifest/provider) ─────
      if (params.action === "apply_plan") {
        const rawPlan = await readPlanFile(cwd, params.planId);
        if (rawPlan && typeof rawPlan === "object" && (rawPlan as Record<string, unknown>).kind === "db-plan/1") {
          const databaseUrl = credentialSource.get("DATABASE_URL");
          if (!databaseUrl) throw err("E_AUTH_MISSING", "DATABASE_URL required for database plan apply");
          const fingerprints = await contextFingerprints(cwd);
          const environment = resolveDatabaseEnvironment(credentialSource);
          const productionFlag = credentialSource.get("PI_SHIP_ALLOW_PRODUCTION_DB_WRITES");
          const result = await applyDatabasePlan({
            cwd,
            planId: params.planId,
            planDigest: params.planDigest,
            environment,
            databaseUrl,
            providerFingerprint: fingerprints.providerFingerprint,
            manifestFingerprint: fingerprints.manifestFingerprint,
            productionFlag,
            registry,
            payloads,
            clientFactory,
            signal,
          });
          return {
            content: [{ type: "text", text: `Database plan ${result.planId} committed (${result.statementCount} statements, ${result.affectedRows} rows)` }],
            details: { planId: result.planId, planDigest: result.planDigest, status: result.status, statementCount: result.statementCount, affectedRows: result.affectedRows },
          };
        }
        // Non-db-plan/1: fall through to provider handler
      }

      // ── Provider-dispatched actions ─────────────────────────────────
      const { manifest, packageId } = await providerRegistry.loadManifest(cwd);
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
