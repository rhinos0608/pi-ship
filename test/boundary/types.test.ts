import { describe, it, expectTypeOf } from "vitest";
import type { SecurityMode, ProtectedResourceDescriptor, BoundaryCapability } from "../../src/boundary/types.js";

describe("boundary types", () => {
  it("SecurityMode accepts all three values", () => {
    expectTypeOf<SecurityMode>().toEqualTypeOf<"managed" | "warn" | "exclusive">();
  });

  it("ProtectedResourceDescriptor is readonly", () => {
    type Keys = keyof ProtectedResourceDescriptor;
    expectTypeOf<Keys>().toEqualTypeOf<"type" | "name" | "credentialNames" | "hostnames" | "ports" | "filePaths" | "allowedExecutors">();
  });

  it("BoundaryCapability has all required fields", () => {
    type Keys = keyof BoundaryCapability;
    expectTypeOf<Keys>().toEqualTypeOf<"resource" | "operation" | "planId" | "planDigest" | "riskLevel" | "issuedAt" | "expiresAt">();
  });
});
