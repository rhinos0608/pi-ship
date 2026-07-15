import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { RailwayManifest } from "./manifest.js";
import { RailwayManifestSchema } from "./manifest.js";
import { err } from "../../core/errors.js";
import type { Environment } from "../../core/types.js";
import { deepSort, canonicalize as coreCanonicalize } from "../../core/canonicalize.js";
import { persistPlan, loadPlan, type PlanPersistOptions } from "../../persistence/plan-store.js";
import { gatherGit } from "../../core/git.js";
import { environmentSource } from "../../deployment/credentials.js";

const Strict = { additionalProperties: false } as const;

const ResourceActionSchema = Type.Object({
  action: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("rollback")]),
  resource: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
}, Strict);

const TargetSnapshotSchema = Type.Object({
  projectId: Type.Optional(Type.String()),
  projectName: Type.Optional(Type.String()),
  environmentId: Type.Optional(Type.String()),
  environmentName: Type.Optional(Type.String()),
  serviceIds: Type.Optional(Type.Object({
    app: Type.Optional(Type.String()),
    postgres: Type.Optional(Type.String()),
  }, Strict)),
  serviceNames: Type.Optional(Type.Object({
    app: Type.Optional(Type.String()),
    postgres: Type.Optional(Type.String()),
  }, Strict)),
}, Strict);

/** Strict RailwayPlan schema with nested additionalProperties: false */
export const RailwayPlanSchema = Type.Object({
  planId: Type.String({ minLength: 1 }),
  manifest: RailwayManifestSchema,
  gitCommit: Type.String(),
  gitDirty: Type.Boolean(),
  worktreeHash: Type.String(),
  provider: Type.Literal("railway"),
  environment: Type.Union([Type.Literal("development"), Type.Literal("preview"), Type.Literal("production")]),
  resourceActions: Type.Array(ResourceActionSchema),
  secretNames: Type.Array(Type.String()),
  migrationCommand: Type.Optional(Type.Array(Type.String())),
  estimatedImpact: Type.String(),
  planDigest: Type.String({ minLength: 1 }),
  createdAt: Type.String({ minLength: 1 }),
  intent: Type.Union([Type.Literal("deploy"), Type.Literal("rollback"), Type.Literal("migration")]),
  targetReleaseId: Type.Optional(Type.String()),
  targetSnapshot: Type.Optional(TargetSnapshotSchema),
}, Strict);

export interface ResourceAction {
  action: "create" | "update" | "rollback";
  resource: string;
  name: string;
}

export interface RailwayPlan {
  planId: string;
  manifest: RailwayManifest;
  gitCommit: string;
  gitDirty: boolean;
  worktreeHash: string;
  provider: "railway";
  environment: Environment;
  resourceActions: ResourceAction[];
  secretNames: string[];
  migrationCommand?: string[];
  estimatedImpact: string;
  planDigest: string;
  createdAt: string;
  intent: "deploy" | "rollback" | "migration";
  targetReleaseId?: string;
  targetSnapshot?: {
    projectId?: string;
    projectName?: string;
    environmentId?: string;
    environmentName?: string;
    serviceIds?: { app?: string; postgres?: string };
    serviceNames?: { app?: string; postgres?: string };
  };
}

export interface BuildRailwayPlanOptions {
  intent?: "deploy" | "rollback" | "migration";
  targetReleaseId?: string;
  planId?: string;
  createdAt?: string;
  targetSnapshot?: RailwayPlan["targetSnapshot"];
}

export async function buildRailwayPlan(
  cwd: string,
  manifest: RailwayManifest,
  environment: Environment,
  options: BuildRailwayPlanOptions = {}
): Promise<RailwayPlan> {
  const { gitCommit, gitDirty, worktreeHash } = await gatherGit(cwd);
  const intent = options.intent ?? "deploy";
  const secretNames = intent === "rollback" ? [] : (manifest.secrets ?? []);
  const migrationCommand = intent === "rollback" ? undefined : manifest.db?.migrate?.command;
  rejectSecretCommands([manifest.run.command, ...(manifest.build ? [manifest.build.command] : []), ...(manifest.checks ?? []), ...(migrationCommand ? [migrationCommand] : [])], secretNames);
  const resourceActions = deriveResourceActions(manifest, environment, intent, options.targetReleaseId);
  const base: Omit<RailwayPlan, "planDigest"> = {
    planId: options.planId ?? randomUUID(),
    manifest,
    gitCommit,
    gitDirty,
    worktreeHash,
    provider: "railway",
    environment,
    resourceActions,
    secretNames,
    migrationCommand,
    estimatedImpact: deriveImpact(environment, resourceActions, migrationCommand),
    createdAt: options.createdAt ?? new Date().toISOString(),
    intent,
    targetReleaseId: options.targetReleaseId,
    targetSnapshot: options.targetSnapshot,
  };
  const planDigest = computeDigest(base);
  return { ...base, planDigest };
}

/**
 * Railway-specific canonicalization.
 * Filters planDigest before sorting — preserves existing callers.
 */
export function canonicalize(plan: unknown): string {
  const ordered: Record<string, unknown> = {};
  const input = (plan && typeof plan === "object") ? plan as Record<string, unknown> : {};
  const keys = Object.keys(input)
    .filter((k) => k !== "planDigest")
    .sort();
  for (const key of keys) {
    ordered[key] = deepSort(input[key]);
  }
  return JSON.stringify(ordered);
}

/**
 * Compute digest for Railway plan (omitting planDigest field).
 */
export function computeDigest(plan: Omit<RailwayPlan, "planDigest">): string {
  return createHash("sha256").update(canonicalize(plan)).digest("hex");
}

/**
 * Generic plan digest calculator — explicitly strips planDigest then hashes using core canonicalize.
 */
export function computePlanDigest(plan: unknown): string {
  const input = plan as Record<string, unknown>;
  const { planDigest: _, ...rest } = input;
  return createHash("sha256").update(coreCanonicalize(rest)).digest("hex");
}

/**
 * Strict plan predicate using RailwayPlanSchema.
 */
export function isRailwayPlan(value: unknown): value is RailwayPlan {
  return Value.Check(RailwayPlanSchema, value);
}

/**
 * Railway-specific plan persistence wrappers used by commands and tools.
 */
const railwayPlanOptions: PlanPersistOptions = {
  isValid: (p) => isRailwayPlan(p),
  computeDigest: (p) => computePlanDigest(p),
};

export async function persistRailwayPlan(cwd: string, plan: unknown): Promise<void> {
  return persistPlan(cwd, plan, railwayPlanOptions);
}

export async function loadRailwayPlan(cwd: string, planId: string): Promise<RailwayPlan> {
  return loadPlan(cwd, planId, railwayPlanOptions) as Promise<RailwayPlan>;
}

export function verifyDigest(plan: unknown, suppliedDigest: string): void {
  const p = plan as { planDigest: string };
  const digest = computePlanDigest(plan);
  if (digest !== p.planDigest || suppliedDigest !== p.planDigest) {
    throw err("E_DIGEST_MISMATCH", "supplied digest does not match plan");
  }
}

export async function isRailwayPlanStale(plan: RailwayPlan, cwd: string, ttlMinutes = 30): Promise<boolean> {
  const now = Date.now();
  const created = new Date(plan.createdAt).getTime();
  if (Number.isNaN(created)) return true;
  if (now - created > ttlMinutes * 60 * 1000) return true;
  const current = await gatherGit(cwd);
  return current.gitCommit !== plan.gitCommit || current.worktreeHash !== plan.worktreeHash;
}

export { gatherGit } from "../../core/git.js";

function rejectSecretCommands(commands: string[][], names: string[]): void {
  const source = environmentSource();
  const values = [...names, "RAILWAY_API_TOKEN", "RAILWAY_TOKEN"]
    .map((name) => source.get(name))
    .filter((value): value is string => !!value && value.length >= 6);
  const suspicious = /(?:postgres(?:ql)?:\/\/[^\s]+|bearer\s+[A-Za-z0-9._~-]{16,}|[A-Za-z0-9_=-]{32,})/i;
  for (const token of commands.flat()) {
    if (values.some((value) => token.includes(value)) || suspicious.test(token)) throw err("E_CONFIG_INVALID", "command contains secret-like token");
  }
}

function deriveResourceActions(
  manifest: RailwayManifest,
  environment: Environment,
  intent: "deploy" | "rollback" | "migration",
  targetReleaseId?: string
): ResourceAction[] {
  const actions: ResourceAction[] = [];
  if (intent === "rollback") {
    if (targetReleaseId) {
      actions.push({ action: "rollback", resource: "deployment", name: targetReleaseId });
    }
    return actions;
  }
  if (intent === "migration") {
    if (manifest.db?.migrate?.command) actions.push({ action: "update", resource: "database", name: "run migration" });
    return actions;
  }
  actions.push({ action: "create", resource: "project", name: manifest.project });
  actions.push({ action: "create", resource: "service", name: `${manifest.project}-app` });
  if (manifest.db?.provision === "railway-postgres") {
    actions.push({ action: "create", resource: "postgres", name: `${manifest.project}-postgres` });
  }
  actions.push({ action: "update", resource: "deployment", name: "deploy" });
  return actions;
}

function deriveImpact(
  environment: Environment,
  actions: ResourceAction[],
  migrationCommand?: string[]
): string {
  const parts = [`${environment} deployment`];
  if (actions.some((a) => a.resource === "postgres")) parts.push("provision Railway Postgres (spike-gated)");
  if (migrationCommand) parts.push("run database migration");
  parts.push(`${actions.length} resource action(s)`);
  return parts.join("; ");
}
