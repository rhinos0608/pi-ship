/** Tests for MySQL client — uses fake mysql2 module, no live server. */
import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.hoisted ensures these are defined before the mock factory runs
const fakeCreateConnection = vi.hoisted(() => vi.fn());
const fakeConnectionInstance = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  execute: vi.fn().mockResolvedValue([[], []]),
  end: vi.fn().mockResolvedValue(undefined),
}));
fakeCreateConnection.mockReturnValue(fakeConnectionInstance);

vi.mock("mysql2/promise", () => ({
  createConnection: fakeCreateConnection,
}));

describe("MySQL client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("parseMySQLURL", () => {
    it("parses basic mysql:// URL", async () => {
      const { parseMySQLURL } = await import("../../../../src/database/dialect/mysql/client.js");
      const opts = parseMySQLURL("mysql://user:pass@host:3307/mydb");
      expect(opts.host).toBe("host");
      expect(opts.port).toBe(3307);
      expect(opts.user).toBe("user");
      expect(opts.password).toBe("pass");
      expect(opts.database).toBe("mydb");
      expect(opts.multipleStatements).toBe(false);
    });

    it("defaults port to 3306", async () => {
      const { parseMySQLURL } = await import("../../../../src/database/dialect/mysql/client.js");
      const opts = parseMySQLURL("mysql://user:pass@host/mydb");
      expect(opts.port).toBe(3306);
    });

    it("defaults host to localhost when missing", async () => {
      const { parseMySQLURL } = await import("../../../../src/database/dialect/mysql/client.js");
      const opts = parseMySQLURL("mysql://user:pass@/mydb");
      expect(opts.host).toBe("localhost");
    });

    it("handles mariadb:// scheme", async () => {
      const { parseMySQLURL } = await import("../../../../src/database/dialect/mysql/client.js");
      const opts = parseMySQLURL("mariadb://user:pass@host:3308/mydb");
      expect(opts.host).toBe("host");
      expect(opts.port).toBe(3308);
    });

    it("handles URL-encoded credentials", async () => {
      const { parseMySQLURL } = await import("../../../../src/database/dialect/mysql/client.js");
      const opts = parseMySQLURL("mysql://user%40host:pa%24s@localhost/db");
      expect(opts.user).toBe("user@host");
      expect(opts.password).toBe("pa$s");
    });

    it("does not spread arbitrary query params into options", async () => {
      const { parseMySQLURL } = await import("../../../../src/database/dialect/mysql/client.js");
      const opts = parseMySQLURL("mysql://user:pass@host/db?foo=bar&debug=1");
      expect(opts.foo).toBeUndefined();
      expect(opts.debug).toBeUndefined();
    });

    it("passes ssl string param", async () => {
      const { parseMySQLURL } = await import("../../../../src/database/dialect/mysql/client.js");
      const opts = parseMySQLURL("mysql://user:pass@host/db?ssl=true");
      expect(opts.ssl).toBe("true");
    });

    it("passes sslmode param as rejectUnauthorized", async () => {
      const { parseMySQLURL } = await import("../../../../src/database/dialect/mysql/client.js");
      const opts = parseMySQLURL("mysql://user:pass@host/db?sslmode=required");
      expect(opts.ssl).toEqual({ rejectUnauthorized: true });
    });

    it("rejects non-mysql/mariadb scheme", async () => {
      const { parseMySQLURL } = await import("../../../../src/database/dialect/mysql/client.js");
      expect(() => parseMySQLURL("postgres://user:pass@host/db")).toThrow("unsupported MySQL URL protocol");
    });
  });

  describe("createMySQLClient", () => {
    it("creates connection with multipleStatements false", async () => {
      const { createMySQLClient } = await import("../../../../src/database/dialect/mysql/client.js");
      await createMySQLClient({ host: "localhost", user: "u", database: "d" });

      expect(fakeCreateConnection).toHaveBeenCalledWith(
        expect.objectContaining({ multipleStatements: false }),
      );
    });

    it("connect delegates to driver connect", async () => {
      const { createMySQLClient } = await import("../../../../src/database/dialect/mysql/client.js");
      const client = await createMySQLClient({ host: "localhost" });

      await client.connect();
      expect(fakeConnectionInstance.connect).toHaveBeenCalledTimes(1);
    });

    it("end delegates to driver end", async () => {
      const { createMySQLClient } = await import("../../../../src/database/dialect/mysql/client.js");
      const client = await createMySQLClient({ host: "localhost" });

      await client.end();
      expect(fakeConnectionInstance.end).toHaveBeenCalledTimes(1);
    });

    it("end swallows driver errors", async () => {
      fakeConnectionInstance.end.mockRejectedValueOnce(new Error("fail"));
      const { createMySQLClient } = await import("../../../../src/database/dialect/mysql/client.js");
      const client = await createMySQLClient({ host: "localhost" });

      await expect(client.end()).resolves.toBeUndefined();
    });

    it("execute calls driver execute with sql and params", async () => {
      fakeConnectionInstance.execute.mockResolvedValueOnce([[{ id: 1 }], [{ name: "id", type: 0 }]]);
      const { createMySQLClient } = await import("../../../../src/database/dialect/mysql/client.js");
      const client = await createMySQLClient({ host: "localhost" });

      const result = await client.query("SELECT ? AS x", [42]);
      expect(fakeConnectionInstance.execute).toHaveBeenCalledWith("SELECT ? AS x", [42]);
      expect(result.rows).toEqual([{ id: 1 }]);
      expect(result.fields).toEqual([{ name: "id", dataTypeID: 0 }]);
    });

    it("execute returns correct rowCount for SELECT", async () => {
      fakeConnectionInstance.execute.mockResolvedValueOnce([
        [{ id: 1 }, { id: 2 }],
        [{ name: "id", type: 0 }],
      ]);
      const { createMySQLClient } = await import("../../../../src/database/dialect/mysql/client.js");
      const client = await createMySQLClient({ host: "localhost" });

      const result = await client.query("SELECT * FROM t");
      expect(result.rowCount).toBe(2);
    });

    it("execute returns correct rowCount for INSERT (affectedRows)", async () => {
      fakeConnectionInstance.execute.mockResolvedValueOnce([
        { affectedRows: 1, insertId: 42 },
        [],
      ]);
      const { createMySQLClient } = await import("../../../../src/database/dialect/mysql/client.js");
      const client = await createMySQLClient({ host: "localhost" });

      const result = await client.query("INSERT INTO t VALUES (?)", [1]);
      expect(result.rowCount).toBe(1);
    });
  });
});
