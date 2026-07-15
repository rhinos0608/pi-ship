import type { SecurityMode, BoundaryEnforcementResult, ResourceType } from "./types.js";
import type { ProtectedResourceRegistry } from "./resource.js";
import type { BoundaryCapability, SignedCapability } from "./types.js";
import type { ApprovalRegistry } from "../core/approval.js";
import { err } from "../core/errors.js";
import { validateCapability, verifySignedCapability } from "./capability.js";
import * as crypto from "node:crypto";

export interface ToolCallContext {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

export interface CredentialAccessContext {
  readonly credentialName: string;
  readonly caller: string;
  capability?: BoundaryCapability;
  /** Authoritative operation for validateCapability (overrides cap.operation). */
  operation?: BoundaryCapability["operation"];
  /** Authoritative risk for validateCapability (overrides cap.riskLevel). */
  risk?: BoundaryCapability["riskLevel"];
  /** Expected claims for signed capability verification. */
  expectedResource?: string;
  expectedProjectBinding?: string;
  expectedPlanId?: string;
  expectedPlanDigest?: string;
  expectedOperation?: BoundaryCapability["operation"];
  expectedRisk?: BoundaryCapability["riskLevel"];
  expectedIssuer?: string;
  resourceType?: ResourceType;
}

export class BoundaryEnforcer {
  private readonly trustedPublicKeys?: Map<string, crypto.KeyObject>;
  private readonly expectedAudience?: string;

  constructor(
    private readonly mode: SecurityMode,
    private readonly resources: ProtectedResourceRegistry,
    private readonly isBoundaryActive: boolean,
    private readonly approvalRegistry?: ApprovalRegistry,
    private readonly cwd: string = process.cwd(),
    trustedPublicKeys?: Map<string, crypto.KeyObject>,
    expectedAudience?: string,
  ) {
    this.trustedPublicKeys = trustedPublicKeys;
    this.expectedAudience = expectedAudience;
  }

  /** Validate startup configuration. exclusive mode requires external boundary. */
  validateStartup(): void {
    if (this.mode === "exclusive" && !this.isBoundaryActive) {
      throw err("E_CONFIG_INVALID", "exclusive databaseAccess mode requires an active boundary (install pi-permission-system); none detected");
    }
  }

  /** Check if a tool call should be allowed. */
  checkToolCall(ctx: ToolCallContext): BoundaryEnforcementResult {
    if (this.mode === "managed") {
      return { allowed: true };
    }

    // For DB tool: always allowed through pi-ship (it IS the boundary for its own operations)
    if (ctx.toolName === "DB" || ctx.toolName === "ship") {
      return { allowed: true };
    }

    // warn and exclusive: recursive value walk for credential/hostname/path detection.
    // More structured than JSON.stringify substring scan — walks actual string values.
    const values = collectStringValues(ctx.input);

    for (const name of this.resources.credentialNames()) {
      if (values.some((v) => v.includes(name))) {
        if (this.mode === "warn") {
          return { allowed: true, reason: `warning: ${name} visible in ${ctx.toolName} call` };
        }
        // exclusive: block non-protected tools that reference credentials
        return { allowed: false, reason: `credential ${name} must not be used outside protected tool ${this.firstAllowedExecutor(name)}` };
      }
    }

    // Structured resource-aware checks: hostnames and file paths
    for (const resource of this.resources.all()) {
      for (const hostname of resource.hostnames) {
        if (values.some((v) => v.includes(hostname))) {
          if (this.mode === "warn") {
            return { allowed: true, reason: `warning: hostname ${hostname} visible in ${ctx.toolName} call` };
          }
          return { allowed: false, reason: `hostname ${hostname} protected in resource ${resource.name}` };
        }
      }
      for (const filePath of resource.filePaths) {
        if (values.some((v) => v.startsWith(filePath) || v.includes(filePath))) {
          if (this.mode === "warn") {
            return { allowed: true, reason: `warning: path ${filePath} visible in ${ctx.toolName} call` };
          }
          return { allowed: false, reason: `path ${filePath} protected in resource ${resource.name}` };
        }
      }
    }

    return { allowed: true };
  }

  /** Check if direct credential access should be allowed. */
  checkCredentialAccess(ctx: CredentialAccessContext): BoundaryEnforcementResult {
    if (!this.resources.isCredentialProtected(ctx.credentialName)) {
      return { allowed: true };
    }

    if (this.mode === "managed") {
      return { allowed: true };
    }

    const cap = ctx.capability;

    // Signed capability path — when trustedPublicKeys are configured
    if (cap && "signature" in cap) {
      if (!this.trustedPublicKeys || !this.expectedAudience) {
        return { allowed: false, reason: "signed capability verification not configured" };
      }
      const signed = cap as SignedCapability;
      const result = verifySignedCapability(
        signed,
        this.trustedPublicKeys,
        this.expectedAudience,
      );
      if (!result.valid) {
        return { allowed: false, reason: result.reason ?? "signed capability validation failed" };
      }

      // Verify expected claims
      if (ctx.expectedResource !== undefined && signed.resource !== ctx.expectedResource) {
        return { allowed: false, reason: `signed cap resource mismatch: expected ${ctx.expectedResource}, got ${signed.resource}` };
      }
      if (ctx.expectedProjectBinding !== undefined && signed.projectBinding !== ctx.expectedProjectBinding) {
        return { allowed: false, reason: "signed cap projectBinding mismatch" };
      }
      if (ctx.expectedPlanId !== undefined && signed.planId !== ctx.expectedPlanId) {
        return { allowed: false, reason: "signed cap planId mismatch" };
      }
      if (ctx.expectedPlanDigest !== undefined && signed.planDigest !== ctx.expectedPlanDigest) {
        return { allowed: false, reason: "signed cap planDigest mismatch" };
      }
      if (ctx.expectedOperation !== undefined && signed.operation !== ctx.expectedOperation) {
        return { allowed: false, reason: "signed cap operation mismatch" };
      }
      if (ctx.expectedRisk !== undefined && signed.riskLevel !== ctx.expectedRisk) {
        return { allowed: false, reason: "signed cap riskLevel mismatch" };
      }
      if (ctx.expectedIssuer !== undefined && signed.issuer !== ctx.expectedIssuer) {
        return { allowed: false, reason: "signed cap issuer mismatch" };
      }

      // Require matching approval before allowing
      if (this.approvalRegistry) {
        const resourceType = ctx.resourceType ?? "database";
        const risk = signed.riskLevel === "read" ? undefined : signed.riskLevel;
        const approved = this.approvalRegistry.isApproved(
          signed.planId, signed.planDigest, this.cwd,
          { domain: resourceType === "deployment" ? "deployment" : "database", risk },
        );
        if (!approved) {
          return { allowed: false, reason: "signed capability not approved by approval registry" };
        }
      }

      return { allowed: true };
    }

    // Unsigned / no capability — mode-specific behavior
    if (this.mode === "warn") {
      return { allowed: true, reason: `warning: ${ctx.credentialName} accessed by ${ctx.caller}` };
    }

    // exclusive
    if (!cap) {
      return { allowed: false, reason: `${ctx.credentialName} requires capability in exclusive mode` };
    }

    // Unsigned capability in exclusive mode — use existing approval registry validation
    if (this.approvalRegistry) {
      const resource = this.resources.resourceForCredential(ctx.credentialName);
      // Validate expiresAt is a valid date
      const expiry = new Date(cap.expiresAt).getTime();
      if (isNaN(expiry)) {
        return { allowed: false, reason: "capability has invalid expiration date" };
      }
      const result = validateCapability(
        cap,
        resource?.name ?? ctx.credentialName,
        cap.planId,
        cap.planDigest,
        this.approvalRegistry,
        this.cwd,
        (resource?.type ?? "database") as ResourceType,
        ctx.operation ?? cap.operation,
        ctx.risk ?? cap.riskLevel,
      );
      if (!result.valid) {
        return { allowed: false, reason: result.reason ?? "capability validation failed" };
      }
    } else {
      // No approval registry — fail closed for unsigned capability
      return { allowed: false, reason: `${ctx.credentialName} requires approval in exclusive mode (no approval registry configured)` };
    }

    return { allowed: true };
  }

  private firstAllowedExecutor(credentialName: string): string {
    for (const r of this.resources.all()) {
      if (r.credentialNames.includes(credentialName)) {
        return r.allowedExecutors[0] ?? "protected-tool";
      }
    }
    return "protected-tool";
  }
}

/** Recursively collect all string values from an arbitrary input structure. */
function collectStringValues(value: unknown): string[] {
  const out: string[] = [];
  function walk(v: unknown): void {
    if (typeof v === "string") {
      out.push(v);
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item);
    } else if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        out.push(key);
      }
      for (const val of Object.values(obj)) {
        walk(val);
      }
    }
  }
  walk(value);
  return out;
}
