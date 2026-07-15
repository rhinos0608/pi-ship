import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ProviderAdapter } from "./adapter.js";
import { err, isShipError } from "../../core/errors.js";
import { appendJournal, readJournal } from "./journal.js";
import { authorizeRailwayPlanApply } from "./authorization.js";
import { ApprovalRegistry } from "../../core/approval.js";
import type { RailwayManifest } from "./manifest.js";
import type { RailwayPlan } from "./plan.js";
import { redact } from "../../core/redact.js";
import { loadRailwayState, saveRailwayState } from "./state.js";
import { statePath } from "../../persistence/state-store.js";
import type { Environment, ToolResult } from "../../core/types.js";

export interface ApplyRailwayContext {
  adapter: ProviderAdapter;
  manifest: RailwayManifest;
  plan: RailwayPlan;
  cwd: string;
  envReader: (names: string[]) => Record<string, string | undefined>;
  piExec: ExtensionAPI["exec"];
  registry: ApprovalRegistry;
  suppliedDigest: string;
  stateStore?: {
    load(): Promise<import("./state.js").LocalState>;
    save(state: import("./state.js").LocalState): Promise<void>;
  };
  signal?: AbortSignal;
}

export async function applyRailwayPlan(ctx: ApplyRailwayContext): Promise<ToolResult> {
  const { adapter, manifest, plan, cwd, envReader, piExec, signal } = ctx;
  const stateStore = ctx.stateStore ?? {
    load: () => loadRailwayState(cwd),
    save: (state: import("./state.js").LocalState) => saveRailwayState(cwd, state),
  };

  return withFileMutationQueue(statePath(cwd), async () => {
    const state = await stateStore.load();
    await authorizeRailwayPlanApply({ registry: ctx.registry, cwd, plan, suppliedDigest: ctx.suppliedDigest, manifest, state, signal });
    const journal = await readJournal(cwd, plan.planId);
    const completed = new Set(journal.filter((e) => e.status === "ok").map((e) => e.step));
    const terminal = new Set(journal.filter((e) => e.status === "ok" || e.status === "fail").map((e) => e.step));
    const dangling = journal.some((e) => e.status === "start" && !terminal.has(e.step));
    const nonIdempotent = new Set(["deploy", "migrate", "rollback", "deployPreview"]);
    if (dangling && journal.some((e) => e.status === "start" && !terminal.has(e.step) && nonIdempotent.has(e.step))) {
      throw err("E_STATE_CONFLICT", "journal contains incomplete non-idempotent side effect; manual reconciliation required");
    }
    if (state.history.some((h) => h.planId === plan.planId && h.digest === plan.planDigest && h.status === "ok")) {
      return okResult(plan, "Plan already applied.");
    }
    signal?.throwIfAborted();
    const secrets = envReader(plan.secretNames);
    const missing = plan.secretNames.filter((n) => !secrets[n]);
    if (missing.length > 0) {
      throw err("E_PRECONDITION", `missing secrets: ${missing.join(", ")}`);
    }

    let auth: { ok: boolean; missing?: string[] };
    try {
      auth = await adapter.checkAuth(signal);
    } catch (e) {
      if (signal?.aborted || (e instanceof Error && e.name === "AbortError")) throw err("E_CANCELLED", "operation cancelled", true);
      throw e;
    }
    if (!auth.ok) {
      throw err("E_AUTH_MISSING", `missing credentials: ${auth.missing?.join(", ")}`);
    }

    if (manifest.checks) {
      for (const argv of manifest.checks) {
        const result = await piExec(argv[0], argv.slice(1), { cwd, signal });
        if (result.code !== 0) {
          throw err("E_PRECONDITION", `check failed: ${argv.join(" ")}`);
        }
      }
    }

    async function step(name: string, mutating: boolean, fn: () => Promise<void>) {
      if (completed.has(name)) return;
      await appendJournal(cwd, { ts: new Date().toISOString(), planId: plan.planId, step: name, status: "start" });
      try {
        signal?.throwIfAborted();
        await fn();
        signal?.throwIfAborted();
        await appendJournal(cwd, { ts: new Date().toISOString(), planId: plan.planId, step: name, status: "ok" });
        completed.add(name);
      } catch (e) {
        const aborted = signal?.aborted || (e instanceof Error && (e.name === "AbortError" || e.message.includes("aborted")));
        const error = aborted ? err("E_CANCELLED", "operation cancelled", true) : (isShipError(e) ? e : err("E_PROVIDER", "provider operation failed"));
        await appendJournal(cwd, { ts: new Date().toISOString(), planId: plan.planId, step: name, status: "fail", error });
        throw error;
      }
    }

    if (plan.intent === "rollback") {
      if (!plan.targetReleaseId) throw err("E_PRECONDITION", "rollback plan missing targetReleaseId");
      if (!state.serviceIds.app) throw err("E_PRECONDITION", "no application service bound for rollback");
      await step("rollback", true, async () => {
        const r = await adapter.rollback(state.serviceIds.app!, plan.targetReleaseId!, signal);
        if (!r.ok) throw err("E_PROVIDER", "rollback failed");
      });
      return okResult(plan, "Rollback applied. Database state untouched.");
    }

    if (plan.intent === "migration") {
      if (!plan.migrationCommand) throw err("E_PRECONDITION", "migration plan missing command");
      await step("migrate", true, async () => {
        const argv = plan.migrationCommand!;
        const result = await piExec(argv[0], argv.slice(1), { cwd, signal });
        if (result.code !== 0) throw err("E_PROVIDER", "migration failed");
      });
      return okResult(plan, "Migration applied.");
    }

    // --- Preview environment handling ---
    if (plan.previewId) {
      if (!state.projectId || !state.environmentId || !state.serviceIds.app) {
        throw err("E_PRECONDITION", "preview deployment requires project, environment, and service to be resolved first");
      }
      const projectId: string = state.projectId;
      const previewEnvironmentIdBase: string = state.environmentId;
      const appServiceId: string = state.serviceIds.app;
      const previewId = plan.previewId;
      const previewName = `pr-${previewId}`;

      // 1. Create or reuse preview environment
      let previewEnvironmentId!: string;
      await step("createPreviewEnvironment", true, async () => {
        const previewEnv = await adapter.createPreviewEnvironment(projectId, previewName, previewEnvironmentIdBase, signal);
        previewEnvironmentId = previewEnv.environmentId;
      });

      // 2. Provision Postgres if configured
      let postgresServiceId: string | undefined;
      if (manifest.db?.provision === "railway-postgres") {
        await step("previewEnsurePostgres", true, async () => {
          const wsId = await adapter.getWorkspaceId(projectId, signal);
          if (!wsId) throw err("E_PROVIDER", "could not discover workspaceId");
          const pg = await adapter.ensurePostgres(projectId, previewEnvironmentId!, wsId, signal);
          postgresServiceId = pg.serviceId;
        });

        // Link Postgres reference variable
        await step("previewLinkPostgres", true, async () => {
          await adapter.linkPostgresToService(projectId, previewEnvironmentId!, appServiceId, undefined, signal);
        });
      }

      // 3. Set app secrets in preview environment
      await step("previewSetVariables", true, async () => {
        await adapter.setVariables(appServiceId, plan.secretNames, () => envReader(plan.secretNames), signal, previewEnvironmentId!);
      });

      // 4. Deploy to preview
      await step("deployPreview", true, async () => {
        await adapter.deployToPreview(appServiceId, previewEnvironmentId!, signal);
      });

      // Track preview in state
      state.previews ??= {};
      state.previews[previewId] = {
        environmentId: previewEnvironmentId,
        serviceId: appServiceId,
        projectId: projectId,
        postgresServiceId,
        createdAt: new Date().toISOString(),
      };
      await stateStore.save(state);

      return okResult(plan, `Preview ${previewName} deployed for ${manifest.name}.`);
    }

    await step("ensureProject", true, async () => {
      const r = await adapter.ensureProject(manifest.project, signal);
      if (!r.projectId || !r.environmentId) throw err("E_PRECONDITION", "provider did not return bound project and environment IDs");
      state.projectId = r.projectId;
      state.projectName = r.projectName ?? manifest.project;
      state.environmentId = r.environmentId ?? state.environmentId;
      state.environmentName = r.environmentName ?? state.environmentName ?? plan.environment;
      await stateStore.save(state);
    });

    await step("ensureService", true, async () => {
      const r = await adapter.ensureService(state.projectId!, `${manifest.project}-app`, signal);
      state.serviceIds.app = r.serviceId;
      state.serviceNames ??= {};
      state.serviceNames.app = r.serviceName ?? `${manifest.project}-app`;
      await stateStore.save(state);
    });

    if (manifest.db?.provision === "railway-postgres") {
      await step("provisionPostgres", true, async () => {
        const wsId = await adapter.getWorkspaceId(state.projectId!, signal);
        if (!wsId) throw err("E_PROVIDER", "could not discover workspaceId");
        const r = await adapter.provisionPostgres(state.projectId!, state.environmentId!, wsId, signal);
        if (!r.ok) throw err("E_PROVIDER", "postgres provisioning failed");
        state.serviceIds.postgres = r.serviceId;
        await stateStore.save(state);
      });
    }

    await step("setVariables", true, async () => {
      await adapter.setVariables(state.serviceIds.app!, plan.secretNames, () => envReader(plan.secretNames), signal);
    });

    if (!state.projectId || !state.environmentId || !state.serviceIds.app) throw err("E_PRECONDITION", "missing required persisted project, environment, or service ID");
    await step("deploy", true, async () => {
      const r = await adapter.deploy(state.serviceIds.app!, cwd, signal);
      state.lastRelease = {
        id: r.releaseId,
        digest: plan.planDigest,
        url: r.url,
        at: new Date().toISOString(),
      };
    });

    state.history.push({
      planId: plan.planId,
      digest: plan.planDigest,
      at: new Date().toISOString(),
      status: "ok",
    });
    await stateStore.save(state);

    return okResult(plan, `Deployed ${manifest.name} to ${plan.environment}. Release: ${state.lastRelease?.id}`);
  });
}

function okResult(plan: RailwayPlan, text: string): ToolResult {
  return {
    content: [{ type: "text", text: redact(text, plan.secretNames) }],
    details: {
      planId: plan.planId,
      environment: plan.environment,
      intent: plan.intent,
    },
  };
}
