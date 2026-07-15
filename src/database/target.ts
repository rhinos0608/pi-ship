import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve, normalize, dirname, basename } from "node:path";
import { canonicalize } from "../core/canonicalize.js";
import { err } from "../core/errors.js";
import type { CredentialSource } from "../deployment/credentials.js";

export type DatabaseTarget =
  | { kind: "remote"; dialect: "postgres" | "mysql"; url: string }
  | { kind: "local"; dialect: "pglite"; dataDir: string }
  | { kind: "file"; dialect: "sqlite"; path: string };

const LOCAL_DB_DIR = ".pi-ship/local-db";

/**
 * Resolve the database target for shared DB actions.
 *
 * Rules:
 * - absent/blank DATABASE_URL → PGlite local target
 * - postgres:// or postgresql:// → remote postgres
 * - mysql:// or mariadb:// → remote MySQL
 * - sqlite: URL or plain .db/.sqlite/.sqlite3 path → SQLite file target
 * - rejects unsupported schemes, malformed SQLite syntax,
 *   absolute paths outside cwd, and `..` escape after resolve(cwd, input).
 */
export function resolveDatabaseTarget(
  source: CredentialSource,
  cwd: string,
): DatabaseTarget {
  const raw = source.get("DATABASE_URL");
  if (raw && typeof raw === "string" && raw.trim().length > 0) {
    const url = raw.trim();

    // Check for URL scheme (contains ://)
    if (url.includes("://")) {
      const scheme = url.split("://")[0]!.toLowerCase();
      if (scheme === "postgres" || scheme === "postgresql") {
        return { kind: "remote", dialect: "postgres", url };
      }
      if (scheme === "mysql" || scheme === "mariadb") {
        return { kind: "remote", dialect: "mysql", url };
      }
      if (scheme === "sqlite") {
        const path = resolveSqliteRef(url, cwd);
        return { kind: "file", dialect: "sqlite", path };
      }
      throw err("E_CONFIG_INVALID", "unsupported database URL scheme");
    }

    // Plain path — check if it looks like a SQLite file
    if (/\.(db|sqlite|sqlite3)$/i.test(url)) {
      const path = resolveSqliteRef(url, cwd);
      return { kind: "file", dialect: "sqlite", path };
    }

    throw err(
      "E_CONFIG_INVALID",
      "database target not recognized; use postgres://, mysql://, sqlite://, or a .db/.sqlite file path",
    );
  }
  return { kind: "local", dialect: "pglite", dataDir: join(cwd, LOCAL_DB_DIR) };
}

/**
 * Resolve a SQLite file reference (URL or plain path) against cwd.
 * Enforces path containment within cwd; rejects `..` escape and absolute paths
 * outside cwd. Never echoes the resolved path in error messages.
 */
function resolveSqliteRef(input: string, cwd: string): string {
  let filePath: string;

  // Strip sqlite: scheme prefix if present
  if (input.toLowerCase().startsWith("sqlite:")) {
    const rest = input.slice("sqlite:".length);
    if (rest.startsWith("///")) {
      filePath = rest.slice(2); // sqlite:///path → /path
    } else if (rest.startsWith("//")) {
      filePath = rest.slice(2); // sqlite://host/path → /path (ignore host)
    } else {
      filePath = rest; // sqlite:path or sqlite:/path
    }
  } else {
    filePath = input;
  }

  if (!filePath || filePath.length === 0) {
    throw err("E_CONFIG_INVALID", "invalid database file path");
  }

  const resolved = resolve(cwd, filePath);

  // Try symlink-aware containment; fall back to lexical check when cwd doesn't exist
  let effectiveCwd: string;
  try {
    effectiveCwd = realpathSync(cwd);
  } catch {
    // cwd doesn't exist — use lexical containment (test contexts only)
    const cwdNormLex = normalize(cwd) + "/";
    const resolvedNormLex = normalize(resolved) + "/";
    if (!resolvedNormLex.startsWith(cwdNormLex)) {
      throw err("E_CONFIG_INVALID", "database file path must be within working directory");
    }
    return resolved;
  }

  const cwdNorm = normalize(effectiveCwd) + "/";

  // Symlink-aware containment check
  let effectivePath: string;
  const extraSegments: string[] = [];

  try {
    effectivePath = realpathSync(resolved);
  } catch {
    // Path does not exist — resolve deepest existing ancestor
    let dir = dirname(resolved);
    const base = basename(resolved);
    if (base) extraSegments.push(base);

    while (true) {
      try {
        const realDir = realpathSync(dir);
        effectivePath = resolve(realDir, ...extraSegments);
        break;
      } catch {
        if (dirname(dir) === dir) {
          // Root — use resolved as fallback
          effectivePath = resolved;
          break;
        }
        extraSegments.unshift(basename(dir));
        dir = dirname(dir);
      }
    }
  }

  const effectiveNorm = normalize(effectivePath) + "/";

  if (!effectiveNorm.startsWith(cwdNorm)) {
    throw err("E_CONFIG_INVALID", "database file path must be within working directory");
  }

  // Reject '..' escape in non-existent path segments
  for (const seg of extraSegments) {
    if (seg === "..") {
      throw err("E_CONFIG_INVALID", "database file path must be within working directory");
    }
  }

  return resolved;
}

function hash(v: unknown): string {
  return createHash("sha256").update(typeof v === "string" ? v : canonicalize(v)).digest("hex");
}

/**
 * Compute a deterministic target fingerprint from a local datadir path.
 * No URL parsing — just hash the kind + resolved datadir path.
 */
export function fingerprintLocalTarget(dataDir: string): string {
  return hash({ kind: "local", dialect: "pglite", dataDir });
}
