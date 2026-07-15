export type SecurityMode = "managed" | "warn" | "exclusive";

export type ResourceType = "database" | "deployment";

export interface ProtectedResourceDescriptor {
  readonly type: ResourceType;
  readonly name: string;
  readonly credentialNames: readonly string[];
  readonly hostnames: readonly string[];
  readonly ports: readonly number[];
  readonly filePaths: readonly string[];
  readonly allowedExecutors: readonly string[];
}

export interface BoundaryCapability {
  readonly resource: string;
  readonly operation: "read" | "write" | "execute";
  readonly planId: string;
  readonly planDigest: string;
  readonly riskLevel: "read" | "write" | "destructive";
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface BoundaryConfig {
  readonly mode: SecurityMode;
}

export interface BoundaryEnforcementResult {
  readonly allowed: boolean;
  readonly reason?: string;
}
