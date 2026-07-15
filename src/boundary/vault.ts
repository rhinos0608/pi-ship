import { AsyncLocalStorage } from "node:async_hooks";
import type { CredentialSource } from "../deployment/credentials.js";
import type { ProtectedResourceRegistry } from "./resource.js";
import type { BoundaryCapability, SignedCapability, ResourceType, SecurityMode } from "./types.js";
import { type ApprovalRegistry } from "../core/approval.js";
import { validateCapability, mintSignedCapability } from "./capability.js";
import { EphemeralKeyStore } from "./key-store.js";

export class CredentialVault {
  private readonly capabilityStore = new AsyncLocalStorage<BoundaryCapability>();
  private readonly trustedStore = new AsyncLocalStorage<boolean>();
  private readonly keyStore?: EphemeralKeyStore;

  constructor(
    private readonly source: CredentialSource,
    private readonly resources: ProtectedResourceRegistry,
    private readonly mode: SecurityMode,
    private readonly approvalRegistry?: ApprovalRegistry,
    private readonly cwd: string = process.cwd(),
    keyStore?: EphemeralKeyStore,
  ) {
    if (mode === "exclusive" && !approvalRegistry) {
      throw new Error("CredentialVault: approvalRegistry required in exclusive mode");
    }
    this.keyStore = keyStore;
  }

  /** Sign a capability using the vault's ephemeral key store. */
  signCapability(
    cap: BoundaryCapability,
    options?: { issuer?: string; audience?: string; projectBinding?: string },
  ): SignedCapability {
    if (!this.keyStore) {
      throw new Error("CredentialVault: keyStore required for signing");
    }
    return mintSignedCapability(
      {
        resource: cap.resource,
        operation: cap.operation,
        planId: cap.planId,
        planDigest: cap.planDigest,
        riskLevel: cap.riskLevel,
        issuer: options?.issuer ?? "pi-ship",
        audience: options?.audience ?? "pi-ship-child",
        projectBinding: options?.projectBinding ?? this.cwd,
        keyId: this.keyStore.getPublicKeyId(),
      },
      this.keyStore.getSigner(),
    );
  }

  /** Get the base64url public key ID for distribution to child processes. */
  getPublicKeyId(): string | undefined {
    return this.keyStore?.getPublicKeyId();
  }

  /** Read a credential. In managed mode, always returns. In warn mode, logs warning. In exclusive mode, requires capability or trusted context. */
  get(
    name: string,
    capability?: BoundaryCapability,
    operation?: BoundaryCapability["operation"],
    risk?: BoundaryCapability["riskLevel"],
  ): string | undefined {
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
    const effectiveCap = capability ?? this.capabilityStore.getStore();
    const isTrusted = this.trustedStore.getStore() === true;

    if (!effectiveCap && !isTrusted) return undefined;

    if (effectiveCap) {
      // Full validation through approval registry (covers expiry + approval).
      // Bind credential to owning resource so capability resource mismatch is caught.
      const owner = this.resources.resourceForCredential(name);
      const expectedResource = owner?.name ?? effectiveCap.resource;
      const result = validateCapability(
        effectiveCap,
        expectedResource,
        effectiveCap.planId,
        effectiveCap.planDigest,
        this.approvalRegistry!,
        this.cwd,
        owner?.type ?? "database",
        operation ?? effectiveCap.operation,
        risk ?? effectiveCap.riskLevel,
      );
      if (!result.valid) return undefined;
    }
    // If isTrusted && !effectiveCap: allow (plan/status read path)

    return this.source.get(name);
  }

  /** Run fn with capability available to get() calls via ALS. */
  runWithCapability<T>(capability: BoundaryCapability, fn: () => T): T {
    return this.capabilityStore.run(capability, fn);
  }

  /** Run fn as a trusted caller (plan/status reads bypass capability requirement). */
  runTrusted<T>(fn: () => T): T {
    return this.trustedStore.run(true, fn);
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
