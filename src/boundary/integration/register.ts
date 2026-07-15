import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CredentialSource } from "../../deployment/credentials.js";
import { isShipError } from "../../core/errors.js";
import { loadBoundaryConfig, ProtectedResourceRegistry, createDatabaseResource, createVercelResource, createRailwayResource, createCloudflareResource, createNeonControlPlaneResource, CredentialVault, BoundaryEnforcer } from "../index.js";
import { readManifestRaw } from "../../persistence/manifest-store.js";
import type { ApprovalRegistry } from "../../core/approval.js";

export interface BoundaryRegistration {
  vault: CredentialVault;
  enforcer: BoundaryEnforcer;
  resources: ProtectedResourceRegistry;
}

export async function registerBoundary(
  pi: ExtensionAPI,
  cwd: string,
  credentialSource: CredentialSource,
  approvalRegistry: ApprovalRegistry,
): Promise<BoundaryRegistration | null> {
  let config;
  try {
    const manifest = await readManifestRaw(cwd);
    config = loadBoundaryConfig(manifest);
  } catch (e) {
    // No manifest or unreadable — use default (managed).
    // Let E_CONFIG_INVALID (e.g., invalid mode value) propagate so the user
    // gets feedback about misconfiguration.
    if (isShipError(e) && e.code === "E_CONFIG_INVALID") throw e;
    return null;
  }

  if (config.mode === "managed") return null;

  const resources = new ProtectedResourceRegistry();
  resources.register(createDatabaseResource());
  resources.register(createVercelResource());
  resources.register(createRailwayResource());
  resources.register(createCloudflareResource());
  resources.register(createNeonControlPlaneResource());

  // Internal boundary (vault + enforcer + capability + approval) is active.
  const isBoundaryActive = true;

  const enforcer = new BoundaryEnforcer(config.mode, resources, isBoundaryActive);
  const vault = new CredentialVault(credentialSource, resources, config.mode, approvalRegistry);

  // Startup validation — exclusive fails closed if no boundary extension
  enforcer.validateStartup();

  // Register tool-call hook for credential protection
  pi.on("tool_call", (event) => {
    // DB and ship are always allowed (they ARE the boundary)
    if (isToolCallEventType("DB", event) || isToolCallEventType("ship", event)) {
      return undefined;
    }

    const toolName = event.toolName;
    const result = enforcer.checkToolCall({
      toolName,
      input: event.input as Record<string, unknown>,
    });

    if (!result.allowed) {
      return { block: true, reason: result.reason ?? "credential access blocked" };
    }
    return undefined;
  });

  return { vault, enforcer, resources };
}
