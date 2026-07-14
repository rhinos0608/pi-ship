import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Manifest } from "./manifest.js";
import { err } from "./errors.js";
import type { Environment } from "./types.js";

const execFileAsync = promisify(execFile);

export interface ResourceAction {
  action: "create" | "update" | "rollback";
  resource: string;
  name: string;
}

export interface Plan {
  planId: string;
  manifest: Manifest;
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

export interface BuildPlanOptions {
  intent?: "deploy" | "rollback" | "migration";
  targetReleaseId?: string;
  planId?: string;
  createdAt?: string;
  targetSnapshot?: Plan["targetSnapshot"];
}

export async function buildPlan(
  cwd: string,
  manifest: Manifest,
  environment: Environment,
  options: BuildPlanOptions = {}
): Promise<Plan> {
  const { gitCommit, gitDirty, worktreeHash } = await gatherGit(cwd);
  const intent = options.intent ?? "deploy";
  const secretNames = intent === "rollback" ? [] : (manifest.secrets ?? []);
  const migrationCommand = intent === "rollback" ? undefined : manifest.db?.migrate?.command;
  rejectSecretCommands([manifest.run.command, ...(manifest.build ? [manifest.build.command] : []), ...(manifest.checks ?? []), ...(migrationCommand ? [migrationCommand] : [])], secretNames);
  const resourceActions = deriveResourceActions(manifest, environment, intent, options.targetReleaseId);
  const base: Omit<Plan, "planDigest"> = {
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

function deepSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSort);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = deepSort((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function computeDigest(plan: Omit<Plan, "planDigest">): string {
  return createHash("sha256").update(canonicalize(plan)).digest("hex");
}

export async function isPlanStale(plan: Plan, cwd: string, ttlMinutes = 30): Promise<boolean> {
  const now = Date.now();
  const created = new Date(plan.createdAt).getTime();
  if (Number.isNaN(created)) return true;
  if (now - created > ttlMinutes * 60 * 1000) return true;
  const current = await gatherGit(cwd);
  return current.gitCommit !== plan.gitCommit || current.worktreeHash !== plan.worktreeHash;
}

async function gatherGit(cwd: string): Promise<{ gitCommit: string; gitDirty: boolean; worktreeHash: string }> {
  let gitCommit = "unknown";
  let gitDirty = false;
  let worktreeHash = "";
  try {
    const { stdout: commit } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
    gitCommit = commit.trim();
  } catch {
    // not a git repo
  }
  try {
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd });
    gitDirty = status.trim().length > 0;
  } catch {
    gitDirty = false;
  }
  try {
    const { stdout: diff } = await execFileAsync("git", ["diff", "HEAD"], { cwd });
    const { stdout: untracked } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], { cwd });
    const hash = createHash("sha256").update(diff);
    for (const file of untracked.split("\n").filter(Boolean).sort()) {
      hash.update(file);
      hash.update(await readFile(`${cwd}/${file}`));
    }
    worktreeHash = hash.digest("hex");
  } catch {
    worktreeHash = "";
  }
  return { gitCommit, gitDirty, worktreeHash };
}

function rejectSecretCommands(commands: string[][], names: string[]): void {
  const values = [...names.map((n) => process.env[n]), process.env.RAILWAY_API_TOKEN, process.env.RAILWAY_TOKEN]
    .filter((v): v is string => !!v && v.length >= 6);
  const suspicious = /(?:postgres(?:ql)?:\/\/[^\s]+|bearer\s+[A-Za-z0-9._~-]{16,}|[A-Za-z0-9_=-]{32,})/i;
  for (const token of commands.flat()) {
    if (values.some((value) => token.includes(value)) || suspicious.test(token)) throw err("E_CONFIG_INVALID", "command contains secret-like token");
  }
}

function deriveResourceActions(
  manifest: Manifest,
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
