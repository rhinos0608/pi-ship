/** MySQL/MariaDB database client wrapper — one connection per operation, lazy mysql2 import. */
import type { DatabaseClient, DatabaseQueryResult } from "../../client.js";
import { mapMySQLError } from "./error.js";

/** Lazy-loaded mysql2/promise module handle. Uses dynamic import for testability. */
let _mysql2PromiseModule: any = null;

async function getMySQL2(): Promise<any> {
  if (!_mysql2PromiseModule) {
    _mysql2PromiseModule = await import("mysql2/promise");
  }
  return _mysql2PromiseModule;
}

/**
 * Parse a mysql: or mariadb: URL into connection options.
 * Extracts host, port, database, user, password, and TLS-related params.
 * Never spreads URL query options into driver options.
 */
export function parseMySQLURL(url: string): Record<string, unknown> {
  // Normalize empty hostname: mysql://user:pass@/db -> mysql://user:pass@localhost/db
  const normalized = url.replace(/^mysql:\/\/[^@]+@\//, (m) => m.slice(0, -1) + "localhost/")
    .replace(/^mariadb:\/\/[^@]+@\//, (m) => m.slice(0, -1) + "localhost/");

  const parsed = new URL(normalized);
  const protocol = parsed.protocol.slice(0, -1).toLowerCase();
  if (protocol !== "mysql" && protocol !== "mariadb") {
    throw new Error(`unsupported MySQL URL protocol: ${protocol}`);
  }

  const opts: Record<string, unknown> = {
    host: parsed.hostname || "localhost",
    port: parsed.port ? parseInt(parsed.port, 10) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname ? decodeURIComponent(parsed.pathname.slice(1)) : undefined,
    multipleStatements: false,
  };

  // TLS/SSL params only — never spread arbitrary query params
  const sslKeys = parsed.searchParams.get("ssl");
  if (sslKeys !== null) {
    opts.ssl = sslKeys;
  }
  const sslmode = parsed.searchParams.get("sslmode");
  if (sslmode !== null) {
    opts.ssl = opts.ssl || {};
    (opts.ssl as Record<string, unknown>).rejectUnauthorized = sslmode === "required" || sslmode === "verify-full";
  }
  const sslrootcert = parsed.searchParams.get("sslrootcert");
  if (sslrootcert !== null) {
    opts.ssl = opts.ssl || {};
    (opts.ssl as Record<string, unknown>).ca = sslrootcert;
  }

  return opts;
}

/**
 * Create a MySQL DatabaseClient from parsed connection options.
 * Each call creates a fresh connection; no pooling.
 */
export async function createMySQLClient(options: Record<string, unknown>): Promise<DatabaseClient> {
  const mysql2 = await getMySQL2();
  // Always enforce multipleStatements false
  const driverOpts = { ...options, multipleStatements: false };
  const raw = mysql2.createConnection(driverOpts);

  const adapter: DatabaseClient = {
    async connect(): Promise<void> {
      try {
        await raw.connect();
      } catch (cause) {
        mapMySQLError(cause);
      }
    },

    async query(text: string, params?: readonly unknown[]): Promise<DatabaseQueryResult> {
      try {
        const [rows, fields] = await raw.execute(text, params as any[] | undefined);
        const rowArray = Array.isArray(rows) ? rows : [rows];
        return {
          fields: (fields ?? []).map((f: { name: string; type?: number }) => ({
            name: f.name,
            dataTypeID: f.type ?? 0,
          })),
          rows: rowArray.map((r: Record<string, unknown>) => ({ ...r })),
          rowCount: Array.isArray(rows) ? rows.length : (rows as { affectedRows?: number }).affectedRows ?? null,
          command: text.trim().split(/\s+/)[0]?.toUpperCase() ?? "",
        };
      } catch (cause) {
        mapMySQLError(cause);
      }
    },

    async end(): Promise<void> {
      try {
        await raw.end();
      } catch {
        // best-effort
      }
    },
  };

  return adapter;
}
