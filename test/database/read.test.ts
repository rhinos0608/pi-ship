import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient, DatabaseClientFactory, DatabaseQueryResult } from "../../src/database/client.js";
import { executeReadQuery } from "../../src/database/read.js";

interface SpyClientOverrides {
  fetchRows?: Record<string, unknown>[];
  fetchFields?: Array<{ name: string; dataTypeID: number }>;
  fetchError?: Error;
  connectError?: Error;
  beginError?: Error;
  workError?: Error;
}

/** Create a spy client whose query matches expected transaction order. */
function makeSpyClient(overrides?: SpyClientOverrides): DatabaseClient {
  const fetchRows = overrides?.fetchRows ?? [{ col: "val1" }];
  const fetchFields = overrides?.fetchFields ?? [{ name: "col", dataTypeID: 25 }];

  return {
    connect: vi.fn<() => Promise<void>>().mockImplementation(async () => {
      if (overrides?.connectError) throw overrides.connectError;
    }),
    query: vi.fn<(text: string, params?: readonly unknown[]) => Promise<DatabaseQueryResult>>().mockImplementation(async (text: string) => {
      if (overrides?.beginError && text === "BEGIN READ ONLY") throw overrides.beginError;
      if (overrides?.workError && (text.startsWith("DECLARE") || text.startsWith("FETCH"))) throw overrides.workError;
      if (text === "BEGIN READ ONLY") return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (text.startsWith("SET LOCAL")) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      if (text.startsWith("DECLARE")) return { fields: [], rows: [], rowCount: 0, command: "DECLARE" };
      if (text.startsWith("FETCH FORWARD")) return { fields: fetchFields, rows: fetchRows, rowCount: fetchRows.length, command: "FETCH" };
      if (text.startsWith("CLOSE")) return { fields: [], rows: [], rowCount: 0, command: "CLOSE" };
      if (text === "ROLLBACK") return { fields: [], rows: [], rowCount: 0, command: "ROLLBACK" };
      return { fields: [], rows: [], rowCount: 0, command: "SELECT" };
    }),
    end: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

interface SpyFactoryResult {
  factory: DatabaseClientFactory;
  client: DatabaseClient;
}

/** Create a spy factory that returns the given spy client. */
function makeSpyFactory(client?: DatabaseClient): SpyFactoryResult {
  const spyClient = client ?? makeSpyClient();
  const factory = vi.fn<(connectionString: string) => DatabaseClient>().mockReturnValue(spyClient);
  return { factory, client: spyClient };
}

/** Get the query text array from a client's query mock. */
function queryTexts(client: DatabaseClient): string[] {
  return (client.query as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string);
}

describe("executeReadQuery", () => {
  it("executes full transaction sequence: factory->connect->BEGIN->SET->DECLARE->FETCH->CLOSE->ROLLBACK->end", async () => {
    const { factory, client } = makeSpyFactory();
    const result = await executeReadQuery("postgres://localhost/test", factory, {
      sql: "SELECT 1",
      limit: 100,
    });

    // One factory call with connection string
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith("postgres://localhost/test");

    // Connect once
    expect(client.connect).toHaveBeenCalledOnce();

    // Exact transaction order
    const texts = queryTexts(client);
    expect(texts[0]).toBe("BEGIN READ ONLY");
    expect(texts[1]).toBe("SET LOCAL statement_timeout = '5000ms'");
    expect(texts[2]).toBe("SET LOCAL lock_timeout = '1000ms'");
    expect(texts[3]).toMatch(/^DECLARE "_pi_cursor_/);
    expect(texts[4]).toMatch(/^FETCH FORWARD 101 FROM "_pi_cursor_/);
    expect(texts[5]).toMatch(/^CLOSE "_pi_cursor_/);
    expect(texts[6]).toBe("ROLLBACK");

    // End once
    expect(client.end).toHaveBeenCalledOnce();

    // Results
    expect(result.columns).toHaveLength(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rowCount).toBe(1);
    expect(result.hasMore).toBe(false);
  });

  it("returns hasMore=true with rowCount=100 when 101 rows fetched and limit=100", async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({ col: i }));
    const { factory, client } = makeSpyFactory(makeSpyClient({
      fetchRows: rows,
      fetchFields: [{ name: "col", dataTypeID: 23 }],
    }));

    const result = await executeReadQuery("postgres://localhost/test", factory, {
      sql: "SELECT generate_series(1, 101) AS col",
      limit: 100,
    });

    // FETCH asks for 101 (limit+1)
    const texts = queryTexts(client);
    const fetchText = texts.find((t) => t.startsWith("FETCH FORWARD"));
    expect(fetchText).toMatch(/FETCH FORWARD 101/);

    // Results: 100 rows, hasMore=true
    expect(result.rows).toHaveLength(100);
    expect(result.rowCount).toBe(100);
    expect(result.hasMore).toBe(true);
  });

  it("aborts before client creation on invalid SQL", async () => {
    const { factory, client } = makeSpyFactory();
    await expect(executeReadQuery("postgres://localhost/test", factory, {
      sql: "INSERT INTO x VALUES (1)",
    })).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("aborts before client creation on multi-statement SQL", async () => {
    const { factory, client } = makeSpyFactory();
    await expect(executeReadQuery("postgres://localhost/test", factory, {
      sql: "SELECT 1; SELECT 2",
    })).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("maps SQLSTATE 28P01 to E_AUTH_MISSING", async () => {
    const authError = Object.assign(new Error("pg auth failed"), { code: "28P01" });
    const { factory, client } = makeSpyFactory(makeSpyClient({ beginError: authError }));

    await expect(executeReadQuery("postgres://localhost/test", factory, {
      sql: "SELECT 1",
    })).rejects.toMatchObject({ code: "E_AUTH_MISSING" });
    // End called after failure
    expect(client.end).toHaveBeenCalled();
  });

  it("maps SQLSTATE 28000 to E_AUTH_MISSING", async () => {
    const authError = Object.assign(new Error("no auth"), { code: "28000" });
    const { factory, client } = makeSpyFactory(makeSpyClient({ beginError: authError }));

    await expect(executeReadQuery("postgres://localhost/test", factory, {
      sql: "SELECT 1",
    })).rejects.toMatchObject({ code: "E_AUTH_MISSING" });
    expect(client.end).toHaveBeenCalled();
  });

  it("maps SQLSTATE 57014 to E_CANCELLED", async () => {
    const cancelError = Object.assign(new Error("cancelled"), { code: "57014" });
    const { factory, client } = makeSpyFactory(makeSpyClient({ workError: cancelError }));

    await expect(executeReadQuery("postgres://localhost/test", factory, {
      sql: "SELECT 1",
    })).rejects.toMatchObject({ code: "E_CANCELLED" });

    // ROLLBACK attempted
    const texts = queryTexts(client);
    expect(texts).toContain("ROLLBACK");
    expect(client.end).toHaveBeenCalled();
  });

  it("maps SQLSTATE 08XXX to E_PROVIDER retryable", async () => {
    const connError = Object.assign(new Error("connection broken"), { code: "08000" });
    const { factory, client } = makeSpyFactory(makeSpyClient({ connectError: connError }));

    await expect(executeReadQuery("postgres://localhost/test", factory, {
      sql: "SELECT 1",
    })).rejects.toMatchObject({ code: "E_PROVIDER", retryable: true });
    expect(client.end).toHaveBeenCalled();
  });

  it("maps ECONNREFUSED to E_PROVIDER retryable", async () => {
    const connError = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    const { factory, client } = makeSpyFactory(makeSpyClient({ connectError: connError }));

    await expect(executeReadQuery("postgres://localhost/test", factory, {
      sql: "SELECT 1",
    })).rejects.toMatchObject({ code: "E_PROVIDER", retryable: true });
    expect(client.end).toHaveBeenCalled();
  });

  it("calls end (no rollback) on BEGIN query failure", async () => {
    const workerError = new Error("BEGIN failed");
    (workerError as unknown as Record<string, unknown>).code = "XX000";
    const { factory, client } = makeSpyFactory(makeSpyClient({ beginError: workerError as Error & { code: string } }));

    await expect(executeReadQuery("postgres://localhost/test", factory, {
      sql: "SELECT 1",
    })).rejects.toMatchObject({ code: "E_PROVIDER" });

    // No ROLLBACK because no transaction was started
    const texts = queryTexts(client);
    expect(texts).not.toContain("ROLLBACK");
    expect(client.end).toHaveBeenCalled();
  });

  it("calls end on connect failure without ROLLBACK", async () => {
    const connectError = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    const { factory, client } = makeSpyFactory(makeSpyClient({ connectError: connectError as Error & { code: string } }));

    await expect(executeReadQuery("postgres://localhost/test", factory, {
      sql: "SELECT 1",
    })).rejects.toThrow();

    // No ROLLBACK (BEGIN never happened)
    const texts = queryTexts(client);
    expect(texts).not.toContain("ROLLBACK");
    // End still called
    expect(client.end).toHaveBeenCalled();
  });

  it("does not leak raw SQL, params, URL, or SQLSTATE in error message", async () => {
    const workError = Object.assign(new Error("57014 query cancelled"), { code: "57014" });
    const { factory } = makeSpyFactory(makeSpyClient({ workError }));

    try {
      await executeReadQuery("postgres://user:secret@host:5432/db", factory, {
        sql: "SELECT * FROM users WHERE password = $1",
        params: ["mysecretpass"],
      });
    } catch (e) {
      const shipErr = e as unknown as Record<string, unknown>;
      expect(shipErr.code).toBe("E_CANCELLED");
      const msg = shipErr.message as string;
      expect(msg).not.toContain("user");
      expect(msg).not.toContain("secret");
      expect(msg).not.toContain("password");
      expect(msg).not.toContain("mysecretpass");
      expect(msg).not.toContain("57014");
      expect(msg).not.toContain("SELECT");
    }
  });

  it("binds params to DECLARE statement correctly", async () => {
    const spyClient = makeSpyClient({ fetchRows: [{ c: 42 }], fetchFields: [{ name: "c", dataTypeID: 23 }] });
    const { factory } = makeSpyFactory(spyClient);

    await executeReadQuery("postgres://localhost/test", factory, {
      sql: "SELECT $1 AS c",
      params: [42],
    });

    // Find DECLARE call and check params
    const calls = (spyClient.query as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
    const declareCall = calls.find((c) => typeof c[0] === "string" && (c[0] as string).startsWith("DECLARE"));
    expect(declareCall).toBeDefined();
    expect(declareCall![1]).toEqual([42]);
  });

  it("aborts before factory call when signal already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { factory } = makeSpyFactory();

    await expect(executeReadQuery("postgres://localhost/test", factory, {
      sql: "SELECT 1",
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "E_CANCELLED" });

    expect(factory).not.toHaveBeenCalled();
  });

  it("aborts after FETCH completes, discards rows after rollback, and ends once", async () => {
    const controller = new AbortController();
    const spyClient = makeSpyClient();
    const { factory } = makeSpyFactory(spyClient);

    (spyClient.query as ReturnType<typeof vi.fn>).mockImplementation(async (text: string) => {
      if (text === "BEGIN READ ONLY") return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (text.startsWith("SET LOCAL")) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      if (text.startsWith("DECLARE")) return { fields: [], rows: [], rowCount: 0, command: "DECLARE" };
      if (text.startsWith("FETCH")) {
        controller.abort();
        return { fields: [{ name: "id", dataTypeID: 23 }], rows: [{ id: 1 }], rowCount: 1, command: "FETCH" };
      }
      if (text.startsWith("CLOSE")) return { fields: [], rows: [], rowCount: 0, command: "CLOSE" };
      if (text === "ROLLBACK") return { fields: [], rows: [], rowCount: 0, command: "ROLLBACK" };
      return { fields: [], rows: [], rowCount: 0, command: "SELECT" };
    });

    await expect(executeReadQuery("postgres://localhost/test", factory, {
      sql: "SELECT 1",
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "E_CANCELLED" });
    expect(queryTexts(spyClient)).toContain("ROLLBACK");
    expect(spyClient.end).toHaveBeenCalledOnce();
  });

  it("aborts during SET LOCAL, still ROLLBACKs and ends once", async () => {
    const controller = new AbortController();
    const spyClient = makeSpyClient();
    const { factory } = makeSpyFactory(spyClient);

    // Signal fires during SET LOCAL query
    (spyClient.query as ReturnType<typeof vi.fn>).mockImplementation(async (text: string) => {
      if (text.startsWith("SET LOCAL")) {
        controller.abort();
        throw Object.assign(new Error("aborted"), { code: "ERR_ABORTED" });
      }
      if (text === "BEGIN READ ONLY") return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      // ROLLBACK and any other commands succeed
      return { fields: [], rows: [], rowCount: 0, command: "SELECT" };
    });

    await expect(executeReadQuery("postgres://localhost/test", factory, {
      sql: "SELECT 1",
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "E_CANCELLED" });

    // Order: BEGIN, SET (throws), ROLLBACK (in catch), end
    const texts = queryTexts(spyClient);
    expect(texts[0]).toBe("BEGIN READ ONLY");
    expect(texts[1]).toMatch(/^SET LOCAL/);
    expect(texts).toContain("ROLLBACK");
    expect(spyClient.end).toHaveBeenCalledOnce();
  });

  it("aborts during FETCH, still ROLLBACKs and ends once", async () => {
    const controller = new AbortController();
    const spyClient = makeSpyClient();
    const { factory } = makeSpyFactory(spyClient);

    let callCount = 0;
    (spyClient.query as ReturnType<typeof vi.fn>).mockImplementation(async (text: string) => {
      callCount++;
      if (text.startsWith("FETCH FORWARD")) {
        controller.abort();
        throw Object.assign(new Error("aborted"), { code: "ERR_ABORTED" });
      }
      if (text === "BEGIN READ ONLY") return { fields: [], rows: [], rowCount: 0, command: "BEGIN" };
      if (text.startsWith("SET LOCAL")) return { fields: [], rows: [], rowCount: 0, command: "SET" };
      if (text.startsWith("DECLARE")) return { fields: [], rows: [], rowCount: 0, command: "DECLARE" };
      return { fields: [], rows: [], rowCount: 0, command: "SELECT" };
    });

    await expect(executeReadQuery("postgres://localhost/test", factory, {
      sql: "SELECT 1",
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "E_CANCELLED" });

    // Order: BEGIN, SET, SET, DECLARE, FETCH (throws), ROLLBACK, end
    const texts = queryTexts(spyClient);
    expect(texts[0]).toBe("BEGIN READ ONLY");
    expect(texts[1]).toMatch(/^SET LOCAL/);
    expect(texts[2]).toMatch(/^SET LOCAL/);
    expect(texts[3]).toMatch(/^DECLARE/);
    expect(texts[4]).toMatch(/^FETCH/);
    expect(texts).toContain("ROLLBACK");
    expect(spyClient.end).toHaveBeenCalledOnce();
  });

  it("rejects limit=0", async () => {
    const { factory } = makeSpyFactory();
    await expect(executeReadQuery("postgres://localhost/test", factory, {
      sql: "SELECT 1", limit: 0,
    })).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rejects limit=201", async () => {
    const { factory } = makeSpyFactory();
    await expect(executeReadQuery("postgres://localhost/test", factory, {
      sql: "SELECT 1", limit: 201,
    })).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("accepts limit=1 (minimum)", async () => {
    const { factory } = makeSpyFactory(makeSpyClient({ fetchRows: [{ col: "x" }] }));
    const result = await executeReadQuery("postgres://localhost/test", factory, {
      sql: "SELECT 1", limit: 1,
    });
    expect(result.rowCount).toBe(1);
  });

  it("accepts limit=200 (maximum)", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ col: i }));
    const { factory } = makeSpyFactory(makeSpyClient({ fetchRows: rows }));
    const result = await executeReadQuery("postgres://localhost/test", factory, {
      sql: "SELECT 1", limit: 200,
    });
    expect(result.rowCount).toBe(200);
  });
});
