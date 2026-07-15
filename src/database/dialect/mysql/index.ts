/** MySQL/MariaDB dialect adapter — wraps mysql2 with the DialectAdapter contract. */
import { err, isShipError } from "../../../core/errors.js";
import { createHash } from "node:crypto";
import type { DatabaseTarget } from "../../target.js";
import type { DatabaseClient } from "../../client.js";
import { checkAborted } from "../../client.js";
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
import { classifyMySQLSQL } from "./classifier.js";
import { inspectMySQL } from "./inspect.js";
import { executeMySQLRead } from "./read.js";
import { executeMySQLBrowse } from "./browse.js";
import { parseMySQLURL, createMySQLClient } from "./client.js";
import { applyDialectPlan, type DialectMutationExecutor, type DialectError } from "../apply.js";

function hash(v: unknown): string {
  return createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");
}

/**
 * Backtick-quote a MySQL identifier.
 */
function quoteIdentifier(value: string): string {
  if (!value || typeof value !== "string") {
    throw err("E_CONFIG_INVALID", "invalid identifier");
  }
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(value)) {
    throw err("E_CONFIG_INVALID", `invalid identifier: ${value}`);
  }
  return `\`${value}\``;
}

/**
 * Compute a deterministic fingerprint for a MySQL/MariaDB target.
 * Normalized fields: protocol (mysql), lower-cased host, default 3306, database, username, TLS selectors.
 * Excludes password, raw URL.
 */
function fingerprintMySQL(target: DatabaseTarget): string {
  if (target.kind !== "remote") {
    throw err("E_CONFIG_INVALID", "MySQL adapter requires remote target");
  }
  try {
    const url = new URL(target.url);
    const protocol = url.protocol.slice(0, -1);
    if (protocol !== "mysql" && protocol !== "mariadb") throw new Error("protocol");
    if (!url.hostname || !url.pathname || url.pathname === "/" || !url.username) throw new Error("target");

    const ssl = [...url.searchParams.entries()]
      .filter(([key]) => /^(ssl|sslmode|sslrootcert|sslcert|sslkey)$/i.test(key))
      .sort();

    return hash({
      protocol: "mysql",
      host: url.hostname.toLowerCase(),
      port: url.port || "3306",
      database: decodeURIComponent(url.pathname.slice(1)),
      user: decodeURIComponent(url.username),
      ssl,
    });
  } catch {
    throw err("E_CONFIG_INVALID", "database target URL invalid");
  }
}

// ── MySQL mutation executor for applyDialectPlan ──

const mysqlExecutor: DialectMutationExecutor = {
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
      if (code === "ER_ACCESS_DENIED_ERROR" || code === "ER_DBACCESS_DENIED_ERROR") {
        return { code, shipCode: "E_AUTH_MISSING", retryable: false, definitive: true };
      }
      if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND") {
        return { code, shipCode: "E_PROVIDER", retryable: true, definitive: false };
      }
      if (code.startsWith("ER_")) {
        return { code, shipCode: "E_PROVIDER", retryable: false, definitive: true };
      }
    }

    return { code: "E_PROVIDER", shipCode: "E_PROVIDER", retryable: false, definitive: false };
  },

  async begin(client) {
    await client.query("START TRANSACTION");
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

export const mysqlAdapter: DialectAdapter = {
  id: "mysql",
  schemes: ["mysql", "mariadb"],
  label: "MySQL/MariaDB",
  local: false,

  async classify(sql: string, params: readonly unknown[]): Promise<Classification> {
    return classifyMySQLSQL(sql, params);
  },

  async assertPublicQuery(sql: string, params: readonly unknown[]): Promise<Classification> {
    const result = await classifyMySQLSQL(sql, params);
    if (result.statements.length !== 1 || result.riskLevel !== "read") {
      throw err("E_CONFIG_INVALID", "query requires exactly one read statement");
    }
    return result;
  },

  async assertPublicPlan(sql: string, params: readonly unknown[]): Promise<Classification> {
    const result = await classifyMySQLSQL(sql, params);
    if (result.riskLevel === "read") {
      throw err("E_CONFIG_INVALID", "plan requires write or destructive statement");
    }
    return result;
  },

  fingerprint(target: DatabaseTarget): string {
    return fingerprintMySQL(target);
  },

  async connect(target: DatabaseTarget, _mode: "read" | "write"): Promise<DatabaseClient> {
    if (target.kind !== "remote") {
      throw err("E_CONFIG_INVALID", "MySQL adapter requires remote target");
    }
    const options = parseMySQLURL(target.url);
    const client = await createMySQLClient(options);
    await client.connect();
    return client;
  },

  async inspect(target: DatabaseTarget, signal?: AbortSignal): Promise<InspectResult> {
    if (target.kind !== "remote") {
      throw err("E_CONFIG_INVALID", "MySQL adapter requires remote target");
    }
    return inspectMySQL(target, signal);
  },

  async browse(
    target: DatabaseTarget,
    input: DialectBrowseInput,
    signal?: AbortSignal,
  ): Promise<DialectBrowseResult> {
    if (target.kind !== "remote") {
      throw err("E_CONFIG_INVALID", "MySQL adapter requires remote target");
    }
    return executeMySQLBrowse(target, input, signal);
  },

  async read(target: DatabaseTarget, input: ReadQueryOptions): Promise<ReadQueryResult> {
    if (target.kind !== "remote") {
      throw err("E_CONFIG_INVALID", "MySQL adapter requires remote target");
    }
    return executeMySQLRead(target, input);
  },

  async executeApproved(
    target: DatabaseTarget,
    input: DialectApplyInput,
  ): Promise<ApplyDatabasePlanResult> {
    if (target.kind !== "remote") {
      throw err("E_CONFIG_INVALID", "MySQL adapter requires remote target");
    }
    const classify = (sql: string, params: readonly unknown[]) => classifyMySQLSQL(sql, params);
    return applyDialectPlan(
      input,
      fingerprintMySQL(target),
      classify,
      mysqlExecutor,
      async () => {
        const client = await createMySQLClient(parseMySQLURL(target.url));
        return client;
      },
    );
  },

  quoteIdentifier(value: string): string {
    return quoteIdentifier(value);
  },
};
