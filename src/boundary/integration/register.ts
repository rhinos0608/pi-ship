import { access } from "node:fs/promises";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CredentialSource } from "../../deployment/credentials.js";
import { isShipError } from "../../core/errors.js";
import { DEFAULT_BOUNDARY_CONFIG, loadBoundaryConfig, ProtectedResourceRegistry, createDatabaseResource, createVercelResource, createRailwayResource, createCloudflareResource, createNeonControlPlaneResource, CredentialVault, BoundaryEnforcer, EphemeralKeyStore } from "../index.js";
import { manifestPath, readManifestRaw } from "../../persistence/manifest-store.js";
import type { ApprovalRegistry } from "../../core/approval.js";
import { detectPermissionSystem } from "./permission-system.js";

export interface BoundaryRegistration {
  vault: CredentialVault;
  enforcer: BoundaryEnforcer;
  resources: ProtectedResourceRegistry;
  publicKeyId?: string;
}

export async function registerBoundary(
  pi: ExtensionAPI,
  cwd: string,
  credentialSource: CredentialSource,
  approvalRegistry: ApprovalRegistry,
): Promise<BoundaryRegistration | null> {
  // Pre-check manifest existence so we can distinguish "not found" (return null)
  // from read/parse errors (propagate).
  let manifestExists = false;
  try {
    await access(manifestPath(cwd));
    manifestExists = true;
  } catch (err: unknown) {
    // Rethrow non-ENOENT errors (EACCES, EIO, etc) — fail closed
    if (err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    // File not found — use default managed mode below
  }

  let config: ReturnType<typeof loadBoundaryConfig>;
  if (manifestExists) {
    try {
      const manifest = await readManifestRaw(cwd);
      config = loadBoundaryConfig(manifest);
    } catch (e) {
      // Let E_CONFIG_INVALID (broken JSON, invalid mode) propagate so the user
      // gets feedback about misconfiguration. Rethrow all other errors too.
      if (isShipError(e) && e.code === "E_CONFIG_INVALID") throw e;
      throw e;
    }
  } else {
    config = DEFAULT_BOUNDARY_CONFIG;
  }

  if (config.mode === "managed") return null;

  const resources = new ProtectedResourceRegistry();
  resources.register(createDatabaseResource());
  resources.register(createVercelResource());
  resources.register(createRailwayResource());
  resources.register(createCloudflareResource());
  resources.register(createNeonControlPlaneResource());

  // Detect external boundary extension for defense-in-depth.
  // exclusive mode requires pi-permission-system (or equivalent) to be
  // active so pi-ship is never the sole gatekeeper.
  const permissionSys = detectPermissionSystem();
  const isBoundaryActive = permissionSys.active;

  const keyStore = new EphemeralKeyStore();

  const enforcer = new BoundaryEnforcer(
    config.mode, resources, isBoundaryActive, approvalRegistry, cwd,
    new Map([[keyStore.getPublicKeyId(), keyStore.publicKey]]),
    "pi-ship-child",
  );
  const vault = new CredentialVault(credentialSource, resources, config.mode, approvalRegistry, cwd, keyStore);

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
    if (result.reason) {
      console.warn(`pi-ship: ${result.reason}`);
    }
    return undefined;
  });

  return { vault, enforcer, resources, publicKeyId: keyStore.getPublicKeyId() };
}
