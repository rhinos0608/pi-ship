import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalRegistry } from "../../core/approval.js";
import type { ToolResult } from "../../core/types.js";
import type { CredentialSource } from "../../deployment/credentials.js";
import type { RegistryServices } from "../../providers/contracts.js";
import type { ShipInput } from "./schema.js";

export interface ApprovedPlanBinding {
  provider: "cloudflare" | "vercel" | "railway" | "neon";
  planId: string;
  planDigest: string;
}

export interface ShipHandlerContext {
  manifest: unknown;
  cwd: string;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  registry: ApprovalRegistry;
  credentialSource: CredentialSource;
  signal?: AbortSignal;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  services: RegistryServices;

  /**
   * When a CredentialVault is active (exclusive mode), wraps execution in a
   * capability-backed ALS scope so credentialSource.get() calls are validated.
   * Undefined in managed mode — callers fall back to direct execution.
   */
  runApprovedOperation?<T>(binding: ApprovedPlanBinding, fn: () => T): T;
}

export type ShipHandler = (
  params: ShipInput,
  context: ShipHandlerContext,
) => Promise<ToolResult>;
