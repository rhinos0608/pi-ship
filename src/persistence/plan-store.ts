/**
 * Generic plan persistence — no provider imports.
 * Registry supplies package-specific predicates and digest functions.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { err } from "../core/errors.js";

export function planPath(cwd: string, planId: string): string {
  if (planId.includes("/") || planId.includes("\\") || planId.includes("\0") || planId === "." || planId === "..") {
    throw err("E_CONFIG_INVALID", "plan ID contains invalid path characters");
  }
  return join(cwd, ".pi-ship", "plans", `${planId}.json`);
}

export interface PlanPersistOptions {
  isValid(plan: unknown): boolean;
  computeDigest(plan: unknown): string;
}

interface PlanMetadata {
  planId: string;
  planDigest: string;
}

function hasPlanMetadata(value: unknown): value is PlanMetadata {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.planId === "string" && typeof candidate.planDigest === "string";
}

export async function persistPlan(
  cwd: string,
  plan: unknown,
  options: PlanPersistOptions,
): Promise<void> {
  if (!options.isValid(plan) || !hasPlanMetadata(plan)) {
    throw err("E_CONFIG_INVALID", "plan has invalid shape");
  }
  const digest = options.computeDigest(plan);
  if (digest !== plan.planDigest) throw err("E_DIGEST_MISMATCH", `plan ${plan.planId} digest mismatch`);
  const path = planPath(cwd, plan.planId);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw err("E_STATE_CONFLICT", `plan ${plan.planId} already exists`);
    }
    throw err("E_PROVIDER", `plan ${plan.planId} could not be persisted`);
  }
}

export interface PlanLoadOptions extends PlanPersistOptions {}

/** Read and JSON-decode a plan without assigning provider ownership. */
export async function readPlanFile(cwd: string, planId: string): Promise<unknown> {
  const path = planPath(cwd, planId);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw err("E_PLAN_NOT_FOUND", `plan ${planId} not found`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw err("E_CONFIG_INVALID", `plan ${planId} is invalid JSON`);
  }
}

/** Validate shape, requested identity, and digest after registry selects owner. */
export function validateLoadedPlan(
  plan: unknown,
  planId: string,
  options: PlanLoadOptions,
): unknown {
  if (!options.isValid(plan) || !hasPlanMetadata(plan)) {
    throw err("E_CONFIG_INVALID", `plan ${planId} has invalid shape`);
  }
  if (plan.planId !== planId) {
    throw err("E_STATE_CONFLICT", `plan ID mismatch: requested ${planId}`);
  }
  const digest = options.computeDigest(plan);
  if (digest !== plan.planDigest) {
    throw err("E_DIGEST_MISMATCH", `plan ${planId} digest mismatch`);
  }
  return plan;
}

export async function loadPlan(
  cwd: string,
  planId: string,
  options: PlanLoadOptions,
): Promise<unknown> {
  return validateLoadedPlan(await readPlanFile(cwd, planId), planId, options);
}
