import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalRegistry, requestApproval } from "../core/approval.js";
import { writeApprovalSidecar } from "../core/approval-store.js";
import { err } from "../core/errors.js";
import { applyPlan } from "../core/engine.js";
import { loadManifest } from "../core/manifest.js";
import { buildPlan } from "../core/plan.js";
import { loadPlan, persistPlan, verifyDigest } from "../core/plan-store.js";
import { loadState } from "../core/state.js";
import { authorizePlanApply } from "../core/authorization.js";
import { createRailwayAdapter } from "../providers/railway/index.js";

const starterManifest = {
  name: "my-app",
  provider: "railway",
  project: "my-app",
  run: { command: ["node", "index.js"] },
  checks: [["npm", "test"]],
  secrets: ["DATABASE_URL"],
  db: { provision: "external" },
};

export function registerShipCommands(pi: ExtensionAPI, registry: ApprovalRegistry): void {
  pi.registerCommand("ship-init", {
    description: "Create a starter pi-ship.json if absent",
    handler: async (_args, ctx) => {
      const path = join(ctx.cwd, "pi-ship.json");
      if (existsSync(path)) {
        ctx.ui.notify("pi-ship.json already exists", "warning");
        return;
      }
      await withFileMutationQueue(path, async () => {
        if (!existsSync(path)) await writeFile(path, JSON.stringify(starterManifest, null, 2) + "\n", "utf8");
      });
      ctx.ui.notify("Created pi-ship.json", "info");
    },
  });

  pi.registerCommand("ship-plan", {
    description: "Create and persist a deployment plan",
    handler: async (_args, ctx) => {
      const manifest = await loadManifest(ctx.cwd);
      const state = await loadState(ctx.cwd);
      const plan = await buildPlan(ctx.cwd, manifest, "production", { targetSnapshot: snapshot(state) });
      await persistPlan(ctx.cwd, plan);
      const approval = await requestApproval(ctx, plan, registry);
      if (approval.approved) {
        await writeApprovalSidecar(ctx.cwd, plan.planId, plan.planDigest, approval.approvedAt!, "production");
      }
      ctx.ui.notify(`Plan ${plan.planId} approved=${approval.approved}`, "info");
    },
  });

  pi.registerCommand("ship-apply", {
    description: "Apply an approved plan: /ship-apply <planId> <digest>",
    handler: async (args, ctx) => {
      const [planId, planDigest] = args.trim().split(/\s+/);
      if (!planId || !planDigest) {
        ctx.ui.notify("Usage: /ship-apply <planId> <digest>", "error");
        return;
      }
      await applyCommand(pi, ctx, planId, planDigest, registry);
    },
  });

  pi.registerCommand("ship-status", {
    description: "Show live deployment status",
    handler: async (_args, ctx) => {
      const manifest = await loadManifest(ctx.cwd);
      const state = await loadState(ctx.cwd);
      if (!state.serviceIds.app) { ctx.ui.notify("No service deployed", "warning"); return; }
      const adapter = createRailwayAdapter(pi, { apiToken: process.env.RAILWAY_API_TOKEN, projectToken: process.env.RAILWAY_TOKEN, projectId: state.projectId, environmentId: state.environmentId, serviceId: state.serviceIds.app,
        secretValues: [...(manifest.secrets ?? []).map((n) => process.env[n]), process.env.RAILWAY_API_TOKEN, process.env.RAILWAY_TOKEN].filter((v): v is string => !!v) });
      const status = await adapter.status(state.serviceIds.app);
      ctx.ui.notify(`Status: ${status.status}${status.url ? ` ${status.url}` : ""}`, "info");
    },
  });

  pi.registerCommand("ship-logs", {
    description: "Fetch logs: /ship-logs [lines=100]",
    handler: async (args, ctx) => {
      const parsedLines = Number(args.trim() || "100");
      const lines = Number.isFinite(parsedLines) && Number.isInteger(parsedLines) ? Math.min(Math.max(parsedLines, 1), 500) : 100;
      const manifest = await loadManifest(ctx.cwd);
      const state = await loadState(ctx.cwd);
      if (!state.serviceIds.app) {
        ctx.ui.notify("No service deployed", "warning");
        return;
      }
      const adapter = createRailwayAdapter(pi, {
        apiToken: process.env.RAILWAY_API_TOKEN,
        projectToken: process.env.RAILWAY_TOKEN,
        projectId: state.projectId,
        environmentId: state.environmentId,
        serviceId: state.serviceIds.app,
        secretValues: [...(manifest.secrets ?? []).map((n) => process.env[n]), process.env.RAILWAY_API_TOKEN, process.env.RAILWAY_TOKEN].filter((v): v is string => !!v),
      });
      const text = await adapter.logs(state.serviceIds.app, lines);
      ctx.ui.notify(text.slice(0, 200), "info");
    },
  });

  pi.registerCommand("ship-rollback", {
    description: "Rollback to a release: /ship-rollback <releaseId>",
    handler: async (args, ctx) => {
      const releaseId = args.trim();
      if (!releaseId) {
        ctx.ui.notify("Usage: /ship-rollback <releaseId>", "error");
        return;
      }
      const manifest = await loadManifest(ctx.cwd);
      const plan = await buildPlan(ctx.cwd, manifest, "production", {
        intent: "rollback",
        targetReleaseId: releaseId,
        targetSnapshot: snapshot(await loadState(ctx.cwd)),
      });
      await persistPlan(ctx.cwd, plan);
      const approval = await requestApproval(ctx, plan, registry);
      if (!approval.approved) {
        ctx.ui.notify("Rollback not approved", "warning");
        return;
      }
      await writeApprovalSidecar(ctx.cwd, plan.planId, plan.planDigest, approval.approvedAt!, "production");
      await applyCommand(pi, ctx, plan.planId, plan.planDigest, registry);
      ctx.ui.notify("Rollback applied. Database state untouched.", "info");
    },
  });

  /* Database destruction command intentionally removed. */
  /* pi.registerCommand("ship-db-destroy", {
    description: "Database destruction is unsupported; shows guidance only",
    handler: async (_args, ctx) => {
      const ok = await ctx.ui.confirm("Database destruction", "This command is for documentation only. Continue?");
      if (ok) {
        ctx.ui.notify("Database destruction is unsupported in MVP. Use Railway dashboard.", "info");
      }
    },
  }); */
}

function snapshot(state: Awaited<ReturnType<typeof loadState>>) {
  return { projectId: state.projectId, projectName: state.projectName, environmentId: state.environmentId, environmentName: state.environmentName, serviceIds: state.serviceIds, serviceNames: state.serviceNames };
}

async function applyCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, planId: string, planDigest: string, registry: ApprovalRegistry): Promise<void> {
  const cwd = ctx.cwd;
  const manifest = await loadManifest(cwd);
  const plan = await loadPlan(cwd, planId);
  await authorizePlanApply({ registry, cwd, plan, suppliedDigest: planDigest, manifest });
  const state = await loadState(cwd);
  const envReader = (names: string[]) => {
    const out: Record<string, string | undefined> = {};
    for (const n of names) out[n] = process.env[n];
    return out;
  };
  const adapter = createRailwayAdapter(pi, {
    apiToken: process.env.RAILWAY_API_TOKEN,
    projectToken: process.env.RAILWAY_TOKEN,
    projectId: state.projectId,
    environmentId: state.environmentId,
    serviceId: state.serviceIds.app,
    secretValues: plan.secretNames.map((n) => process.env[n]).filter((v): v is string => !!v),
  });
  await applyPlan({ adapter, manifest: plan.manifest, plan, cwd, envReader, piExec: pi.exec.bind(pi), registry, suppliedDigest: planDigest });
}
