import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { ApprovalRegistry } from "./core/approval.js";
import type { DbOpsInput } from "./tools/db-ops.js";
import type { ShipOpsInput } from "./tools/ship-ops.js";

export function registerGate(pi: ExtensionAPI, registry: ApprovalRegistry): void {
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType<"ship_ops", ShipOpsInput>("ship_ops", event)) {
      const input = event.input;
      if (input.action === "apply_plan") {
        if (!registry.isApproved(input.planId, input.planDigest, ctx.cwd)) {
          return { block: true, reason: `apply_plan ${input.planId} lacks approval` };
        }
      }
    }
    if (isToolCallEventType<"db_ops", DbOpsInput>("db_ops", event)) {
      const raw = event.input as Record<string, unknown>;
      if ("command" in raw) {
        return { block: true, reason: "db_ops must not include a command field" };
      }
      if (raw.action === "apply_plan" && !registry.isApproved(String(raw.planId), String(raw.planDigest), ctx.cwd)) {
        return { block: true, reason: `apply_plan ${String(raw.planId)} lacks approval` };
      }
    }
    return undefined;
  });
}
