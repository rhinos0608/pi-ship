/** SQLite DialectAdapter — wraps node:sqlite DatabaseSync for read/write operations. */
import { err, isShipError } from "../../../core/errors.js";
import type { DatabaseTarget } from "../../target.js";
import type { DatabaseClient } from "../../client.js";
import type {
  DialectAdapter,
  DialectBrowseInput,
  DialectBrowseResult,
  DialectApplyInput,
} from "../contracts.js";
import type { Classification } from "../../classifier.js";
import type { InspectResult } from "../../inspect.js";
import type { ReadQueryOptions, ReadQueryResult } from "../../read.js";
import type { ApplyDatabasePlanResult } from "../../apply.js";
import { applyDialectPlan, type DialectMutationExecutor, type DialectError } from "../apply.js";
import { quoteIdentifier } from "../../identifiers.js";
import { fingerprintTarget } from "../../plan.js";
import { openSQLite, createSQLiteClient } from "./client.js";
import {
  classifySQLiteSQL,
  assertSQLitePublicQuery,
  assertSQLitePublicPlan,
} from "./classifier.js";
import { inspectSQLite } from "./inspect.js";
import { executeSQLiteBrowse } from "./browse.js";
import { executeSQLiteReadQuery } from "./read.js";

// ── SQLite mutation executor for applyDialectPlan ──

const sqliteExecutor: DialectMutationExecutor = {
  paramBinding: 'sequential',
  classifyError(cause: unknown): DialectError {
    if (isShipError(cause)) {
      const e = cause as { code: string; retryable: boolean };
      if (e.code === "E_CANCELLED") {
        return { code: e.code, shipCode: "E_CANCELLED", retryable: true, definitive: true };
      }
      return { code: e.code, shipCode: e.code, retryable: e.retryable, definitive: false };
    }

    if (cause instanceof Error) {
      const errObj = cause as Error & { code?: string };
      const code = errObj.code?.toUpperCase() ?? "";

      if (code === "ERR_ABORTED") {
        return { code, shipCode: "E_CANCELLED", retryable: false, definitive: true };
      }
      if (code === "ERR_SQLITE_BUSY" || code === "ERR_SQLITE_LOCKED") {
        return { code, shipCode: "E_PROVIDER", retryable: true, definitive: false };
      }
      if (code.startsWith("ERR_SQLITE")) {
        return { code, shipCode: "E_PROVIDER", retryable: false, definitive: true };
      }
    }

    return { code: "E_PROVIDER", shipCode: "E_PROVIDER", retryable: false, definitive: false };
  },

  async begin(client) {
    await client.query("BEGIN");
  },

  async execute(client, sql, params) {
    return client.query(sql, params);
  },

  async commit(client) {
    await client.query("COMMIT");
  },

  async rollback(client) {
    try {
      await client.query("ROLLBACK");
      return true;
    } catch { return false; }
  },
};

export const sqliteAdapter: DialectAdapter = {
  id: "sqlite",
  schemes: ["sqlite"],
  label: "SQLite",
  local: true,

  async classify(sql: string, params: readonly unknown[]): Promise<Classification> {
    return classifySQLiteSQL(sql, params);
  },

  async assertPublicQuery(
    sql: string,
    params: readonly unknown[],
  ): Promise<Classification> {
    return assertSQLitePublicQuery(sql, params);
  },

  async assertPublicPlan(
    sql: string,
    params: readonly unknown[],
  ): Promise<Classification> {
    return assertSQLitePublicPlan(sql, params);
  },

  fingerprint(target: DatabaseTarget): string {
    return fingerprintTarget(target);
  },

  async connect(
    target: DatabaseTarget,
    mode: "read" | "write",
  ): Promise<DatabaseClient> {
    if (target.kind !== "file") {
      throw err("E_CONFIG_INVALID", "SQLite adapter requires file target");
    }
    const db = openSQLite(target.path, mode);
    return createSQLiteClient(db);
  },

  async inspect(
    target: DatabaseTarget,
    _signal?: AbortSignal,
  ): Promise<InspectResult> {
    if (target.kind !== "file") {
      throw err("E_CONFIG_INVALID", "SQLite adapter requires file target");
    }
    const db = openSQLite(target.path, "read");
    const client = createSQLiteClient(db);
    try {
      return await inspectSQLite(client, _signal);
    } finally {
      await client.end();
    }
  },

  async browse(
    target: DatabaseTarget,
    input: DialectBrowseInput,
    _signal?: AbortSignal,
  ): Promise<DialectBrowseResult> {
    if (target.kind !== "file") {
      throw err("E_CONFIG_INVALID", "SQLite adapter requires file target");
    }
    const db = openSQLite(target.path, "read");
    const client = createSQLiteClient(db);
    try {
      return await executeSQLiteBrowse(client, input);
    } finally {
      await client.end();
    }
  },

  async read(
    target: DatabaseTarget,
    input: ReadQueryOptions,
  ): Promise<ReadQueryResult> {
    if (target.kind !== "file") {
      throw err("E_CONFIG_INVALID", "SQLite adapter requires file target");
    }
    const db = openSQLite(target.path, "read");
    const client = createSQLiteClient(db);
    try {
      return await executeSQLiteReadQuery(client, input);
    } finally {
      await client.end();
    }
  },

  async executeApproved(
    target: DatabaseTarget,
    input: DialectApplyInput,
  ): Promise<ApplyDatabasePlanResult> {
    if (target.kind !== "file") {
      throw err("E_CONFIG_INVALID", "SQLite adapter requires file target");
    }
    const classify = (sql: string, params: readonly unknown[]) => classifySQLiteSQL(sql, params);
    return applyDialectPlan(
      input,
      fingerprintTarget(target),
      classify,
      sqliteExecutor,
      async () => {
        const db = openSQLite(target.path, "write");
        return createSQLiteClient(db);
      },
    );
  },

  quoteIdentifier(value: string): string {
    return quoteIdentifier(value);
  },
};
