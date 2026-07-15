import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalRegistry } from "../../core/approval.js";
import type { Environment, ToolResult } from "../../core/types.js";
import type { CredentialSource } from "../../deployment/credentials.js";
import type { RegistryServices } from "../../providers/contracts.js";
import type { DBInput } from "./schema.js";

export interface DatabaseHandlerContext {
  manifest: unknown;
  cwd: string;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  registry: ApprovalRegistry;
  credentialSource: CredentialSource;
  environment: Environment;
  signal?: AbortSignal;
  services: RegistryServices;
}

export type DatabaseHandler = (
  params: DBInput,
  context: DatabaseHandlerContext,
) => Promise<ToolResult>;
