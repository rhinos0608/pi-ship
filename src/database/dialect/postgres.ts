/** PostgreSQL dialect adapter — pure delegation wrapper over existing functions. */
import { err } from "../../core/errors.js";
import type { DatabaseTarget } from "../target.js";
import { createDefaultClientFactory } from "../client.js";
import type { DatabaseClient } from "../client.js";
import { classifySQL, assertPublicQuery, assertPublicPlan } from "../classifier.js";
import type { Classification } from "../classifier.js";
import { inspectDatabase } from "../inspect.js";
import type { InspectResult } from "../inspect.js";
import { executeBrowse } from "../browse.js";
import { executeReadQuery } from "../read.js";
import type { ReadQueryOptions, ReadQueryResult } from "../read.js";
import { applyDatabasePlan } from "../apply.js";
import type { ApplyDatabasePlanResult } from "../apply.js";
import { quoteIdentifier } from "../identifiers.js";
import { fingerprintTarget } from "../plan.js";
import type { DialectAdapter, DialectBrowseInput, DialectBrowseResult, DialectApplyInput } from "./contracts.js";

export const postgresAdapter: DialectAdapter = {
  id: "postgres",
  schemes: ["postgres", "postgresql"],
  label: "PostgreSQL",
  local: false,

  async classify(sql: string, params: readonly unknown[]): Promise<Classification> {
    return classifySQL(sql, params);
  },

  async assertPublicQuery(sql: string, params: readonly unknown[]): Promise<Classification> {
    return assertPublicQuery(sql, params);
  },

  async assertPublicPlan(sql: string, params: readonly unknown[]): Promise<Classification> {
    return assertPublicPlan(sql, params);
  },

  fingerprint(target: DatabaseTarget): string {
    if (target.kind !== "remote") {
      throw err("E_CONFIG_INVALID", "postgres adapter requires remote target");
    }
    return fingerprintTarget(target.url);
  },

  async connect(target: DatabaseTarget, _mode: "read" | "write"): Promise<DatabaseClient> {
    if (target.kind !== "remote") {
      throw err("E_CONFIG_INVALID", "postgres adapter requires remote target");
    }
    const factory = createDefaultClientFactory();
    const client = factory(target.url);
    await client.connect();
    return client;
  },

  async inspect(target: DatabaseTarget, signal?: AbortSignal): Promise<InspectResult> {
    if (target.kind !== "remote") {
      throw err("E_CONFIG_INVALID", "postgres adapter requires remote target");
    }
    const factory = createDefaultClientFactory();
    return inspectDatabase(target.url, factory, signal);
  },

  async browse(
    target: DatabaseTarget,
    input: DialectBrowseInput,
    signal?: AbortSignal,
  ): Promise<DialectBrowseResult> {
    if (target.kind !== "remote") {
      throw err("E_CONFIG_INVALID", "postgres adapter requires remote target");
    }
    const factory = createDefaultClientFactory();
    const result = await executeBrowse(target.url, factory, {
      schema: input.schema,
      table: input.table,
      columns: input.columns,
      filters: input.filters as any,
      orderBy: input.orderBy as any,
      limit: input.limit,
      offset: input.offset,
    }, signal);
    return {
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      hasMore: result.hasMore,
      schema: result.schema,
      table: result.table,
    };
  },

  async read(target: DatabaseTarget, input: ReadQueryOptions): Promise<ReadQueryResult> {
    if (target.kind !== "remote") {
      throw err("E_CONFIG_INVALID", "postgres adapter requires remote target");
    }
    const factory = createDefaultClientFactory();
    return executeReadQuery(target.url, factory, input);
  },

  async executeApproved(target: DatabaseTarget, input: DialectApplyInput): Promise<ApplyDatabasePlanResult> {
    if (target.kind !== "remote") {
      throw err("E_CONFIG_INVALID", "postgres adapter requires remote target");
    }
    const clientFactory = createDefaultClientFactory();
    return applyDatabasePlan({
      cwd: input.cwd,
      planId: input.planId,
      planDigest: input.planDigest,
      environment: input.environment,
      databaseUrl: target.url,
      providerFingerprint: input.providerFingerprint,
      manifestFingerprint: input.manifestFingerprint,
      productionFlag: input.productionFlag,
      registry: input.registry,
      payloads: input.payloads,
      clientFactory,
      signal: input.signal,
    });
  },

  quoteIdentifier(value: string): string {
    return quoteIdentifier(value);
  },
};
