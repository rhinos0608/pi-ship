import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { NeonAdapter } from "./adapter.js";
import { err, isShipError } from "../../core/errors.js";
import { appendJournal, readJournal } from "./journal.js";
import { authorizeNeonPlanApply } from "./authorization.js";
import { ApprovalRegistry } from "../../core/approval.js";
import type { NeonManifest } from "./manifest.js";
import type { NeonPlan } from "./plan.js";
import { redact } from "../../core/redact.js";
import { statePath } from "../../persistence/state-store.js";
import type { ToolResult } from "../../core/types.js";
import type { NeonState } from "./state.js";
import { loadNeonState, saveNeonState, redactConnectionUri } from "./state.js";

export interface ApplyNeonContext {
  adapter: NeonAdapter;
  manifest: NeonManifest;
  plan: NeonPlan;
  cwd: string;
  envReader: (names: string[]) => Record<string, string | undefined>;
  piExec: ExtensionAPI["exec"];
  registry: ApprovalRegistry;
  suppliedDigest: string;
  stateStore?: {
    load(): Promise<NeonState>;
    save(state: NeonState): Promise<void>;
  };
  signal?: AbortSignal;
}

export async function applyNeonPlan(ctx: ApplyNeonContext): Promise<ToolResult> {
  const { adapter, manifest, plan, cwd, envReader, piExec, signal } = ctx;
  const stateStore = ctx.stateStore ?? {
    load: () => loadNeonState(cwd),
    save: (state: NeonState) => saveNeonState(cwd, state),
  };

  return withFileMutationQueue(statePath(cwd), async () => {
    const state = await stateStore.load();
    await authorizeNeonPlanApply({
      registry: ctx.registry,
      cwd,
      plan,
      suppliedDigest: ctx.suppliedDigest,
      signal,
    });
    const journal = await readJournal(cwd, plan.planId);
    // Use latest entry per step by journal order (append-only, later entries are newer).
    // This prevents older terminal entries from masking newer incomplete/failed entries.
    const latestByStep = new Map<string, (typeof journal)[number]>();
    for (const e of journal) {
      latestByStep.set(e.step, e);
    }
    const completed = new Set(
      [...latestByStep.values()].filter((e) => e.status === "ok").map((e) => e.step),
    );
    // Non-idempotent "migrate" step: throw if latest status is start or fail
    const migrateEntry = latestByStep.get("migrate");
    if (migrateEntry && (migrateEntry.status === "start" || migrateEntry.status === "fail")) {
      throw err("E_STATE_CONFLICT", "journal contains incomplete non-idempotent migrate step; manual reconciliation required");
    }

    if (state.history.some((h) => h.planId === plan.planId && h.digest === plan.planDigest && h.status === "ok")) {
      return okResult(plan, "Plan already applied.");
    }

    signal?.throwIfAborted();

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

    // Resolve branch name from manifest, defaulting to project name
    const branchName = manifest.branch?.name ?? manifest.project;
    const databaseName = manifest.branch?.databaseName ?? "neondb";
    const roleName = manifest.branch?.roleName ?? "neondb_owner";

    switch (plan.intent) {
      case "provision": {
        await step("ensureProject", true, async () => {
          const r = await adapter.ensureProject(
            manifest.project,
            { pgVersion: manifest.pgVersion, regionId: manifest.regionId },
            signal,
          );
          state.projectId = r.projectId;
          state.projectName = r.projectName;
          await stateStore.save(state);
        });

        await step("ensureBranch", true, async () => {
          const r = await adapter.ensureBranch(
            state.projectId!,
            branchName,
            undefined, // no parent — root branch
            { databaseName, roleName },
            signal,
          );
          if (r.connectionUri) {
            state.connectionUris[branchName] = redactConnectionUri(r.connectionUri);
          }
          state.branchIds[branchName] = r.branchId;
          await stateStore.save(state);
        });

        await step("getConnectionUri", true, async () => {
          const uri = await adapter.getConnectionUri(state.projectId!, state.branchIds[branchName], databaseName, roleName, signal);
          state.connectionUris[branchName] = redactConnectionUri(uri);
          await stateStore.save(state);
        });
        break;
      }

      case "migration": {
        if (!plan.migrationCommand) throw err("E_PRECONDITION", "migration plan missing migrationCommand");

        await step("ensureBranch", true, async () => {
          const r = await adapter.ensureBranch(
            state.projectId!,
            branchName,
            undefined,
            { databaseName, roleName },
            signal,
          );
          if (r.connectionUri) {
            state.connectionUris[branchName] = redactConnectionUri(r.connectionUri);
          }
          state.branchIds[branchName] = r.branchId;
          await stateStore.save(state);
        });

        await step("migrate", true, async () => {
          const argv = plan.migrationCommand!;
          // Fetch fresh connection URI (with password) for migration
          const dbUri = await adapter.getConnectionUri(state.projectId!, state.branchIds[branchName], databaseName, roleName, signal);
          // Credential injection: scoped to subprocess lifetime only.
          // DATABASE_URL is set in process.env for the duration of piExec.
          // The boundary layer ensures no other tool can access it in exclusive mode.
          const prevDbUrl = process.env.DATABASE_URL;
          process.env.DATABASE_URL = dbUri;
          try {
            const result = await piExec(argv[0], argv.slice(1), { cwd, signal });
            if (result.code !== 0) throw err("E_PROVIDER", "migration failed");
          } finally {
            if (prevDbUrl !== undefined) {
              process.env.DATABASE_URL = prevDbUrl;
            } else {
              delete process.env.DATABASE_URL;
            }
          }
        });

        await step("getConnectionUri", true, async () => {
          const uri = await adapter.getConnectionUri(state.projectId!, state.branchIds[branchName], databaseName, roleName, signal);
          state.connectionUris[branchName] = redactConnectionUri(uri);
          await stateStore.save(state);
        });
        break;
      }

      case "preview": {
        const parentBranchId = plan.sourceBranchId ?? state.branchIds[branchName];
        if (!parentBranchId) {
          throw err("E_PRECONDITION", "no parent branch available for preview; provision first");
        }

        await step("createPreviewBranch", true, async () => {
          const previewName = `${branchName}-${plan.planId.slice(0, 8)}`;
          const r = await adapter.createPreviewBranch(
            state.projectId!,
            parentBranchId,
            previewName,
            plan.previewExpiresAt,
            signal,
          );
          state.branchIds[previewName] = r.branchId;
          state.connectionUris[previewName] = redactConnectionUri(r.connectionUri);
          await stateStore.save(state);
        });
        break;
      }

        default: {
        throw err("E_CONFIG_INVALID", `unknown plan intent: ${(plan as { intent: string }).intent}`);
      }
    }

    state.history.push({
      planId: plan.planId,
      digest: plan.planDigest,
      at: new Date().toISOString(),
      status: "ok",
    });
    await stateStore.save(state);

    return okResult(plan, `Applied ${plan.intent} plan for ${manifest.project}.`);
  });
}

function okResult(plan: NeonPlan, text: string): ToolResult {
  return {
    content: [{ type: "text", text: redact(text, plan.secretNames) }],
    details: {
      planId: plan.planId,
      environment: plan.environment,
      intent: plan.intent,
    },
  };
}
