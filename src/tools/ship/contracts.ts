import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalRegistry } from "../../core/approval.js";
import type { ToolResult } from "../../core/types.js";
import type { CredentialSource } from "../../deployment/credentials.js";
import type { RegistryServices } from "../../providers/contracts.js";
import type { ShipInput } from "./schema.js";

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
}

export type ShipHandler = (
  params: ShipInput,
  context: ShipHandlerContext,
) => Promise<ToolResult>;
