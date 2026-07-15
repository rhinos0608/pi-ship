import { AsyncLocalStorage } from "node:async_hooks";
import type { CredentialSource } from "../deployment/credentials.js";
import type { ProtectedResourceRegistry } from "./resource.js";
import type { BoundaryCapability, ResourceType, SecurityMode } from "./types.js";
import { type ApprovalRegistry } from "../core/approval.js";
import { validateCapability } from "./capability.js";

const capabilityStore = new AsyncLocalStorage<BoundaryCapability>();
const trustedStore = new AsyncLocalStorage<boolean>();

export class CredentialVault {
  constructor(
    private readonly source: CredentialSource,
    private readonly resources: ProtectedResourceRegistry,
    private readonly mode: SecurityMode,
    private readonly approvalRegistry?: ApprovalRegistry,
  ) {}

  /** Read a credential. In managed mode, always returns. In warn mode, logs warning. In exclusive mode, requires capability or trusted context. */
  get(name: string, capability?: BoundaryCapability): string | undefined {
    if (!this.resources.isCredentialProtected(name)) {
      return this.source.get(name);
    }

    if (this.mode === "managed") {
      return this.source.get(name);
    }

    if (this.mode === "warn") {
      // Warning is emitted by enforcement layer — vault just returns
      return this.source.get(name);
    }

    // exclusive: require valid capability or trusted context
    const effectiveCap = capability ?? capabilityStore.getStore();
    const isTrusted = trustedStore.getStore() === true;

    if (!effectiveCap && !isTrusted) return undefined;

    if (effectiveCap) {
      if (this.approvalRegistry) {
        // Full validation through approval registry (covers expiry + approval).
        // Bind credential to owning resource so capability resource mismatch is caught.
        const owner = this.resources.resourceForCredential(name);
        const expectedResource = owner?.name ?? effectiveCap.resource;
        const result = validateCapability(effectiveCap, expectedResource, effectiveCap.planId, effectiveCap.planDigest, this.approvalRegistry, process.cwd(), owner?.type ?? "database");
        if (!result.valid) return undefined;
      } else {
        // Backward compat: basic expiry check only
        if (this.isExpired(effectiveCap)) return undefined;
      }
    }
    // If isTrusted && !effectiveCap: allow (plan/status read path)

    return this.source.get(name);
  }

  /** Run fn with capability available to get() calls via ALS. */
  runWithCapability<T>(capability: BoundaryCapability, fn: () => T): T {
    return capabilityStore.run(capability, fn);
  }

  /** Run fn as a trusted caller (plan/status reads bypass capability requirement). */
  runTrusted<T>(fn: () => T): T {
    return trustedStore.run(true, fn);
  }

  /** Check if a capability is still valid (not expired). */
  private isExpired(capability: BoundaryCapability): boolean {
    return new Date(capability.expiresAt).getTime() < Date.now();
  }

  /** Get the underlying source for non-protected reads (e.g., PI_SHIP_DATABASE_ENVIRONMENT). */
  raw(): CredentialSource {
    return this.source;
  }

  /** Create a CredentialSource that routes through vault protection. */
  asCredentialSource(): CredentialSource {
    return {
      get: (name: string) => this.get(name),
    };
  }
}
