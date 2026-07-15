import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApprovalRegistry } from "../../core/approval.js";
import { writeApprovalSidecar } from "../../core/approval-store.js";
import { err } from "../../core/errors.js";
import { environmentSource, loadAppSecrets } from "../../deployment/credentials.js";
import type { RegistryServices } from "../contracts.js";
import { requestRailwayApproval } from "./approval.js";
import { authorizeRailwayPlanApply } from "./authorization.js";
import { applyRailwayPlan } from "./engine.js";
import { isRailwayExecution } from "./execution.js";
import { isRailwayManifest, type RailwayManifest } from "./manifest.js";
import { buildRailwayPlan, isRailwayPlan, type RailwayPlan } from "./plan.js";
import { isRailwayState, type LocalState } from "./state.js";

type ServicesFactory = (cwd: string) => RegistryServices;

const starterManifest = {
  name: "my-app",
  provider: "railway",
  project: "my-app",
  run: { command: ["node", "index.js"] },
  checks: [["npm", "test"]],
  secrets: ["DATABASE_URL"],
  db: { provision: "external" },
};

function requireManifest(value: unknown): RailwayManifest {
  if (!isRailwayManifest(value)) throw err("E_CONFIG_INVALID", "V2 manifest requires loadManifestContract");
  return value;
}

function requireState(value: unknown): LocalState {
  if (!isRailwayState(value)) throw err("E_STATE_CONFLICT", "expected V1 Railway state");
  return value;
}

function requirePlan(value: unknown): RailwayPlan {
  if (!isRailwayPlan(value)) throw err("E_CONFIG_INVALID", "plan has invalid shape");
  return value;
}

function snapshot(state: LocalState) {
  return {
    projectId: state.projectId,
    projectName: state.projectName,
    environmentId: state.environmentId,
    environmentName: state.environmentName,
    serviceIds: state.serviceIds,
    serviceNames: state.serviceNames,
  };
}

async function loadCommandContext(makeServices: ServicesFactory, cwd: string) {
  const services = makeServices(cwd);
  const manifest = requireManifest(await services.loadManifest());
  const state = requireState(await services.loadState("railway"));
  return { services, manifest, state };
}

function createAdapter(
  pi: ExtensionAPI,
  manifest: RailwayManifest,
  state: LocalState,
  secretNames: readonly string[],
  services: RegistryServices,
) {
  const source = environmentSource();
  const execution = services.createExecution(manifest, {
    pi,
    credentialSource: source,
    state,
    appSecretValues: Object.values(loadAppSecrets(source, secretNames)),
  });
  if (!isRailwayExecution(execution)) {
    throw err("E_STATE_CONFLICT", "Railway manifest resolved to a non-Railway execution");
  }
  return execution.adapter;
}

export function registerRailwayCommands(
  pi: ExtensionAPI,
  registry: ApprovalRegistry,
  makeServices: ServicesFactory,
): void {
  pi.registerCommand("ship-init", {
    description: "Create a starter pi-ship.json if absent",
    handler: async (_args, ctx) => {
      const path = join(ctx.cwd, "pi-ship.json");
      if (existsSync(path)) {
        ctx.ui.notify("pi-ship.json already exists", "warning");
        return;
      }
      await withFileMutationQueue(path, async () => {
        if (!existsSync(path)) await writeFile(path, `${JSON.stringify(starterManifest, null, 2)}\n`, "utf8");
      });
      ctx.ui.notify("Created pi-ship.json", "info");
    },
  });

  pi.registerCommand("ship-plan", {
    description: "Create and persist a deployment plan",
    handler: async (_args, ctx) => {
      const { services, manifest, state } = await loadCommandContext(makeServices, ctx.cwd);
      const plan = await buildRailwayPlan(ctx.cwd, manifest, "production", { targetSnapshot: snapshot(state) });
      await services.persistPlan("railway", plan);
      const approval = await requestRailwayApproval(ctx, plan, registry);
      if (approval.approved && approval.approvedAt) {
        await writeApprovalSidecar(ctx.cwd, plan.planId, plan.planDigest, approval.approvedAt, "production");
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
      await applyCommand(pi, ctx, planId, planDigest, registry, makeServices);
    },
  });

  pi.registerCommand("ship-status", {
    description: "Show live deployment status",
    handler: async (_args, ctx) => {
      const { services, manifest, state } = await loadCommandContext(makeServices, ctx.cwd);
      if (!state.serviceIds.app) {
        ctx.ui.notify("No service deployed", "warning");
        return;
      }
      const adapter = createAdapter(pi, manifest, state, manifest.secrets ?? [], services);
      const status = await adapter.status(state.serviceIds.app);
      ctx.ui.notify(`Status: ${status.status}${status.url ? ` ${status.url}` : ""}`, "info");
    },
  });

  pi.registerCommand("ship-logs", {
    description: "Fetch logs: /ship-logs [lines=100]",
    handler: async (args, ctx) => {
      const parsedLines = Number(args.trim() || "100");
      const lines = Number.isFinite(parsedLines) && Number.isInteger(parsedLines)
        ? Math.min(Math.max(parsedLines, 1), 500)
        : 100;
      const { services, manifest, state } = await loadCommandContext(makeServices, ctx.cwd);
      if (!state.serviceIds.app) {
        ctx.ui.notify("No service deployed", "warning");
        return;
      }
      const adapter = createAdapter(pi, manifest, state, manifest.secrets ?? [], services);
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
      const { services, manifest, state } = await loadCommandContext(makeServices, ctx.cwd);
      const plan = await buildRailwayPlan(ctx.cwd, manifest, "production", {
        intent: "rollback",
        targetReleaseId: releaseId,
        targetSnapshot: snapshot(state),
      });
      await services.persistPlan("railway", plan);
      const approval = await requestRailwayApproval(ctx, plan, registry);
      if (!approval.approved || !approval.approvedAt) {
        ctx.ui.notify("Rollback not approved", "warning");
        return;
      }
      await writeApprovalSidecar(ctx.cwd, plan.planId, plan.planDigest, approval.approvedAt, "production");
      await applyCommand(pi, ctx, plan.planId, plan.planDigest, registry, makeServices);
      ctx.ui.notify("Rollback applied. Database state untouched.", "info");
    },
  });
}

async function applyCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  planId: string,
  planDigest: string,
  registry: ApprovalRegistry,
  makeServices: ServicesFactory,
): Promise<void> {
  const cwd = ctx.cwd;
  const { services, manifest, state } = await loadCommandContext(makeServices, cwd);
  const plan = requirePlan(await services.loadPlan("railway", planId));
  await authorizeRailwayPlanApply({ registry, cwd, plan, suppliedDigest: planDigest, manifest, state });
  const source = environmentSource();
  const envReader = (names: string[]) => {
    const output: Record<string, string | undefined> = {};
    for (const name of names) output[name] = source.get(name);
    return output;
  };
  const adapter = createAdapter(pi, manifest, state, plan.secretNames, services);
  await applyRailwayPlan({
    adapter,
    manifest: plan.manifest,
    plan,
    cwd,
    envReader,
    piExec: pi.exec.bind(pi),
    registry,
    suppliedDigest: planDigest,
    stateStore: {
      load: async () => requireState(await services.loadState("railway")),
      save: (next) => services.saveState("railway", next),
    },
  });
}
