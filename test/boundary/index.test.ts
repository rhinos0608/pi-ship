import { describe, it, expect } from "vitest";
import * as boundary from "../../src/boundary/index.js";

describe("boundary barrel", () => {
  it("exports all public symbols", () => {
    expect(boundary.loadBoundaryConfig).toBeTypeOf("function");
    expect(boundary.parseSecurityMode).toBeTypeOf("function");
    expect(boundary.DEFAULT_BOUNDARY_CONFIG).toEqual({ mode: "managed" });
    expect(boundary.createDatabaseResource).toBeTypeOf("function");
    expect(boundary.createDeploymentResource).toBeTypeOf("function");
    expect(boundary.ProtectedResourceRegistry).toBeTypeOf("function");
    expect(boundary.CredentialVault).toBeTypeOf("function");
    expect(boundary.mintCapability).toBeTypeOf("function");
    expect(boundary.validateCapability).toBeTypeOf("function");
    expect(boundary.BoundaryEnforcer).toBeTypeOf("function");
  });
});
