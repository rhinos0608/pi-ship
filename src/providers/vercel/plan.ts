import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { VercelManifestSchema, type VercelManifest, isVercelManifest, validateVercelManifestSemantics } from "./manifest.js";
import { canonicalize } from "../../core/canonicalize.js";
import { err } from "../../core/errors.js";
import { persistPlan, loadPlan, type PlanPersistOptions } from "../../persistence/plan-store.js";

const Strict = { additionalProperties: false } as const;
const NonEmpty = Type.String({ minLength: 1 });

export const LocalSourceRefSchema = Type.Object({
  kind: Type.Literal("local-files"), rootDirectory: NonEmpty,
  fileCount: Type.Integer({ minimum: 0 }), totalBytes: Type.Integer({ minimum: 0 }), fingerprint: NonEmpty,
}, Strict);

const Base = {
  operationId: NonEmpty, provider: Type.Literal("vercel"), domain: Type.Literal("app"),
  targetFingerprint: NonEmpty, requestFingerprint: NonEmpty, expectedStateFingerprint: NonEmpty,
  destructive: Type.Literal(false), reversible: Type.Boolean(), dependsOn: Type.Array(Type.String()),
};

export const VercelOperationSchema = Type.Union([
  Type.Object({ ...Base, kind: Type.Literal("ensure_project"), projectName: NonEmpty, observedProjectId: Type.Optional(NonEmpty), reversible: Type.Literal(false) }, Strict),
  Type.Object({ ...Base, kind: Type.Literal("upsert_secrets"), projectName: NonEmpty, environment: Type.Union([Type.Literal("preview"), Type.Literal("production")]), secretNames: Type.Array(NonEmpty), reversible: Type.Literal(false) }, Strict),
  Type.Object({ ...Base, kind: Type.Literal("deploy"), projectName: NonEmpty, observedProjectId: Type.Optional(NonEmpty), environment: Type.Union([Type.Literal("preview"), Type.Literal("production")]), source: LocalSourceRefSchema }, Strict),
  Type.Object({ ...Base, kind: Type.Literal("rollback"), projectId: NonEmpty, environment: Type.Literal("production"), targetDeploymentId: NonEmpty, reversible: Type.Literal(true) }, Strict),
]);

export const VercelPlanSchema = Type.Object({
  version: Type.Literal(2), planId: NonEmpty, domain: Type.Literal("app"), manifest: VercelManifestSchema,
  provider: Type.Literal("vercel"), environment: Type.Union([Type.Literal("preview"), Type.Literal("production")]),
  intent: Type.Union([Type.Literal("deploy"), Type.Literal("rollback")]),
  identity: Type.Object({
    account: Type.Object({ kind: Type.Union([Type.Literal("team"), Type.Literal("user")]), id: NonEmpty }, Strict),
    project: Type.Object({ name: NonEmpty, observedId: Type.Optional(NonEmpty) }, Strict),
    environment: Type.Union([Type.Literal("preview"), Type.Literal("production")]),
  }, Strict),
  accountFingerprint: NonEmpty, projectFingerprint: NonEmpty, targetFingerprint: NonEmpty,
  gitCommit: Type.String(), gitDirty: Type.Boolean(), worktreeHash: Type.String(), source: Type.Optional(LocalSourceRefSchema),
  secretNames: Type.Array(NonEmpty), operations: Type.Array(VercelOperationSchema), estimatedImpact: NonEmpty,
  createdAt: NonEmpty, planDigest: NonEmpty,
}, Strict);

export type LocalSourceRef = Static<typeof LocalSourceRefSchema>;
export type VercelOperation = Static<typeof VercelOperationSchema>;
export type VercelPlan = Omit<Static<typeof VercelPlanSchema>, "manifest" | "operations"> & { manifest: VercelManifest; operations: VercelOperation[] };

export function isVercelPlan(value: unknown): value is VercelPlan { return Value.Check(VercelPlanSchema, value); }
export function computeVercelFingerprint(value: unknown): string { return createHash("sha256").update(canonicalize(value)).digest("hex"); }
export function computeVercelRequestFingerprint(pick: { provider: "vercel"; kind: string; targetFingerprint: string; requestPayload: unknown }): string { return computeVercelFingerprint(pick); }
export function computeVercelOperationId(pick: { provider: "vercel"; kind: string; targetFingerprint: string; requestFingerprint: string }): string { return computeVercelFingerprint(pick); }
export function computeVercelPlanDigest(plan: unknown): string {
  const input = plan as Record<string, unknown>;
  const { planDigest: _, ...rest } = input;
  return computeVercelFingerprint(rest);
}

export interface VercelSourceSnapshotFile { path: string; size: number; contentHash: string }
export interface VercelSourceSnapshot { rootDirectory: string; files: VercelSourceSnapshotFile[]; fileCount: number; totalBytes: number; fingerprint: string }

export async function snapshotVercelSource(cwd: string, rootDirectory = "."): Promise<VercelSourceSnapshot> {
  const root = join(cwd, rootDirectory);
  const files: VercelSourceSnapshotFile[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if ([".git", ".pi-ship", "node_modules"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const content = await readFile(path);
        files.push({ path: relative(root, path).replaceAll("\\", "/"), size: content.length, contentHash: createHash("sha256").update(content).digest("hex") });
      }
    }
  }
  await walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  return { rootDirectory, files, fileCount: files.length, totalBytes, fingerprint: computeVercelFingerprint(files) };
}

// ── Shared operation builder (pure, no I/O) ─────────────────────────────────────

export function buildVercelOperations(
  intent: "deploy" | "rollback",
  environment: "preview" | "production",
  options: {
    projectName: string;
    secretNames?: string[];
    source?: LocalSourceRef;
    observedProjectId?: string;
    targetDeploymentId?: string;
  },
): VercelOperation[] {
  const targetFingerprint = computeVercelFingerprint({
    project: options.projectName,
    environment,
    observedProjectId: options.observedProjectId,
  });
  const make = (
    kind: VercelOperation["kind"],
    payload: Record<string, unknown>,
    dependsOn: string[],
    reversible: boolean,
  ): VercelOperation => {
    const requestFingerprint = computeVercelRequestFingerprint({
      provider: "vercel",
      kind,
      targetFingerprint,
      requestPayload: payload,
    });
    const operationId = computeVercelOperationId({
      provider: "vercel",
      kind,
      targetFingerprint,
      requestFingerprint,
    });
    return {
      ...payload,
      operationId,
      provider: "vercel",
      domain: "app",
      kind,
      targetFingerprint,
      requestFingerprint,
      expectedStateFingerprint: computeVercelFingerprint({
        targetFingerprint,
        kind,
        requestFingerprint,
      }),
      destructive: false,
      reversible,
      dependsOn,
    } as VercelOperation;
  };

  if (intent === "rollback") {
    return [
      make(
        "rollback",
        {
          projectId: options.observedProjectId,
          environment,
          targetDeploymentId: options.targetDeploymentId,
        },
        [],
        true,
      ),
    ];
  }

  const project = make(
    "ensure_project",
    { projectName: options.projectName },
    [],
    false,
  );
  const secrets = make(
    "upsert_secrets",
    {
      projectName: options.projectName,
      environment,
      secretNames: options.secretNames ?? [],
    },
    [project.operationId],
    false,
  );
  const deploy = make(
    "deploy",
    {
      projectName: options.projectName,
      ...(options.observedProjectId ? { observedProjectId: options.observedProjectId } : {}),
      environment,
      source: options.source,
    },
    [secrets.operationId],
    environment === "production",
  );
  return [project, secrets, deploy];
}

export async function buildVercelPlan(
  cwd: string, manifest: VercelManifest, environment: "preview" | "production", intent: "deploy" | "rollback",
  options: { planId?: string; createdAt?: string; accountRef?: { kind: "team" | "user"; id: string }; source?: LocalSourceRef; observedProjectId?: string; targetDeploymentId?: string; gitCommit?: string; gitDirty?: boolean; worktreeHash?: string } = {},
): Promise<VercelPlan> {
  if (!isVercelManifest(manifest)) throw err("E_CONFIG_INVALID", "manifest has invalid V2 shape");
  validateVercelManifestSemantics(manifest);
  if (!options.accountRef?.id) throw err("E_CONFIG_INVALID", "verified accountRef is required");
  if (intent === "rollback" && environment !== "production") throw err("E_CONFIG_INVALID", "rollback is only supported in production");
  if (intent === "rollback" && (!options.observedProjectId || !options.targetDeploymentId)) throw err("E_CONFIG_INVALID", "rollback requires target deployment and observed project ID");
  if (intent === "deploy" && !options.source) throw err("E_CONFIG_INVALID", "deploy plan requires explicit source reference");
  const source = options.source;
  const targetFingerprint = computeVercelFingerprint({ project: manifest.app.config.projectName, environment, observedProjectId: options.observedProjectId });

  const operations = buildVercelOperations(intent, environment, {
    projectName: manifest.app.config.projectName,
    secretNames: manifest.secrets ?? [],
    source,
    observedProjectId: options.observedProjectId,
    targetDeploymentId: options.targetDeploymentId,
  });

  const effectiveTeamId = manifest.app.config.teamId ?? (options.accountRef.kind === "team" ? options.accountRef.id : undefined);
  const base = { version: 2 as const, planId: options.planId ?? randomUUID(), domain: "app" as const, manifest, provider: "vercel" as const, environment, intent, identity: { account: options.accountRef, project: { name: manifest.app.config.projectName, observedId: options.observedProjectId }, environment }, accountFingerprint: computeVercelFingerprint(options.accountRef), projectFingerprint: computeVercelFingerprint({ name: manifest.app.config.projectName, teamId: effectiveTeamId }), targetFingerprint, gitCommit: options.gitCommit ?? "unknown", gitDirty: options.gitDirty ?? false, worktreeHash: options.worktreeHash ?? "", source, secretNames: manifest.secrets ?? [], operations, estimatedImpact: `${operations.length} Vercel operation(s)`, createdAt: options.createdAt ?? new Date().toISOString() };
  const plan = { ...base, planDigest: computeVercelPlanDigest(base) };
  if (!Value.Check(VercelPlanSchema, plan)) throw err("E_CONFIG_INVALID", "built V2 plan has invalid shape");
  return plan;
}

// ── Vercel plan persistence wrappers ───────────────────────────────────────────

const vercelPlanOptions: PlanPersistOptions = {
  isValid: (p) => isVercelPlan(p),
  computeDigest: (p) => {
    const input = p as Record<string, unknown>;
    const { planDigest: _, ...rest } = input;
    return computeVercelFingerprint(rest);
  },
};

export async function persistVercelPlan(cwd: string, plan: unknown): Promise<void> {
  return persistPlan(cwd, plan, vercelPlanOptions);
}

export async function loadVercelPlan(cwd: string, planId: string): Promise<VercelPlan> {
  return loadPlan(cwd, planId, vercelPlanOptions) as Promise<VercelPlan>;
}
