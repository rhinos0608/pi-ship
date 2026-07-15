/** Dialect adapter contracts — no driver imports. */
import type { Environment } from "../../core/types.js";
import type { DatabaseClient } from "../client.js";
import type { Classification } from "../classifier.js";
import type { InspectResult } from "../inspect.js";
import type { ReadQueryOptions, ReadQueryResult } from "../read.js";
import type { ApplyDatabasePlanResult } from "../apply.js";
import type { DatabaseTarget } from "../target.js";
import type { ApprovalRegistry } from "../../core/approval.js";
import type { DatabasePayloadRegistry } from "../payload.js";

export type DatabaseDialectId = "postgres" | "pglite" | "sqlite" | "mysql";
export type DialectReadMode = "read" | "write";

export interface DialectBrowseInput {
  schema?: string;
  table: string;
  columns?: string[];
  filters?: Array<{ column: string; op: string; value?: unknown }>;
  orderBy?: Array<{ column: string; direction: string; nulls?: string }>;
  limit: number;
  offset: number;
}

export interface DialectBrowseResult {
  columns: { name: string; dataTypeID?: number }[];
  rows: Record<string, unknown>[];
  rowCount: number;
  hasMore: boolean;
  schema: string;
  table: string;
}

export interface DialectApplyInput {
  cwd: string;
  planId: string;
  planDigest: string;
  environment: Environment;
  providerFingerprint: string;
  manifestFingerprint: string;
  productionFlag: string | undefined;
  registry: ApprovalRegistry;
  payloads: DatabasePayloadRegistry;
  signal?: AbortSignal;
}

export interface DialectAdapter {
  readonly id: DatabaseDialectId;
  readonly schemes: readonly string[];
  readonly label: string;
  readonly local: boolean;

  classify(sql: string, params: readonly unknown[]): Promise<Classification>;
  assertPublicQuery(sql: string, params: readonly unknown[]): Promise<Classification>;
  assertPublicPlan(sql: string, params: readonly unknown[]): Promise<Classification>;
  fingerprint(target: DatabaseTarget): string;
  connect(target: DatabaseTarget, mode: DialectReadMode): Promise<DatabaseClient>;
  inspect(target: DatabaseTarget, signal?: AbortSignal): Promise<InspectResult>;
  browse(target: DatabaseTarget, input: DialectBrowseInput, signal?: AbortSignal): Promise<DialectBrowseResult>;
  read(target: DatabaseTarget, input: ReadQueryOptions): Promise<ReadQueryResult>;
  executeApproved(target: DatabaseTarget, input: DialectApplyInput): Promise<ApplyDatabasePlanResult>;
  quoteIdentifier(value: string): string;
}
