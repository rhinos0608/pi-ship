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
      if (results.has(text)) return results.get(text)!;
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
    const results = new Map<string, DatabaseQueryResult>();
    results.set("BEGIN", { fields: [], rows: [], rowCount: 0, command: "BEGIN" });
    results.set("SET LOCAL statement_timeout = '30000ms'", { fields: [], rows: [], rowCount: 0, command: "SET" });
    results.set("SET LOCAL lock_timeout = '5000ms'", { fields: [], rows: [], rowCount: 0, command: "SET" });
    results.set("ROLLBACK", { fields: [], rows: [], rowCount: 0, command: "ROLLBACK" });
    const client = makeSpyClient({ queryResults: results, queryError: pgError });

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
    results.set(" INSERT INTO t VALUES (2)", { fields: [], rows: [], rowCount: 1, command: "INSERT" });
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
