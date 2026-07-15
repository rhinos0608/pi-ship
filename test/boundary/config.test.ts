import { describe, it, expect } from "vitest";
import { loadBoundaryConfig, parseSecurityMode, DEFAULT_BOUNDARY_CONFIG } from "../../src/boundary/config.js";

describe("loadBoundaryConfig", () => {
  it("returns default for null manifest", () => {
    expect(loadBoundaryConfig(null)).toEqual(DEFAULT_BOUNDARY_CONFIG);
  });

  it("returns default for manifest without databaseAccess", () => {
    expect(loadBoundaryConfig({ provider: "railway" })).toEqual(DEFAULT_BOUNDARY_CONFIG);
  });

  it("parses valid mode", () => {
    expect(loadBoundaryConfig({ databaseAccess: { mode: "exclusive" } })).toEqual({ mode: "exclusive" });
  });

  it("throws for invalid mode", () => {
    expect(() => loadBoundaryConfig({ databaseAccess: { mode: "yolo" } })).toThrow("managed, warn, or exclusive");
  });

  it("throws for non-string mode", () => {
    expect(() => loadBoundaryConfig({ databaseAccess: { mode: 42 } })).toThrow();
  });
});

describe("parseSecurityMode", () => {
  it("accepts managed", () => expect(parseSecurityMode("managed")).toBe("managed"));
  it("accepts warn", () => expect(parseSecurityMode("warn")).toBe("warn"));
  it("accepts exclusive", () => expect(parseSecurityMode("exclusive")).toBe("exclusive"));
  it("rejects garbage", () => expect(() => parseSecurityMode("turbo")).toThrow());
});
