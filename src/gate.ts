import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { ApprovalRegistry } from "./core/approval.js";
import type { DBInput } from "./tools/db/schema.js";
import type { ShipInput } from "./tools/ship/schema.js";
import { readPlanFile } from "./persistence/plan-store.js";
import { validateDatabasePlan } from "./database/plan.js";

export function registerGate(pi: ExtensionAPI, registry: ApprovalRegistry): void {
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType<"ship", ShipInput>("ship", event)) {
      const input = event.input;
      if (input.action === "apply_plan") {
        try {
          const rawPlan = await readPlanFile(ctx.cwd, input.planId);
          if (rawPlan && typeof rawPlan === "object" && (rawPlan as Record<string, unknown>).kind === "db-plan/1") {
            let databasePlan;
            try { databasePlan = validateDatabasePlan(rawPlan); } catch {
              return { block: true, reason: `apply_plan ${input.planId} has invalid db-plan/1` };
            }
            if (databasePlan.planId !== input.planId || databasePlan.planDigest !== input.planDigest) {
              return { block: true, reason: `apply_plan ${input.planId} plan identity mismatch` };
            }
            const risk = databasePlan.riskLevel === "destructive" ? "destructive" : "write";
            if (!registry.isApproved(input.planId, input.planDigest, ctx.cwd, { domain: "database", risk })) {
              return { block: true, reason: `apply_plan ${input.planId} lacks approval` };
            }
            return undefined;
          }
        } catch {
          // No persisted provider plan: retain legacy generic approval behavior.
        }
        if (!registry.isApproved(input.planId, input.planDigest, ctx.cwd)) {
          return { block: true, reason: `apply_plan ${input.planId} lacks approval` };
        }
      }
    }
    if (isToolCallEventType<"DB", DBInput>("DB", event)) {
      const raw = event.input as Record<string, unknown>;
      if ("command" in raw) {
        return { block: true, reason: "DB must not include a command field" };
      }
      if (raw.action === "apply_plan") {
        try {
          const rawPlan = await readPlanFile(ctx.cwd, String(raw.planId));
          if (!rawPlan || typeof rawPlan !== "object" || (rawPlan as Record<string, unknown>).kind !== "db-plan/1") {
            if (!registry.isApproved(String(raw.planId), String(raw.planDigest), ctx.cwd)) {
              return { block: true, reason: `apply_plan ${String(raw.planId)} lacks approval` };
            }
            return undefined;
          }
          try {
            validateDatabasePlan(rawPlan);
          } catch {
            return { block: true, reason: `apply_plan ${String(raw.planId)} has invalid db-plan/1` };
          }
          const plan = rawPlan as Record<string, unknown>;
          // Supplied identity must equal persisted identity
          if (String(raw.planId) !== plan.planId) {
            return { block: true, reason: `apply_plan ${String(raw.planId)} plan ID mismatch` };
          }
          if (String(raw.planDigest) !== plan.planDigest) {
            return { block: true, reason: `apply_plan ${String(raw.planId)} digest mismatch` };
          }
          // Approved check with database risk metadata
          const risk = plan.riskLevel === "destructive" ? "destructive" : "write";
          const approved = registry.isApproved(String(raw.planId), String(raw.planDigest), ctx.cwd, {
            domain: "database",
            risk,
          });
          if (!approved) return { block: true, reason: `apply_plan ${String(raw.planId)} lacks approval` };
          // Generic approval never unlocks DB plan — already covered by scoped check above
        } catch (error) {
          return { block: true, reason: `apply_plan ${String(raw.planId)} has invalid plan` };
        }
      }
    }
    return undefined;
  });
}
