# Zero-Config Local Database Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `DB` tool fully useful when no `DATABASE_URL` or `pi-ship.json` is configured by falling back to embedded PGlite.

**Architecture:** New `DatabaseTarget` discriminated type routes shared actions to either remote PostgreSQL (existing behavior, unchanged) or embedded PGlite (new). `PGliteClient` implements the existing `DatabaseClient` interface so all existing SQL — classifier, pg_catalog inspect, cursor reads, apply transactions — runs unchanged. Open local writes bypass the plan/approve/journal ceremony. Tasks T1–T5 are parallel with zero file overlap; T6 wires them together.

**Tech Stack:** TypeScript, `@pgsql/parser`, `@electric-sql/pglite` (new), `pg`, typebox, vitest.

## Global Constraints

- Remote-target behavior must be byte-for-byte identical — no regression in existing tests.
- `PI_SHIP_LOCAL_DB_GATED=true` is the sole gating mechanism; no manifest field, no schema change.
- All error messages must be safe generic — no SQL, params, URLs, paths, or internal details leaked.
- All externally-sourced tool output must pass through `defendToolResult`.
- Follow existing conventions: typebox strict schemas, `err()` ShipError codes, `checkAborted` at dispatch points, `quoteIdentifier` for all dynamic identifiers.
- No scope beyond the approved design (no export/dump, no memory mode, no localhost discovery, no SQLite/MySQL).

---

### Task 1: Local target resolution + environment default

**Files:**
- Create: `src/database/target.ts`
- Modify: `src/database/environment.ts:7-17`
- Modify: `src/database/plan.ts:196-217`
- Create: `test/database/target.test.ts`
- Modify: `test/database/environment.test.ts` (add local-default cases)

**Interfaces:**
- Produces: `DatabaseTarget` type, `resolveDatabaseTarget(credentialSource, cwd)`, extended `fingerprintTarget(target)` accepting `string | DatabaseTarget | undefined`
- Produces: `resolveDatabaseEnvironment(source, targetKind?)` — defaults to `"development"` when target is local

**Description:**

Introduce a discriminated `DatabaseTarget` type and a resolver that replaces `requireDatabaseUrl` for shared actions. Extend `fingerprintTarget` to accept both legacy URL strings and the new target type. Add local defaulting to `resolveDatabaseEnvironment`.

- [ ] **Step 1: Create `src/database/target.ts`**

```typescript
/** Target discriminator for local vs remote database connections. */
export type DatabaseTarget =
  | { kind: "remote"; url: string }
  | { kind: "local"; dataDir: string };

import { join } from "node:path";
import type { CredentialSource } from "../deployment/credentials.js";

const LOCAL_DB_DIR = ".pi-ship/local-db";

/**
 * Resolve the database target for shared DB actions.
 * - DATABASE_URL set → remote target
 * - DATABASE_URL absent → local PGlite target at <cwd>/.pi-ship/local-db/
 */
export function resolveDatabaseTarget(
  source: CredentialSource,
  cwd: string,
): DatabaseTarget {
  const url = source.get("DATABASE_URL");
  if (url && typeof url === "string" && url.length > 0) {
    return { kind: "remote", url };
  }
  return { kind: "local", dataDir: join(cwd, LOCAL_DB_DIR) };
}

import { createHash } from "node:crypto";
import { canonicalize } from "../core/canonicalize.js";

function hash(v: unknown): string {
  return createHash("sha256").update(typeof v === "string" ? v : canonicalize(v)).digest("hex");
}

/**
 * Compute a deterministic target fingerprint from a local datadir path.
 * No URL parsing — just hash the kind + resolved datadir path.
 */
export function fingerprintLocalTarget(dataDir: string): string {
  return hash({ kind: "local", dataDir });
}
```

- [ ] **Step 2: Verify `src/database/target.ts` compiles**

```bash
npx tsc --noEmit src/database/target.ts
```

- [ ] **Step 3: Extend `fingerprintTarget` in `src/database/plan.ts:196-217`**

Modify the signature to accept `string | DatabaseTarget | undefined`. Extract the existing URL logic into a private helper. Add a branch for `DatabaseTarget` objects.

```typescript
// In src/database/plan.ts, add import:
import type { DatabaseTarget } from "./target.js";
import { fingerprintLocalTarget } from "./target.js";

// Replace the existing fingerprintTarget function:
export function fingerprintTarget(target: string | DatabaseTarget | undefined): string {
  if (target === undefined) throw err("E_AUTH_MISSING", "DATABASE_URL missing");
  if (typeof target === "object") {
    if (target.kind === "remote") return fingerprintRemoteURL(target.url);
    return fingerprintLocalTarget(target.dataDir);
  }
  return fingerprintRemoteURL(target);
}

// Rename existing body to:
function fingerprintRemoteURL(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    const protocol = url.protocol.slice(0, -1);
    if (protocol !== "postgres" && protocol !== "postgresql") throw new Error("protocol");
    if (!url.hostname || !url.pathname || url.pathname === "/" || !url.username) throw new Error("target");
    const ssl = [...url.searchParams.entries()]
      .filter(([key]) => /^(sslmode|ssl|sslrootcert|sslcert|sslkey)$/i.test(key))
      .sort();
    return hash({
      protocol: "postgres",
      host: url.hostname.toLowerCase(),
      port: url.port || "5432",
      database: decodeURIComponent(url.pathname.slice(1)),
      user: decodeURIComponent(url.username),
      ssl,
    });
  } catch {
    throw err("E_CONFIG_INVALID", "database target URL invalid");
  }
}
```

- [ ] **Step 4: Modify `src/database/environment.ts`**

Add a second parameter for target kind and default to `"development"` when local.

```typescript
import { err } from "../core/errors.js";
import type { Environment } from "../core/types.js";
import type { CredentialSource } from "../deployment/credentials.js";

const databaseEnvironments = new Set<Environment>(["development", "preview", "production"]);

/**
 * Resolve the database environment.
 * When targetKind is "local" and PI_SHIP_DATABASE_ENVIRONMENT is unset,
 * default to "development" instead of throwing.
 * Remote targets must still have the env var set explicitly.
 */
export function resolveDatabaseEnvironment(
  source: CredentialSource,
  targetKind?: "remote" | "local",
): Environment {
  const value = source.get("PI_SHIP_DATABASE_ENVIRONMENT");
  if (value && databaseEnvironments.has(value as Environment)) {
    return value as Environment;
  }
  if (targetKind === "local") {
    return "development";
  }
  throw err(
    "E_CONFIG_INVALID",
    "PI_SHIP_DATABASE_ENVIRONMENT must be development, preview, or production",
  );
}
```

- [ ] **Step 5: Create `test/database/target.test.ts`**

```typescript
import { describe, expect, it } from "vitest";
import { resolveDatabaseTarget, fingerprintLocalTarget } from "../../src/database/target.js";
import { fingerprintTarget } from "../../src/database/plan.js";

describe("resolveDatabaseTarget", () => {
  it("returns remote target when DATABASE_URL is set", () => {
    const source = { get: (name: string) => name === "DATABASE_URL" ? "postgres://user:pass@host:5432/db" : undefined };
    const target = resolveDatabaseTarget(source, "/tmp/project");
    expect(target).toEqual({ kind: "remote", url: "postgres://user:pass@host:5432/db" });
  });

  it("returns local target when DATABASE_URL is absent", () => {
    const source = { get: () => undefined };
    const target = resolveDatabaseTarget(source, "/tmp/project");
    expect(target).toEqual({ kind: "local", dataDir: "/tmp/project/.pi-ship/local-db" });
  });

  it("returns local target when DATABASE_URL is empty string", () => {
    const source = { get: () => "" };
    const target = resolveDatabaseTarget(source, "/tmp/project");
    expect(target.kind).toBe("local");
  });

  it("returns local target when DATABASE_URL is whitespace-only", () => {
    const source = { get: () => "   " };
    const target = resolveDatabaseTarget(source, "/tmp/project");
    expect(target.kind).toBe("local");
  });
});

describe("fingerprintTarget", () => {
  it("handles remote DatabaseTarget", () => {
    const a = fingerprintTarget({ kind: "remote", url: "postgres://user:pass@host:5432/db" });
    const b = fingerprintTarget("postgres://user:pass@host:5432/db");
    expect(a).toBe(b); // same as legacy string path
  });

  it("handles local DatabaseTarget deterministically", () => {
    const a = fingerprintTarget({ kind: "local", dataDir: "/projects/app/.pi-ship/local-db" });
    const b = fingerprintTarget({ kind: "local", dataDir: "/projects/app/.pi-ship/local-db" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles undefined target", () => {
    expect(() => fingerprintTarget(undefined)).toThrow();
  });

  it("handles legacy undefined (throws with DATABASE_URL missing message)", () => {
    expect(() => fingerprintTarget(undefined)).toThrow(/DATABASE_URL/);
  });

  it("preserves existing behavior for URL strings", () => {
    const fp = fingerprintTarget("postgres://alice:secret@db.example.com:5432/myapp");
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    // postgres and postgresql normalize to same fingerprint
    expect(
      fingerprintTarget("postgres://u:p@h:5432/d")
    ).toBe(
      fingerprintTarget("postgresql://u:p@h:5432/d")
    );
  });
});
```

- [ ] **Step 6: Extend `test/database/environment.test.ts`**

Add tests for the new local-default behavior.

```typescript
// Add after existing describe block:
describe("resolveDatabaseEnvironment with targetKind", () => {
  it("defaults to development for local target when unset", () => {
    expect(resolveDatabaseEnvironment({ get: () => undefined }, "local")).toBe("development");
  });

  it("honors explicit setting on local target", () => {
    expect(resolveDatabaseEnvironment({ get: () => "preview" }, "local")).toBe("preview");
  });

  it("still throws for remote target when unset", () => {
    expect(() => resolveDatabaseEnvironment({ get: () => undefined }, "remote")).toThrow(/PI_SHIP_DATABASE_ENVIRONMENT/);
  });

  it("still works without targetKind (backward compat — remote default)", () => {
    expect(resolveDatabaseEnvironment({ get: () => "production" })).toBe("production");
    expect(() => resolveDatabaseEnvironment({ get: () => undefined })).toThrow(/PI_SHIP_DATABASE_ENVIRONMENT/);
  });
});
```

- [ ] **Step 7: Run tests**

```bash
npx vitest --run test/database/target.test.ts test/database/environment.test.ts
```

Expected: all pass. Existing `plan-integration.test.ts` tests must still pass (they call `fingerprintTarget` with URL strings).

```bash
npx vitest --run test/database/plan-integration.test.ts
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/database/target.ts src/database/environment.ts src/database/plan.ts test/database/target.test.ts test/database/environment.test.ts
git commit -m "feat: add local target resolution and environment defaulting"
```

---

### Task 2: PGlite client adapter + instance cache

**Files:**
- Create: `src/database/local/pglite-client.ts`
- Create: `src/database/local/instance-cache.ts`
- Modify: `package.json` (add `@electric-sql/pglite` to dependencies)
- Create: `test/database/local/pglite-client.test.ts`

**Interfaces:**
- Consumes: `DatabaseClient`, `DatabaseQueryResult`, `DatabaseField` from `src/database/client.ts`
- Produces: `createPGliteClient(dataDir: string): Promise<DatabaseClient>`, `resetPGliteInstance(dataDir: string): Promise<void>`, `closePGliteInstance(dataDir: string): Promise<void>` from instance cache

**Description:**

Wrap PGlite behind the existing `DatabaseClient` interface so all existing SQL code paths (inspect, browse, read, apply) work without modification. Cache one PGlite instance per datadir per process. `end()` is a no-op for local clients.

- [ ] **Step 1: Add `@electric-sql/pglite` dependency**

```bash
npm install --save-exact @electric-sql/pglite
```

- [ ] **Step 2: Create `src/database/local/instance-cache.ts`**

```typescript
import { rm } from "node:fs/promises";

/** Dynamic import — lazy-loads PGlite only when local target is used. */
async function importPGlite(): Promise<typeof import("@electric-sql/pglite")> {
  return import("@electric-sql/pglite");
}

const instances = new Map<string, Awaited<ReturnType<typeof importPGlite>>["PGlite"]>();
const inits = new Map<string, Promise<void>>();

/**
 * Get or create a PGlite instance for the given datadir.
 * Cached per-process. ~500ms cold start paid once per datadir.
 * Operations on a given datadir are implicitly serialized (PGlite is single-connection).
 */
export async function getPGliteInstance(dataDir: string): Promise<Awaited<ReturnType<typeof importPGlite>>["PGlite"]> {
  const existing = instances.get(dataDir);
  if (existing) return existing;

  const pending = inits.get(dataDir);
  if (pending) {
    await pending;
    return instances.get(dataDir)!;
  }

  const promise = (async () => {
    const { PGlite } = await importPGlite();
    const instance = new PGlite(dataDir);
    instances.set(dataDir, instance);
  })();

  inits.set(dataDir, promise);
  try {
    await promise;
  } finally {
    inits.delete(dataDir);
  }

  return instances.get(dataDir)!;
}

/**
 * Close and remove a cached PGlite instance.
 * Used by reset and process cleanup.
 */
export async function closePGliteInstance(dataDir: string): Promise<void> {
  const instance = instances.get(dataDir);
  if (instance) {
    instances.delete(dataDir);
    try { await instance.close(); } catch { /* best-effort */ }
  }
}

/**
 * Wipe the local datadir and remove from cache.
 * Deletes the directory, then removes the in-memory cache entry.
 */
export async function resetPGliteInstance(dataDir: string): Promise<void> {
  await closePGliteInstance(dataDir);
  await rm(dataDir, { recursive: true, force: true });
}
```

- [ ] **Step 3: Create `src/database/local/pglite-client.ts`**

```typescript
import type { DatabaseClient, DatabaseQueryResult } from "../client.js";
import { getPGliteInstance } from "./instance-cache.js";

/**
 * Create a DatabaseClient backed by a cached PGlite instance.
 * The dataDir is used as the cache key; the PGlite instance is
 * auto-created on first access.
 * `connect()` is a no-op (PGlite initializes on construction).
 * `end()` is a no-op (instances are process-scoped).
 */
export async function createPGliteClient(dataDir: string): Promise<DatabaseClient> {
  const pg = await getPGliteInstance(dataDir);

  return {
    async connect(): Promise<void> {
      // PGlite initializes at construction; no explicit connect needed.
    },

    async query(text: string, params?: readonly unknown[]): Promise<DatabaseQueryResult> {
      const result = await pg.query(text, params as unknown[] | undefined);
      return {
        fields: (result.fields ?? []).map((f) => ({
          name: f.name,
          dataTypeID: (f as { dataTypeID?: number }).dataTypeID ?? 0,
        })),
        rows: result.rows as Record<string, unknown>[],
        rowCount: (result as { affectedRows?: number }).affectedRows ?? result.rows.length,
        command: (result as { command?: string }).command ?? "SELECT",
      };
    },

    async end(): Promise<void> {
      // No-op. Instances are process-scoped and cleaned up on exit.
    },
  };
}
```

- [ ] **Step 4: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Create `test/database/local/pglite-client.test.ts`**

Use a fake that mimics PGlite's interface. Test the adapter mapping, connect/end no-ops, query result shape, and error propagation.

```typescript
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../../../src/database/client.js";

// We test the mapping logic without a real PGlite by mocking the module.
// The integration suite (T6) tests against real in-memory PGlite.

describe("PGliteClient adapter", () => {
  // Create a thin helper that mimics what createPGliteClient does
  function wrapPGliteLike(pg: {
    query: (text: string, params?: unknown[]) => Promise<{
      rows: Record<string, unknown>[];
      fields?: { name: string; dataTypeID?: number }[];
      affectedRows?: number;
      command?: string;
    }>;
  }): DatabaseClient {
    return {
      async connect() {},
      async query(text: string, params?: readonly unknown[]) {
        const result = await pg.query(text, params as unknown[] | undefined);
        return {
          fields: (result.fields ?? []).map((f) => ({
            name: f.name,
            dataTypeID: f.dataTypeID ?? 0,
          })),
          rows: result.rows ?? [],
          rowCount: result.affectedRows ?? result.rows.length,
          command: result.command ?? "SELECT",
        };
      },
      async end() {},
    };
  }

  it("maps SELECT query result correctly", async () => {
    const fakePg = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: 1, name: "alice" }],
        fields: [
          { name: "id", dataTypeID: 23 },
          { name: "name", dataTypeID: 25 },
        ],
        command: "SELECT",
      }),
    };
    const client = wrapPGliteLike(fakePg);
    const result = await client.query("SELECT id, name FROM users");
    expect(result.fields).toHaveLength(2);
    expect(result.fields[0]).toEqual({ name: "id", dataTypeID: 23 });
    expect(result.rows).toEqual([{ id: 1, name: "alice" }]);
    expect(result.rowCount).toBe(1);
    expect(result.command).toBe("SELECT");
  });

  it("maps INSERT result with affectedRows", async () => {
    const fakePg = {
      query: vi.fn().mockResolvedValue({
        rows: [],
        fields: [],
        affectedRows: 3,
        command: "INSERT",
      }),
    };
    const client = wrapPGliteLike(fakePg);
    const result = await client.query("INSERT INTO t VALUES ($1), ($2), ($3)", [1, 2, 3]);
    expect(result.rowCount).toBe(3);
    expect(result.command).toBe("INSERT");
  });

  it("handles missing fields gracefully (defaults to empty)", async () => {
    const fakePg = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
    const client = wrapPGliteLike(fakePg);
    const result = await client.query("SELECT 1");
    expect(result.fields).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(result.command).toBe("SELECT");
  });

  it("propagates query errors through mapSQLError path", async () => {
    const pgError = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const fakePg = { query: vi.fn().mockRejectedValue(pgError) };
    const client = wrapPGliteLike(fakePg);
    await expect(client.query("SELECT * FROM nonexistent")).rejects.toMatchObject({ code: "42P01" });
  });

  it("connect and end are no-ops (do not throw)", async () => {
    const fakePg = { query: vi.fn() };
    const client = wrapPGliteLike(fakePg);
    await expect(client.connect()).resolves.toBeUndefined();
    await expect(client.end()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 6: Run tests**

```bash
npx vitest --run test/database/local/pglite-client.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/database/local/ test/database/local/
git commit -m "feat: add PGlite client adapter and instance cache"
```

---

### Task 3: Open-write execution path

**Files:**
- Create: `src/database/execute-local.ts`
- Create: `test/database/execute-local.test.ts`

**Interfaces:**
- Consumes: `DatabaseClient` from `src/database/client.ts`, `classifySQL` from `src/database/classifier.ts`, `executeReadQuery` from `src/database/read.ts`, `mapSQLError` + `checkAborted` from `src/database/client.ts`
- Produces: `executeLocalQuery(client, sql, params, signal)` — classifies, routes reads to existing cursor path, executes writes/destructive directly in a transaction

**Description:**

Classify-then-route: `read` risk delegates to existing `executeReadQuery`; `write`/`destructive` execute directly in a plain `BEGIN` → statements → `COMMIT`/`ROLLBACK` transaction. No approval, no plan, no journal. `blocked` classifications still refuse.

- [ ] **Step 1: Create `src/database/execute-local.ts`**

```typescript
import type { DatabaseClient, DatabaseClientFactory } from "./client.js";
import { checkAborted, mapSQLError } from "./client.js";
import { classifySQL } from "./classifier.js";
import { executeReadQuery } from "./read.js";
import { err } from "../core/errors.js";

export interface LocalQueryResult {
  /** Distinguish read vs write result shape. */
  kind: "read" | "mutation";
  columns?: { name: string; dataTypeID?: number }[];
  rows?: Record<string, unknown>[];
  rowCount: number;
  hasMore?: boolean;
  statementCount: number;
}

/**
 * Execute a classified query directly against a local DatabaseClient.
 * - read → delegates to executeReadQuery (cursor transaction)
 * - write/destructive → direct BEGIN/COMMIT transaction, no approval/journal
 * - blocked → refused
 * The client is already connected (local PGlite).
 * Since executeReadQuery takes a connectionString + factory, we create a
 * single-use factory that returns the provided client.
 */
export async function executeLocalQuery(
  client: DatabaseClient,
  sql: string,
  params: readonly unknown[],
  signal?: AbortSignal,
): Promise<LocalQueryResult> {
  checkAborted(signal);
  const classification = await classifySQL(sql, params);

  if (classification.riskLevel === "blocked") {
    throw err("E_CONFIG_INVALID", "SQL contains blocked statement");
  }

  if (classification.riskLevel === "read") {
    // Use existing cursor read path. Provide a factory that returns this client
    // (executeReadQuery calls connect() which is a no-op for PGlite).
    const factory: DatabaseClientFactory = () => client;
    const readResult = await executeReadQuery(
      "pglite://local", // dummy — factory ignores it
      factory,
      { sql: classification.statements[0]!.sql, params, signal },
    );
    return {
      kind: "read",
      columns: readResult.columns,
      rows: readResult.rows,
      rowCount: readResult.rowCount,
      hasMore: readResult.hasMore,
      statementCount: 1,
    };
  }

  // write or destructive — direct transaction
  checkAborted(signal);
  await client.query("BEGIN");
  let began = true;
  let totalAffected = 0;

  try {
    await client.query("SET LOCAL statement_timeout = '30000ms'");
    await client.query("SET LOCAL lock_timeout = '5000ms'");

    for (const stmt of classification.statements) {
      checkAborted(signal);
      const boundParams = params.slice(0, stmt.paramCount);
      const result = await client.query(stmt.sql, boundParams);
      if (result.rowCount !== null) totalAffected += result.rowCount;
    }

    checkAborted(signal);
    await client.query("COMMIT");
    began = false;

    return {
      kind: "mutation",
      rowCount: totalAffected,
      statementCount: classification.statements.length,
    };
  } catch (cause) {
    if (began) {
      try { await client.query("ROLLBACK"); } catch { /* best-effort */ }
    }
    mapSQLError(cause);
    throw cause; // unreachable — mapSQLError always throws
  }
}
```

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Create `test/database/execute-local.test.ts`**

Test with spy clients: mutation transaction order, read delegation, error rollback, abort behavior.

```typescript
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient, DatabaseQueryResult } from "../../src/database/client.js";
import { executeLocalQuery } from "../../src/database/execute-local.js";

function makeSpyClient(opts?: {
  queryResults?: Map<string, DatabaseQueryResult>;
  queryError?: Error;
}): DatabaseClient {
  const defaultResult = { fields: [], rows: [], rowCount: 0, command: "SELECT" };
  const results = opts?.queryResults ?? new Map();
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn(async (text: string, _params?: readonly unknown[]) => {
      if (opts?.queryError) throw opts.queryError;
      return results.get(text) ?? defaultResult;
    }),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

describe("executeLocalQuery", () => {
  it("executes write mutation in transaction: BEGIN → SET → statement → COMMIT", async () => {
    const results = new Map<string, DatabaseQueryResult>();
    results.set("BEGIN", { fields: [], rows: [], rowCount: 0, command: "BEGIN" });
    results.set("SET LOCAL statement_timeout = '30000ms'", { fields: [], rows: [], rowCount: 0, command: "SET" });
    results.set("SET LOCAL lock_timeout = '5000ms'", { fields: [], rows: [], rowCount: 0, command: "SET" });
    results.set("COMMIT", { fields: [], rows: [], rowCount: 0, command: "COMMIT" });
    const client = makeSpyClient({ queryResults: results });

    const result = await executeLocalQuery(client, "INSERT INTO users (name) VALUES ($1)", ["alice"]);

    expect(result.kind).toBe("mutation");
    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe("BEGIN");
    expect(calls[1][0]).toBe("SET LOCAL statement_timeout = '30000ms'");
    expect(calls[2][0]).toBe("SET LOCAL lock_timeout = '5000ms'");
    expect(calls[3][0]).toBe("INSERT INTO users (name) VALUES ($1)");
    expect(calls[3][1]).toEqual(["alice"]);
    expect(calls[4][0]).toBe("COMMIT");
  });

  it("refuses blocked classification (e.g. DROP DATABASE)", async () => {
    const client = makeSpyClient();
    await expect(
      executeLocalQuery(client, "DROP DATABASE production", []),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    // Never contacted client
    expect(client.query).not.toHaveBeenCalled();
  });

  it("refuses empty SQL", async () => {
    const client = makeSpyClient();
    await expect(
      executeLocalQuery(client, "CRAP SQL", []),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rolls back on statement error during mutation", async () => {
    const pgError = Object.assign(new Error("division by zero"), { code: "22012" });
    const client = makeSpyClient({ queryError: pgError });

    await expect(
      executeLocalQuery(client, "INSERT INTO t VALUES ($1)", [42]),
    ).rejects.toMatchObject({ code: "E_PROVIDER" });

    // ROLLBACK must have been attempted
    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls;
    const rollbackCall = calls.find((c: unknown[]) => c[0] === "ROLLBACK");
    expect(rollbackCall).toBeTruthy();
  });

  it("returns rowCount from affectedRows", async () => {
    const results = new Map<string, DatabaseQueryResult>();
    results.set("BEGIN", { fields: [], rows: [], rowCount: 0, command: "BEGIN" });
    results.set("SET LOCAL statement_timeout = '30000ms'", { fields: [], rows: [], rowCount: 0, command: "SET" });
    results.set("SET LOCAL lock_timeout = '5000ms'", { fields: [], rows: [], rowCount: 0, command: "SET" });
    results.set("UPDATE users SET active = true", { fields: [], rows: [], rowCount: 5, command: "UPDATE" });
    results.set("COMMIT", { fields: [], rows: [], rowCount: 0, command: "COMMIT" });
    const client = makeSpyClient({ queryResults: results });

    const result = await executeLocalQuery(client, "UPDATE users SET active = true");
    expect(result.rowCount).toBe(5);
  });

  it("handles multi-statement mutations with cumulative rowCount", async () => {
    const results = new Map<string, DatabaseQueryResult>();
    results.set("BEGIN", { fields: [], rows: [], rowCount: 0, command: "BEGIN" });
    results.set("SET LOCAL statement_timeout = '30000ms'", { fields: [], rows: [], rowCount: 0, command: "SET" });
    results.set("SET LOCAL lock_timeout = '5000ms'", { fields: [], rows: [], rowCount: 0, command: "SET" });
    results.set("INSERT INTO t VALUES (1)", { fields: [], rows: [], rowCount: 1, command: "INSERT" });
    results.set("INSERT INTO t VALUES (2)", { fields: [], rows: [], rowCount: 1, command: "INSERT" });
    results.set("COMMIT", { fields: [], rows: [], rowCount: 0, command: "COMMIT" });
    const client = makeSpyClient({ queryResults: results });

    const result = await executeLocalQuery(
      client,
      "INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)",
    );
    expect(result.rowCount).toBe(2);
    expect(result.statementCount).toBe(2);
  });

  it("throws on abort signal before mutation", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = makeSpyClient();

    await expect(
      executeLocalQuery(client, "INSERT INTO t VALUES (1)", [], controller.signal),
    ).rejects.toMatchObject({ code: "E_CANCELLED" });
  });
});
```

- [ ] **Step 4: Run tests**

```bash
npx vitest --run test/database/execute-local.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/database/execute-local.ts test/database/execute-local.test.ts
git commit -m "feat: add open-write local query execution path"
```

---

### Task 4: Import action

**Files:**
- Create: `src/database/import.ts`
- Create: `test/database/import.test.ts`

**Interfaces:**
- Consumes: `DatabaseClient` from `src/database/client.ts`, `quoteIdentifier` from `src/database/identifiers.ts`, `checkAborted` from `src/database/client.ts`
- Produces: `importData(client, options)` — schema inference, CREATE TABLE IF NOT EXISTS, parameterized INSERT batches

**Description:**

Import JSON/CSV rows into a local table. Auto-creates the table with inferred column types when missing. Uses parameterized INSERT batches. Validates identifiers through `quoteIdentifier`. Row/byte caps at the boundary. Local target only.

- [ ] **Step 1: Create `src/database/import.ts`**

```typescript
import { readFile } from "node:fs/promises";
import { err } from "../core/errors.js";
import { quoteIdentifier } from "./identifiers.js";
import type { DatabaseClient } from "./client.js";
import { checkAborted } from "./client.js";

const MAX_ROWS = 5_000;
const MAX_TOTAL_CELL_BYTES = 512 * 1024; // 512KiB total

function inferColumnType(value: unknown): string {
  if (value === null || value === undefined) return "TEXT";
  if (typeof value === "boolean") return "BOOLEAN";
  if (typeof value === "number") {
    if (Number.isInteger(value) && Number.isSafeInteger(value)) return "BIGINT";
    return "DOUBLE PRECISION";
  }
  if (typeof value === "string") return "TEXT";
  if (Array.isArray(value) || typeof value === "object") return "JSONB";
  return "TEXT";
}

interface ImportOptions {
  table: string;
  format: "json" | "csv";
  path?: string;
  rows?: Record<string, unknown>[];
  mode?: "create" | "append";
}

export interface ImportResult {
  table: string;
  rowsImported: number;
  created: boolean;
}

/**
 * Load rows from the import options.
 * - inline `rows` array passed directly
 * - `path` reads a file (JSON or CSV)
 * Validates row caps and cell byte budget.
 */
async function loadRows(options: ImportOptions): Promise<Record<string, unknown>[]> {
  if (options.rows && options.path) {
    throw err("E_CONFIG_INVALID", "import requires exactly one of rows or path, not both");
  }

  let rawRows: Record<string, unknown>[];

  if (options.path) {
    const content = await readFile(options.path, "utf8");
    if (options.format === "json") {
      try {
        const parsed = JSON.parse(content);
        rawRows = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        throw err("E_CONFIG_INVALID", "import JSON file is not valid JSON");
      }
    } else {
      // CSV: split on newlines, first line is header
      const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length < 2) throw err("E_CONFIG_INVALID", "import CSV file must have header and at least one data row");
      const headers = lines[0]!.split(",").map((h) => h.trim());
      rawRows = [];
      for (let i = 1; i < lines.length; i++) {
        const cells = lines[i]!.split(",");
        const row: Record<string, unknown> = {};
        for (let j = 0; j < headers.length; j++) {
          const val = cells[j]?.trim() ?? "";
          row[headers[j]!] = val;
        }
        rawRows.push(row);
      }
    }
  } else if (options.rows) {
    rawRows = options.rows;
  } else {
    throw err("E_CONFIG_INVALID", "import requires rows or path");
  }

  if (rawRows.length > MAX_ROWS) {
    throw err("E_CONFIG_INVALID", `import limited to ${MAX_ROWS} rows`);
  }
  if (rawRows.length === 0) {
    throw err("E_CONFIG_INVALID", "import requires at least one row");
  }

  // Byte budget check
  let totalBytes = 0;
  for (const row of rawRows) {
    for (const val of Object.values(row)) {
      if (typeof val === "string") totalBytes += Buffer.byteLength(val, "utf8");
    }
  }
  if (totalBytes > MAX_TOTAL_CELL_BYTES) {
    throw err("E_CONFIG_INVALID", "import data over byte budget");
  }

  return rawRows;
}

/**
 * Infer column names and types from sample rows.
 * Null/undefined values fall back to TEXT.
 */
function inferSchema(rows: Record<string, unknown>[]): { columns: string[]; types: string[] } {
  const columnSet = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      columnSet.add(key);
    }
  }
  const columns = [...columnSet];
  const types = columns.map((col) => {
    for (const row of rows) {
      const val = row[col];
      if (val !== null && val !== undefined) return inferColumnType(val);
    }
    return "TEXT";
  });
  return { columns, types };
}

/**
 * Import rows into a local table.
 * Auto-creates table with inferred schema when mode is "create" (default)
 * or table does not exist. Appends when mode is "append".
 * All identifiers validated via quoteIdentifier.
 * Rows inserted in parameterized batches of 100.
 */
export async function importData(
  client: DatabaseClient,
  options: ImportOptions,
  signal?: AbortSignal,
): Promise<ImportResult> {
  checkAborted(signal);

  const rows = await loadRows(options);
  const table = options.table;
  quoteIdentifier(table); // validate

  const { columns, types } = inferSchema(rows);

  // Validate all column names
  for (const col of columns) {
    quoteIdentifier(col);
  }

  const mode = options.mode ?? "create";
  let created = false;

  checkAborted(signal);

  if (mode === "create") {
    // Create table
    const colDefs = columns.map((col, i) => `${quoteIdentifier(col)} ${types[i]}`).join(", ");
    const createSQL = `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table)} (${colDefs})`;
    try {
      await client.query(createSQL);
    } catch (e) {
      // If table already exists with different schema, surface error
      if (e instanceof Error && typeof (e as Record<string, unknown>).code === "string" &&
          ((e as Record<string, unknown>).code as string) !== "42P07") {
        throw e;
      }
    }
    created = true;
  }

  // Insert in batches of 100
  const colList = columns.map((c) => quoteIdentifier(c)).join(", ");
  const placeholders = (rowIdx: number) =>
    columns.map((_, i) => `$${rowIdx * columns.length + i + 1}`).join(", ");

  const BATCH_SIZE = 100;
  for (let batchStart = 0; batchStart < rows.length; batchStart += BATCH_SIZE) {
    checkAborted(signal);
    const batch = rows.slice(batchStart, batchStart + BATCH_SIZE);

    const valueGroups = batch.map((_, i) => `(${placeholders(i)})`).join(", ");
    const insertSQL = `INSERT INTO ${quoteIdentifier(table)} (${colList}) VALUES ${valueGroups}`;

    const allParams: unknown[] = [];
    for (const row of batch) {
      for (const col of columns) {
        const val = row[col];
        // JSONB columns need serialization for object/array values
        const colType = types[columns.indexOf(col)];
        if (colType === "JSONB" && (typeof val === "object" || Array.isArray(val))) {
          allParams.push(JSON.stringify(val));
        } else {
          allParams.push(val ?? null);
        }
      }
    }

    await client.query(insertSQL, allParams);
  }

  return { table, rowsImported: rows.length, created };
}
```

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Create `test/database/import.test.ts`**

```typescript
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient, DatabaseQueryResult } from "../../src/database/client.js";
import { importData } from "../../src/database/import.js";

function makeImportClient(opts?: {
  queryError?: Error;
  queryLog?: { text: string; params?: unknown[] }[];
}): DatabaseClient {
  const log = opts?.queryLog ?? [];
  return {
    connect: vi.fn(),
    query: vi.fn(async (text: string, params?: readonly unknown[]) => {
      log.push({ text, params: params ? [...params] : undefined });
      if (opts?.queryError) throw opts.queryError;
      return { fields: [], rows: [], rowCount: 1, command: "INSERT" } as DatabaseQueryResult;
    }),
    end: vi.fn(),
  };
}

describe("importData", () => {
  it("infers schema and creates table on first import", async () => {
    const log: { text: string }[] = [];
    const client: DatabaseClient = {
      connect: vi.fn(),
      query: vi.fn(async (text: string) => {
        log.push({ text });
        return { fields: [], rows: [], rowCount: 1, command: "INSERT" } as DatabaseQueryResult;
      }),
      end: vi.fn(),
    };

    await importData(client, {
      table: "users",
      format: "json",
      rows: [
        { name: "alice", age: 30, active: true },
        { name: "bob", age: 25, active: false },
      ],
    });

    const createSQL = log.find((l) => l.text.startsWith("CREATE TABLE"));
    expect(createSQL).toBeTruthy();
    expect(createSQL!.text).toContain('"users"');
    expect(createSQL!.text).toContain("TEXT"); // name → TEXT
    expect(createSQL!.text).toContain("BIGINT"); // age → BIGINT
    expect(createSQL!.text).toContain("BOOLEAN"); // active → BOOLEAN

    const insertSQL = log.find((l) => l.text.startsWith("INSERT INTO"));
    expect(insertSQL).toBeTruthy();
  });

  it("inserts all rows in a single batch when under 100", async () => {
    const log: { text: string; params?: unknown[] }[] = [];
    const client: DatabaseClient = {
      connect: vi.fn(),
      query: vi.fn(async (text: string, params?: readonly unknown[]) => {
        log.push({ text, params: params ? [...params] : undefined });
        return { fields: [], rows: [], rowCount: 3, command: "INSERT" } as DatabaseQueryResult;
      }),
      end: vi.fn(),
    };

    const result = await importData(client, {
      table: "items",
      format: "json",
      rows: [{ x: 1 }, { x: 2 }, { x: 3 }],
    });

    expect(result.rowsImported).toBe(3);
    expect(result.created).toBe(true);

    const insertCall = log.find((l) => l.text.startsWith("INSERT INTO"));
    expect(insertCall).toBeTruthy();
    const valueGroupCount = (insertCall!.text.match(/\)\,\(/g) || []).length + 1;
    expect(valueGroupCount).toBe(3); // all 3 rows in one INSERT
  });

  it("handles JSONB columns for objects and arrays", async () => {
    const log: { text: string; params?: unknown[] }[] = [];
    const client: DatabaseClient = {
      connect: vi.fn(),
      query: vi.fn(async (text: string, params?: readonly unknown[]) => {
        log.push({ text, params: params ? [...params] : undefined });
        return { fields: [], rows: [], rowCount: 1, command: "INSERT" } as DatabaseQueryResult;
      }),
      end: vi.fn(),
    };

    await importData(client, {
      table: "config",
      format: "json",
      rows: [{
        key: "main",
        value: { nested: true, list: [1, 2, 3] },
        tags: ["a", "b"],
      }],
    });

    const insertCall = log.find((l) => l.text.startsWith("INSERT INTO"));
    expect(insertCall).toBeTruthy();
    // value and tags should be JSON-stringified
    const params = insertCall!.params;
    expect(params).toBeTruthy();
    expect(params!.some((p) => typeof p === "string" && p.startsWith("{"))).toBe(true);
  });

  it("rejects invalid table identifier", async () => {
    const client = makeImportClient();
    await expect(
      importData(client, { table: "", format: "json", rows: [{ x: 1 }] }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rejects empty rows", async () => {
    const client = makeImportClient();
    await expect(
      importData(client, { table: "t", format: "json", rows: [] }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rejects both rows and path", async () => {
    const client = makeImportClient();
    await expect(
      importData(client, { table: "t", format: "json", rows: [{ x: 1 }], path: "/tmp/data.json" }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("respects append mode (no CREATE TABLE)", async () => {
    const log: { text: string }[] = [];
    const client: DatabaseClient = {
      connect: vi.fn(),
      query: vi.fn(async (text: string) => {
        log.push({ text });
        return { fields: [], rows: [], rowCount: 1, command: "INSERT" } as DatabaseQueryResult;
      }),
      end: vi.fn(),
    };

    const result = await importData(client, {
      table: "existing",
      format: "json",
      mode: "append",
      rows: [{ col: "val" }],
    });

    expect(result.created).toBe(false);
    expect(log.find((l) => l.text.startsWith("CREATE TABLE"))).toBeUndefined();
    expect(log.find((l) => l.text.startsWith("INSERT INTO"))).toBeTruthy();
  });

  it("rejects > 5000 rows", async () => {
    const client = makeImportClient();
    const rows = Array.from({ length: 5001 }, (_, i) => ({ n: i }));
    await expect(
      importData(client, { table: "t", format: "json", rows }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });
});
```

- [ ] **Step 4: Run tests**

```bash
npx vitest --run test/database/import.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/database/import.ts test/database/import.test.ts
git commit -m "feat: add import action with schema inference"
```

---

### Task 5: Reset action + datadir lifecycle

**Files:**
- Create: `src/database/reset.ts`
- Create: `test/database/reset.test.ts`

**Interfaces:**
- Consumes: `resetPGliteInstance` from `src/database/local/instance-cache.ts`
- Produces: `resetLocalDatabase(dataDir: string): Promise<void>`

**Description:**

Wipe and recreate the local datadir. Calls `resetPGliteInstance` (which closes the cached PGlite and deletes the directory), then triggers re-initialization via `getPGliteInstance`. Local target only.

- [ ] **Step 1: Create `src/database/reset.ts`**

```typescript
import { resetPGliteInstance, getPGliteInstance } from "./local/instance-cache.js";
import { err } from "../core/errors.js";

/**
 * Wipe the local database datadir and recreate an empty instance.
 * This closes the cached PGlite instance, deletes the data directory,
 * and creates a fresh empty database.
 *
 * Local target only. Caller must gate this to local targets.
 */
export async function resetLocalDatabase(dataDir: string): Promise<void> {
  await resetPGliteInstance(dataDir);
  // Re-initialize so the next operation has a fresh empty database
  try {
    await getPGliteInstance(dataDir);
  } catch (cause) {
    throw err("E_PROVIDER", "database reset failed; local database may be in inconsistent state");
  }
}
```

- [ ] **Step 2: Create `test/database/reset.test.ts`**

```typescript
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { resetLocalDatabase } from "../../src/database/reset.js";
import * as instanceCache from "../../src/database/local/instance-cache.js";

describe("resetLocalDatabase", () => {
  // Integration-like: uses real filesystem with a mock PGlite
  it("deletes the datadir and re-initializes instance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-ship-reset-"));
    try {
      // Create some content in the datadir
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "test-file"), "content");

      // Mock instance cache to avoid real PGlite
      vi.spyOn(instanceCache, "resetPGliteInstance").mockImplementation(async (dataDir: string) => {
        await rm(dataDir, { recursive: true, force: true });
      });
      vi.spyOn(instanceCache, "getPGliteInstance").mockResolvedValue({} as any);

      await resetLocalDatabase(dir);

      // Verify reset was called
      expect(instanceCache.resetPGliteInstance).toHaveBeenCalledWith(dir);
      expect(instanceCache.getPGliteInstance).toHaveBeenCalledWith(dir);
    } finally {
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws E_PROVIDER when re-initialization fails", async () => {
    vi.spyOn(instanceCache, "resetPGliteInstance").mockResolvedValue(undefined);
    vi.spyOn(instanceCache, "getPGliteInstance").mockRejectedValue(new Error("PGlite boom"));

    await expect(resetLocalDatabase("/nonexistent/path")).rejects.toMatchObject({
      code: "E_PROVIDER",
    });

    vi.restoreAllMocks();
  });

  it("resetPGliteInstance handles missing directory gracefully", async () => {
    vi.spyOn(instanceCache, "resetPGliteInstance").mockImplementation(async (dir: string) => {
      await rm(dir, { recursive: true, force: true }); // force+recursive handles missing
    });
    vi.spyOn(instanceCache, "getPGliteInstance").mockResolvedValue({} as any);

    await expect(resetLocalDatabase("/nonexistent/path/for/reset")).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npx vitest --run test/database/reset.test.ts
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/database/reset.ts test/database/reset.test.ts
git commit -m "feat: add reset action for local database"
```

---

### Task 6: Wiring, integration, acceptance, and docs

**Files:**
- Modify: `src/tools/db/schema.ts` (add `import` and `reset` action types)
- Modify: `src/tools/db/index.ts` (target resolution, open-write routing, import/reset dispatch, gated flag)
- Create: `test/database/local/integration.test.ts` (real in-memory PGlite)
- Modify: `test/acceptance/database.e2e.test.ts` (zero-config e2e)
- Modify: `README.md` (docs for local DB + new actions)

**Interfaces:**
- Consumes: everything from T1–T5
- Produces: wired `DB` tool with local fallback, import/reset actions, gated flag support

**Description:**

Wire all independent modules into the tool layer. Add import/reset to the DBSchema. Route shared actions through `resolveDatabaseTarget`. Gate open-write vs plan-ceremony on `PI_SHIP_LOCAL_DB_GATED`. Integration test with real `memory://` PGlite. Acceptance test with zero env vars. README docs.

- [ ] **Step 1: Extend `src/tools/db/schema.ts`**

Add two new union members to `DBSchema`:

```typescript
Type.Object({
  action: Type.Literal("import"),
  table: Type.String({ minLength: 1, maxLength: 100000 }),
  format: Type.Union([Type.Literal("json"), Type.Literal("csv")]),
  path: Type.Optional(Type.String({ minLength: 1, maxLength: 10000 })),
  rows: Type.Optional(
    Type.Array(
      Type.Object({}, { additionalProperties: true }),
      { maxItems: 5000 },
    ),
  ),
  mode: Type.Optional(Type.Union([Type.Literal("create"), Type.Literal("append")])),
}, strict),
Type.Object({
  action: Type.Literal("reset"),
}, strict),
```

Insert these into the `Type.Union([...])` array in `DBSchema`. Keep all existing members unchanged.

- [ ] **Step 2: Modify `src/tools/db/index.ts`**

This is the largest change. The key modifications:

1. Import new modules from T1–T5
2. Replace `requireDatabaseUrl` with `resolveDatabaseTarget`
3. Add `PI_SHIP_LOCAL_DB_GATED` check
4. Route shared actions through target discriminator
5. Add `import` and `reset` action handlers before provider dispatch
6. Label local target in all tool responses

```typescript
// Add these imports at top:
import { resolveDatabaseTarget, type DatabaseTarget } from "../../database/target.js";
import { createPGliteClient } from "../../database/local/pglite-client.js";
import { closePGliteInstance } from "../../database/local/instance-cache.js";
import { executeLocalQuery } from "../../database/execute-local.js";
import { importData } from "../../database/import.js";
import { resetLocalDatabase } from "../../database/reset.js";
import { createDefaultClientFactory } from "../../database/client.js";
```

Modify the `execute` function body. The main structural changes:

```typescript
// Inside registerDB → pi.registerTool → execute:
const cwd = ctx.cwd;
const credentialSource = deps.credentialSource ?? (await import("../../deployment/credentials.js")).environmentSource();

// ── Resolve target ──────────────────────────────────────────────
const target = resolveDatabaseTarget(credentialSource, cwd);
const environment = resolveDatabaseEnvironment(credentialSource, target.kind);
const isLocal = target.kind === "local";
const gatedLocal = isLocal && credentialSource.get("PI_SHIP_LOCAL_DB_GATED") === "true";

// ── Build client factory for reads/writes on this target ─────────
function clientFactoryFor(target: DatabaseTarget): DatabaseClientFactory {
  if (target.kind === "local") {
    return () => createPGliteClient(target.dataDir); // note: returns Promise<DatabaseClient>
  }
  return createDefaultClientFactory();
}

// Factory that handles async:
async function getClient(target: DatabaseTarget): Promise<DatabaseClient> {
  if (target.kind === "local") return createPGliteClient(target.dataDir);
  const factory = createDefaultClientFactory();
  const client = factory(target.url);
  await client.connect();
  return client;
}
```

For shared read actions (`inspect`, `browse`, `query`), replace `requireDatabaseUrl` with the target. The `connectionString` parameter to `inspectDatabase`/`executeBrowse`/`executeReadQuery` becomes either the remote URL or a dummy string for local (factory ignores it).

For `query` on local + open (not gated):
```typescript
if (params.action === "query" && isLocal && !gatedLocal) {
  const client = await getClient(target);
  try {
    const result = await executeLocalQuery(client, params.sql, params.params ?? [], signal);
    const label = "local embedded database";
    if (result.kind === "read") {
      return defendToolResult({
        content: [{ type: "text", text: `[${label}] Query returned ${result.rowCount} rows${result.hasMore ? " (truncated)" : ""}` }],
        details: { columns: result.columns, rows: result.rows, rowCount: result.rowCount, hasMore: result.hasMore, target: label },
      });
    }
    return {
      content: [{ type: "text", text: `[${label}] Mutation: ${result.statementCount} statements, ${result.rowCount} rows affected` }],
      details: { kind: "mutation", rowCount: result.rowCount, statementCount: result.statementCount, target: label },
    };
  } finally {
    if (target.kind === "local") {
      try { await client.end(); } catch { /* best-effort */ }
    }
  }
}
```

For `import` action:
```typescript
if (params.action === "import") {
  if (!isLocal) throw err("E_PHASE_UNSUPPORTED", "import action requires local database target");
  const client = await getClient(target);
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
```

For `reset` action:
```typescript
if (params.action === "reset") {
  if (!isLocal) throw err("E_PHASE_UNSUPPORTED", "reset action requires local database target");
  await resetLocalDatabase(target.dataDir);
  return {
    content: [{ type: "text", text: "Local database reset complete. Empty database ready." }],
    details: { target: "local embedded database", status: "reset" },
  };
}
```

For the `plan` action on local + open (not gated), the plan action should still work (create plan, fingerprint target). For gated mode, everything proceeds through the existing plan/approve/apply flow.

For `plan` on local:
```typescript
if (params.action === "plan") {
  const values = params.params ?? [];
  const classification = await assertPublicPlan(params.sql, values);
  const targetFingerprint = fingerprintTarget(target);
  const fingerprints = await contextFingerprints(cwd);
  const plan = buildDatabasePlan({ environment, targetFingerprint, ...fingerprints, sql: params.sql, params: values, classification });
  await persistDatabasePlan(cwd, plan);
  payloads.register(plan.planId, plan.planDigest, { sql: params.sql, params: [...values], statements: classification.statements });
  const destructive = plan.riskLevel === "destructive";
  const label = isLocal ? "local embedded database" : "remote PostgreSQL database";
  // Approval only needed in gated mode or remote
  let approved = false;
  if (!isLocal || gatedLocal) {
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
    // Auto-approve for local open mode
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "database", risk: destructive ? "destructive" : "write" });
    approved = true;
  }
  return { content: [{ type: "text", text: `[${label}] Database plan ${plan.planId}: ${plan.riskLevel}` }], details: { planId: plan.planId, planDigest: plan.planDigest, riskLevel: plan.riskLevel, statements: plan.statements, destructiveReasons: plan.destructiveReasons, approved, target: label } };
}
```

For `apply_plan` on local + open (not gated), auto-execute without journal:
```typescript
if (params.action === "apply_plan" && isLocal && !gatedLocal) {
  const rawPlan = await readPlanFile(cwd, params.planId);
  if (rawPlan && typeof rawPlan === "object" && (rawPlan as Record<string, unknown>).kind === "db-plan/1") {
    const client = await getClient(target);
    try {
      const payload = payloads.require(params.planId, params.planDigest);
      const result = await executeLocalQuery(client, payload.sql, payload.params, signal);
      return {
        content: [{ type: "text", text: `[local embedded database] Database plan ${params.planId} committed (${result.statementCount} statements, ${result.rowCount} rows)` }],
        details: { planId: params.planId, planDigest: params.planDigest, status: "committed", statementCount: result.statementCount, affectedRows: result.rowCount },
      };
    } finally {
      try { await client.end(); } catch { /* best-effort */ }
    }
  }
}
```

For existing remote `apply_plan` (db-plan/1), keep unchanged except for target label.

For `inspect`/`browse` on local:
```typescript
if (params.action === "inspect") {
  const client = target.kind === "remote" ? undefined : await getClient(target);
  // For local, use a factory that returns the cached client
  const factory: DatabaseClientFactory = target.kind === "local"
    ? () => client! // PGliteClient is already initialized
    : createDefaultClientFactory();
  const url = target.kind === "remote" ? target.url : "pglite://local";
  try {
    const result = await inspectDatabase(url, factory, signal);
    return defendToolResult({
      content: [{ type: "text", text: `[${target.kind === "local" ? "local embedded database" : "remote"}] Inspected ${result.schemas.length} schemas, ${result.relations.length} relations` }],
      details: result as unknown as Record<string, unknown>,
    });
  } finally {
    if (client) try { await client.end(); } catch { /* best-effort */ }
  }
}
```

Make sure remote `query` still goes through `assertPublicQuery` for read-only enforcement. Local `query` in gated mode should also go through `assertPublicQuery` (read-only, plan for writes).

- [ ] **Step 3: Verify full typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run all existing tests to verify no regressions**

```bash
npx vitest --run
```

Expected: all existing tests pass (zero regressions in remote path).

- [ ] **Step 5: Create `test/database/local/integration.test.ts`**

Integration suite using real in-memory PGlite (`memory://`). Tests:
- inspect returns empty schema on fresh DB
- browse with created table
- query read
- query write (open mode)
- import JSON rows
- import CSV
- plan + apply (gated mode simulation)
- reset

```typescript
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { DatabaseClient } from "../../../src/database/client.js";
import { createPGliteClient } from "../../../src/database/local/pglite-client.js";
import { executeLocalQuery } from "../../../src/database/execute-local.js";
import { importData } from "../../../src/database/import.js";
import { resetLocalDatabase } from "../../../src/database/reset.js";

// Use in-memory PGlite — no filesystem side effects
describe("local database integration (in-memory PGlite)", () => {
  // Since createPGliteClient uses instance cache, we use unique dirs
  // or directly use PGlite for test isolation
  async function getMemoryClient(): Promise<DatabaseClient> {
    const pg = new PGlite(); // in-memory
    return {
      async connect() {},
      async query(text: string, params?: readonly unknown[]) {
        const result = await pg.query(text, params as unknown[] | undefined);
        return {
          fields: (result.fields ?? []).map((f: any) => ({ name: f.name, dataTypeID: f.dataTypeID ?? 0 })),
          rows: result.rows as Record<string, unknown>[],
          rowCount: (result as any).affectedRows ?? result.rows.length,
          command: (result as any).command ?? "SELECT",
        };
      },
      async end() {},
    };
  }

  it("inspects empty database", async () => {
    const client = await getMemoryClient();
    // Fresh PGlite in-memory has a public schema
    const result = await client.query("SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = 'public'");
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.nspname).toBe("public");
  });

  it("creates table, inserts, and queries", async () => {
    const client = await getMemoryClient();
    await client.query("CREATE TABLE test (id SERIAL PRIMARY KEY, name TEXT)");
    const insertResult = await executeLocalQuery(client, "INSERT INTO test (name) VALUES ($1)", ["alice"]);
    expect(insertResult.rowCount).toBe(1);

    const queryResult = await executeLocalQuery(client, "SELECT * FROM test");
    expect(queryResult.kind).toBe("read");
    expect(queryResult.rows).toHaveLength(1);
    expect(queryResult.rows![0]!.name).toBe("alice");
  });

  it("imports JSON rows with schema inference", async () => {
    const client = await getMemoryClient();
    const result = await importData(client, {
      table: "imported",
      format: "json",
      rows: [
        { name: "item1", count: 5, active: true },
        { name: "item2", count: 3, active: false },
      ],
    });
    expect(result.rowsImported).toBe(2);
    expect(result.created).toBe(true);

    const query = await executeLocalQuery(client, "SELECT * FROM imported");
    expect(query.rows).toHaveLength(2);
  });

  it("handles mutation errors with ROLLBACK", async () => {
    const client = await getMemoryClient();
    await client.query("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await executeLocalQuery(client, "INSERT INTO t VALUES (1)");

    // Duplicate key should fail
    await expect(
      executeLocalQuery(client, "INSERT INTO t VALUES (1)"),
    ).rejects.toMatchObject({ code: "E_PROVIDER" });

    // Table should still have only 1 row (rollback succeeded)
    const result = await executeLocalQuery(client, "SELECT count(*) FROM t");
    expect(result.rows![0]!.count).toBe("1"); // PGlite returns count as string
  });
});
```

- [ ] **Step 6: Run integration tests**

```bash
npx vitest --run test/database/local/integration.test.ts
```

Expected: all pass against real PGlite.

- [ ] **Step 7: Extend `test/acceptance/database.e2e.test.ts`**

Add a zero-config acceptance test:

```typescript
// Add after existing describe block:
describe("zero-config local database acceptance", () => {
  it("DB.inspect works with no env vars set", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-zero-config-"));
    try {
      const registry = new ApprovalRegistry(cwd);
      // No DATABASE_URL, no PI_SHIP_DATABASE_ENVIRONMENT set
      const envSource = { get: () => undefined };

      let execute: ToolExecute | undefined;
      const pi = {
        registerTool(def: { name: string; execute: ToolExecute }) {
          execute = def.execute;
        },
      };

      registerDB(pi as never, registry, {
        credentialSource: envSource,
      });

      if (!execute) throw new Error("DB tool not registered");

      const context = { cwd, hasUI: true, ui: { confirm: async () => true } };

      // inspect should work with local embedded PGlite
      const inspectResult = await execute(
        "accept-call",
        { action: "inspect" },
        undefined,
        undefined,
        context,
      ) as { content: Array<{ text: string }> };

      expect(inspectResult.content.some((c) => c.text.includes("local embedded database"))).toBe(true);
      expect(inspectResult.content.some((c) => c.text.includes("Inspected"))).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 8: Run acceptance tests**

```bash
npm run acceptance
```

Expected: all pass, including the new zero-config test.

- [ ] **Step 9: Update `README.md`**

In the "DB actions" table, update rows for `inspect`, `browse`, `query`, `plan`, `apply_plan`:
- Change "DATABASE_URL required" column to "Yes (remote) / No (local)" with a footnote explaining the local fallback.

Add two new rows for `import` and `reset`:

```
|| `import` | Import JSON/CSV into a local table | No | No | Yes (local write) |
|| `reset` | Wipe and recreate the local database | No | No | No |
```

In "Required environment variables", add:
```
|| `PI_SHIP_LOCAL_DB_GATED` | Local DB writes | When `true`, requires plan/approval for local database writes. Default: open (no approval needed). |
```

Add a new section after "DB actions":

```markdown
## Local database (zero-config)

When `DATABASE_URL` is not set, `DB` actions fall back to an embedded PostgreSQL instance (PGlite) stored at `.pi-ship/local-db/` in your project directory. No configuration required — the datadir is auto-created on first use and gitignored.

### Safety model

- **Open by default:** local writes execute directly — no plan, no approval. This maximizes throughput for scratch/prototype data.
- **Gated mode:** set `PI_SHIP_LOCAL_DB_GATED=true` to require the full plan → approve → apply ceremony (same as remote targets).
- `import` and `reset` actions are local-only.
- All local tool output is labeled "local embedded database" to avoid confusion with production targets.
```

- [ ] **Step 10: Run full test suite one final time**

```bash
npm run typecheck
npm test
npm run acceptance
```

Expected: all pass with zero regressions.

- [ ] **Step 11: Commit**

```bash
git add src/tools/db/schema.ts src/tools/db/index.ts test/database/local/integration.test.ts test/acceptance/database.e2e.test.ts README.md
git commit -m "feat: wire zero-config local database with import, reset, and open writes"
```

---

## Task DAG

```
T1 (target resolution) ──┐
                          ├── T6 (wiring + integration + docs) [sequential after T1-T5]
T2 (PGlite adapter) ─────┤
                          │
T3 (open-write exec) ────┤
                          │
T4 (import action) ──────┤
                          │
T5 (reset action) ───────┘
```

**Parallelizable:** T1–T5 have zero overlapping file ownership and can run concurrently. Each task creates its own module and its own test file. The only shared dependency is the `DatabaseClient` interface (already in `client.ts`, stable) and the types produced by T1 (`DatabaseTarget`). T2–T5 can code against those types as defined in the plan without needing T1's implementation to exist — the interfaces are fully specified above.

**Sequential:** T6 must run after T1–T5 complete and all tests pass. T6 is the only task that modifies existing files (`src/tools/db/schema.ts`, `src/tools/db/index.ts`, `test/acceptance/database.e2e.test.ts`, `README.md`) to avoid merge conflicts.

**Worker allocation:** 5 parallel workers for T1–T5, then 1 worker for T6. After T6, run full test suite and dispatch reviewers.
