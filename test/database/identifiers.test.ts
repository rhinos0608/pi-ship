import { describe, expect, it } from "vitest";
import { quoteIdentifier } from "../../src/database/identifiers.js";

describe("quoteIdentifier", () => {
  it("quotes simple identifier", () => {
    expect(quoteIdentifier("users")).toBe('"users"');
  });

  it("quotes identifier with underscores", () => {
    expect(quoteIdentifier("user_profiles")).toBe('"user_profiles"');
  });

  it("doubles embedded double-quotes", () => {
    expect(quoteIdentifier('my"table')).toBe('"my""table"');
  });

  it("accepts Unicode identifiers", () => {
    const value = "täst";
    expect(quoteIdentifier(value)).toBe(`"${value}"`);
  });

  it("accepts mixed-case identifiers", () => {
    expect(quoteIdentifier("UserProfiles")).toBe('"UserProfiles"');
  });

  it("rejects empty string", () => {
    expect(() => quoteIdentifier("")).toThrowError(/must not be empty/);
  });

  it("rejects NUL character", () => {
    expect(() => quoteIdentifier("bad\0name")).toThrowError(/must not contain NUL/);
  });

  it("rejects identifier with UTF-8 byte length > 63", () => {
    // 64-character string where each char is 1 byte in UTF-8
    const long = "a".repeat(64);
    expect(() => quoteIdentifier(long)).toThrowError(/byte length exceeds 63/);
  });

  it("accepts identifier with UTF-8 byte length exactly 63", () => {
    const ok = "a".repeat(63);
    expect(quoteIdentifier(ok)).toBe(`"${ok}"`);
  });

  it("accepts identifier with multi-byte UTF-8 characters that fit in 63 bytes", () => {
    // Each é is 2 bytes, so 31 é = 62 bytes
    const value = "é".repeat(31);
    expect(quoteIdentifier(value)).toBe(`"${value}"`);
  });

  it("rejects identifier with multi-byte UTF-8 characters exceeding 63 bytes", () => {
    // 32 é = 64 bytes
    const long = "é".repeat(32);
    expect(() => quoteIdentifier(long)).toThrowError(/byte length exceeds 63/);
  });

  it("rejects non-string input", () => {
    expect(() => (quoteIdentifier as Function)(123)).toThrowError(/must be a string/);
  });
});
