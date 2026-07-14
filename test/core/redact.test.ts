import { describe, expect, it } from "vitest";
import { redact } from "../../src/core/redact.js";

describe("redact", () => {
  it("redacts short explicitly supplied secret values", () => {
    expect(redact("APP_SECRET appears", [], ["APP_SECRET"])).toBe("*** appears");
  });

  it("redacts exact env value", () => {
    process.env.PI_SHIP_TEST_SECRET = "hunter2-secret";
    const out = redact("my hunter2-secret value", ["PI_SHIP_TEST_SECRET"]);
    expect(out).toBe("my *** value");
    delete process.env.PI_SHIP_TEST_SECRET;
  });

  it("ignores short env values", () => {
    process.env.PI_SHIP_TEST_SHORT = "abc";
    const out = redact("my abc value", ["PI_SHIP_TEST_SHORT"]);
    expect(out).toBe("my abc value");
    delete process.env.PI_SHIP_TEST_SHORT;
  });

  it("redacts postgres DSN password", () => {
    const out = redact("postgres://user:super-secret-123@host.example/db", []);
    expect(out).not.toContain("super-secret-123");
    expect(out).toContain("***");
  });

  it("redacts bearer token", () => {
    const out = redact("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", []);
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(out).toContain("***");
  });

  it("redacts 32-char hex", () => {
    const token = "deadbeef".repeat(4);
    const out = redact(`token=${token}`, []);
    expect(out).not.toContain(token);
  });

  it("redacts multiple env names", () => {
    process.env.PI_SHIP_A = "alpha-secret";
    process.env.PI_SHIP_B = "beta-secret";
    const out = redact("alpha-secret and beta-secret", ["PI_SHIP_A", "PI_SHIP_B"]);
    expect(out).toBe("*** and ***");
    delete process.env.PI_SHIP_A;
    delete process.env.PI_SHIP_B;
  });

  it("leaves non-secret text unchanged", () => {
    const text = "hello world 123";
    expect(redact(text, ["PI_SHIP_MISSING"])).toBe(text);
  });
});
