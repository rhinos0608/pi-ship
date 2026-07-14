import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ProviderAdapter } from "../providers/types.js";
import { err, type ShipError } from "./errors.js";
import { appendJournal, readJournal } from "./journal.js";
import { authorizePlanApply } from "./authorization.js";
import { ApprovalRegistry } from "./approval.js";
import type { Manifest } from "./manifest.js";
import type { Plan } from "./plan.js";
import { redact } from "./redact.js";
import { loadState, saveState, statePath } from "./state.js";
import type { Environment, ToolResult } from "./types.js";

export interface ApplyContext {
  adapter: ProviderAdapter;
  manifest: Manifest;
  plan: Plan;
  cwd: string;
  envReader: (names: string[]) => Record<string, string | undefined>;
  piExec: ExtensionAPI["exec"];
  registry: ApprovalRegistry;
  suppliedDigest: string;
  signal?: AbortSignal;
}

export async function applyPlan(ctx: ApplyContext): Promise<ToolResult> {
  const { adapter, manifest, plan, cwd, envReader, piExec, signal } = ctx;
  await authorizePlanApply({ registry: ctx.registry, cwd, plan, suppliedDigest: ctx.suppliedDigest, manifest, signal });

  return withFileMutationQueue(statePath(cwd), async () => {
    const state = await loadState(cwd);
    const journal = await readJournal(cwd, plan.planId);
    const completed = new Set(journal.filter((e) => e.status === "ok").map((e) => e.step));
    const terminal = new Set(journal.filter((e) => e.status === "ok" || e.status === "fail").map((e) => e.step));
    const dangling = journal.some((e) => e.status === "start" && !terminal.has(e.step));
    const nonIdempotent = new Set(["deploy", "migrate", "rollback"]);
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
      await step("rollback", true, async () => {
        const r = await adapter.rollback(state.serviceIds.app ?? "", plan.targetReleaseId!, signal);
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

    await step("ensureProject", true, async () => {
      const r = await adapter.ensureProject(manifest.project, signal);
      if (!r.projectId || !r.environmentId) throw err("E_PRECONDITION", "provider did not return bound project and environment IDs");
      state.projectId = r.projectId;
      state.projectName = r.projectName ?? manifest.project;
      state.environmentId = r.environmentId ?? state.environmentId;
      state.environmentName = r.environmentName ?? state.environmentName ?? plan.environment;
      await saveState(cwd, state);
    });

    await step("ensureService", true, async () => {
      const r = await adapter.ensureService(state.projectId!, `${manifest.project}-app`, signal);
      state.serviceIds.app = r.serviceId;
      state.serviceNames ??= {};
      state.serviceNames.app = r.serviceName ?? `${manifest.project}-app`;
      await saveState(cwd, state);
    });

    if (manifest.db?.provision === "railway-postgres") {
      await step("provisionPostgres", true, async () => {
        throw err("E_PHASE_UNSUPPORTED", "Railway Postgres auto-provision is disabled in MVP; use existing DATABASE_URL");
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
    await saveState(cwd, state);

    return okResult(plan, `Deployed ${manifest.name} to ${plan.environment}. Release: ${state.lastRelease?.id}`);
  });
}

function okResult(plan: Plan, text: string): ToolResult {
  return {
    content: [{ type: "text", text: redact(text, plan.secretNames) }],
    details: {
      planId: plan.planId,
      environment: plan.environment,
      intent: plan.intent,
    },
  };
}

function isShipError(value: unknown): value is ShipError {
  return !!value && typeof value === "object" && "code" in value && typeof (value as ShipError).code === "string";
}
