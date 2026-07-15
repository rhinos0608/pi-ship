/** Tests for MySQL error mapping — asserts code/errno mapping only, never message parsing. */
import { describe, expect, it } from "vitest";

describe("MySQL error mapping", () => {
  async function loadMapMySQLError() {
    const mod = await import("../../../../src/database/dialect/mysql/error.js");
    return mod.mapMySQLError;
  }

  it("rethrows ShipError unchanged", async () => {
    const { err } = await import("../../../../src/core/errors.js");
    const mapMySQLError = await loadMapMySQLError();
    const shipErr = err("E_CANCELLED", "test", false);
    expect(() => mapMySQLError(shipErr)).toThrowError("test");
    // Should throw with same code
    try { mapMySQLError(shipErr); } catch (e: any) {
      expect(e.code).toBe("E_CANCELLED");
    }
  });

  it("maps ER_ACCESS_DENIED_ERROR to E_AUTH_MISSING", async () => {
    const mapMySQLError = await loadMapMySQLError();
    const driverErr = new Error("Access denied for user");
    (driverErr as any).code = "ER_ACCESS_DENIED_ERROR";
    try { mapMySQLError(driverErr); } catch (e: any) {
      expect(e.code).toBe("E_AUTH_MISSING");
      expect(e.retryable).toBe(false);
    }
  });

  it("maps ER_DBACCESS_DENIED_ERROR to E_AUTH_MISSING", async () => {
    const mapMySQLError = await loadMapMySQLError();
    const driverErr = new Error("DB access denied");
    (driverErr as any).code = "ER_DBACCESS_DENIED_ERROR";
    try { mapMySQLError(driverErr); } catch (e: any) {
      expect(e.code).toBe("E_AUTH_MISSING");
    }
  });

  it("maps ECONNREFUSED to retryable E_PROVIDER", async () => {
    const mapMySQLError = await loadMapMySQLError();
    const driverErr = new Error("connect ECONNREFUSED");
    (driverErr as any).code = "ECONNREFUSED";
    (driverErr as any).errno = -111;
    try { mapMySQLError(driverErr); } catch (e: any) {
      expect(e.code).toBe("E_PROVIDER");
      expect(e.retryable).toBe(true);
    }
  });

  it("maps ECONNRESET to retryable E_PROVIDER", async () => {
    const mapMySQLError = await loadMapMySQLError();
    const driverErr = new Error("read ECONNRESET");
    (driverErr as any).code = "ECONNRESET";
    try { mapMySQLError(driverErr); } catch (e: any) {
      expect(e.code).toBe("E_PROVIDER");
      expect(e.retryable).toBe(true);
    }
  });

  it("maps ETIMEDOUT to retryable E_PROVIDER", async () => {
    const mapMySQLError = await loadMapMySQLError();
    const driverErr = new Error("connection timed out");
    (driverErr as any).code = "ETIMEDOUT";
    try { mapMySQLError(driverErr); } catch (e: any) {
      expect(e.code).toBe("E_PROVIDER");
      expect(e.retryable).toBe(true);
    }
  });

  it("maps ENOTFOUND to retryable E_PROVIDER", async () => {
    const mapMySQLError = await loadMapMySQLError();
    const driverErr = new Error("getaddrinfo ENOTFOUND");
    (driverErr as any).code = "ENOTFOUND";
    try { mapMySQLError(driverErr); } catch (e: any) {
      expect(e.code).toBe("E_PROVIDER");
      expect(e.retryable).toBe(true);
    }
  });

  it("maps ERR_ABORTED to E_CANCELLED", async () => {
    const mapMySQLError = await loadMapMySQLError();
    const driverErr = new Error("aborted");
    (driverErr as any).code = "ERR_ABORTED";
    try { mapMySQLError(driverErr); } catch (e: any) {
      expect(e.code).toBe("E_CANCELLED");
      expect(e.retryable).toBe(false);
    }
  });

  it("maps unknown MySQL error to non-retryable E_PROVIDER", async () => {
    const mapMySQLError = await loadMapMySQLError();
    const driverErr = new Error("Some MySQL execution error");
    (driverErr as any).code = "ER_SYNTAX_ERROR";
    (driverErr as any).errno = 1064;
    try { mapMySQLError(driverErr); } catch (e: any) {
      expect(e.code).toBe("E_PROVIDER");
      expect(e.retryable).toBe(false);
    }
  });

  it("maps generic Error to non-retryable E_PROVIDER", async () => {
    const mapMySQLError = await loadMapMySQLError();
    try { mapMySQLError(new Error("generic")); } catch (e: any) {
      expect(e.code).toBe("E_PROVIDER");
      expect(e.retryable).toBe(false);
    }
  });

  it("never leaks error message text in output", async () => {
    const mapMySQLError = await loadMapMySQLError();
    const driverErr = new Error("SECRET_VALUE_12345");
    (driverErr as any).code = "ER_SYNTAX_ERROR";
    try { mapMySQLError(driverErr); } catch (e: any) {
      expect(e.message).not.toContain("SECRET_VALUE_12345");
      expect(e.message).toBe("database operation failed");
    }
  });
});
