import type { ProtectedResourceDescriptor, ResourceType } from "./types.js";

export function createDatabaseResource(overrides: Partial<Omit<ProtectedResourceDescriptor, "type">> = {}): ProtectedResourceDescriptor {
  return {
    type: "database",
    name: overrides.name ?? "production-database",
    credentialNames: overrides.credentialNames ?? ["DATABASE_URL"],
    hostnames: overrides.hostnames ?? [],
    ports: overrides.ports ?? [5432],
    filePaths: overrides.filePaths ?? [],
    allowedExecutors: overrides.allowedExecutors ?? ["DB"],
  };
}

export function createDeploymentResource(overrides: Partial<Omit<ProtectedResourceDescriptor, "type">> = {}): ProtectedResourceDescriptor {
  return {
    type: "deployment",
    name: overrides.name ?? "deployment-provider",
    credentialNames: overrides.credentialNames ?? [],
    hostnames: overrides.hostnames ?? [],
    ports: overrides.ports ?? [],
    filePaths: overrides.filePaths ?? [],
    allowedExecutors: overrides.allowedExecutors ?? ["ship"],
  };
}

export function createVercelResource(): ProtectedResourceDescriptor {
  return {
    type: "deployment",
    name: "vercel-deployment",
    credentialNames: ["VERCEL_TOKEN"],
    hostnames: [],
    ports: [],
    filePaths: [],
    allowedExecutors: ["ship"],
  };
}

export function createRailwayResource(): ProtectedResourceDescriptor {
  return {
    type: "deployment",
    name: "railway-deployment",
    credentialNames: ["RAILWAY_API_TOKEN", "RAILWAY_TOKEN"],
    hostnames: [],
    ports: [],
    filePaths: [],
    allowedExecutors: ["ship"],
  };
}

export function createCloudflareResource(): ProtectedResourceDescriptor {
  return {
    type: "deployment",
    name: "cloudflare-deployment",
    credentialNames: ["CLOUDFLARE_API_TOKEN"],
    hostnames: [],
    ports: [],
    filePaths: [],
    allowedExecutors: ["ship"],
  };
}

export function createNeonControlPlaneResource(): ProtectedResourceDescriptor {
  return {
    type: "database",
    name: "neon-control-plane",
    credentialNames: ["NEON_API_KEY"],
    hostnames: [],
    ports: [],
    filePaths: [],
    allowedExecutors: ["ship"],
  };
}

export class ProtectedResourceRegistry {
  private readonly resources = new Map<string, ProtectedResourceDescriptor>();

  register(resource: ProtectedResourceDescriptor): void {
    if (this.resources.has(resource.name)) {
      console.warn(`pi-ship: resource "${resource.name}" already registered; skipping duplicate`);
      return;
    }
    this.resources.set(resource.name, resource);
  }

  get(name: string): ProtectedResourceDescriptor | undefined {
    return this.resources.get(name);
  }

  all(): readonly ProtectedResourceDescriptor[] {
    return [...this.resources.values()];
  }

  byType(type: ResourceType): readonly ProtectedResourceDescriptor[] {
    return [...this.resources.values()].filter((r) => r.type === type);
  }

  credentialNames(): readonly string[] {
    const names = new Set<string>();
    for (const r of this.resources.values()) {
      for (const name of r.credentialNames) names.add(name);
    }
    return [...names];
  }

  isCredentialProtected(name: string): boolean {
    for (const r of this.resources.values()) {
      if (r.credentialNames.includes(name)) return true;
    }
    return false;
  }

  /** Find the resource descriptor that owns a credential name. */
  resourceForCredential(name: string): ProtectedResourceDescriptor | undefined {
    for (const r of this.resources.values()) {
      if (r.credentialNames.includes(name)) return r;
    }
    return undefined;
  }

  isExecutorAllowed(executor: string): boolean {
    for (const r of this.resources.values()) {
      if (r.allowedExecutors.includes(executor)) return true;
    }
    return false;
  }

  clear(): void {
    this.resources.clear();
  }
}
