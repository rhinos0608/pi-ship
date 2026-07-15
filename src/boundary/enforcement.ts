import type { SecurityMode, BoundaryEnforcementResult } from "./types.js";
import type { ProtectedResourceRegistry } from "./resource.js";
import type { BoundaryCapability } from "./types.js";
import { err } from "../core/errors.js";

export interface ToolCallContext {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

export interface CredentialAccessContext {
  readonly credentialName: string;
  readonly caller: string;
  capability?: BoundaryCapability;
}

export class BoundaryEnforcer {
  constructor(
    private readonly mode: SecurityMode,
    private readonly resources: ProtectedResourceRegistry,
    private readonly isBoundaryActive: boolean,
  ) {}

  /** Validate startup configuration. exclusive mode requires external boundary. */
  validateStartup(): void {
    if (this.mode === "exclusive" && !this.isBoundaryActive) {
      throw err("E_CONFIG_INVALID", "exclusive databaseAccess mode requires an active boundary; none detected");
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

    // warn and exclusive: check if the tool call contains credential-like fields.
    // Limitation: substring match on serialized JSON. Low risk because default protected
    // credentials (DATABASE_URL) are specific enough to avoid false positives.
    const inputStr = JSON.stringify(ctx.input);
    for (const name of this.resources.credentialNames()) {
      if (inputStr.includes(name)) {
        if (this.mode === "warn") {
          return { allowed: true, reason: `warning: ${name} visible in ${ctx.toolName} call` };
        }
        // exclusive: block non-protected tools that reference credentials
        return { allowed: false, reason: `credential ${name} must not be used outside protected tool ${this.firstAllowedExecutor(name)}` };
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

    if (this.mode === "warn") {
      return { allowed: true, reason: `warning: ${ctx.credentialName} accessed by ${ctx.caller}` };
    }

    // exclusive
    if (!ctx.capability) {
      return { allowed: false, reason: `${ctx.credentialName} requires capability in exclusive mode` };
    }
    if (new Date(ctx.capability.expiresAt).getTime() < Date.now()) {
      return { allowed: false, reason: "capability expired" };
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
