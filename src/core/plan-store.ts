import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { err } from "./errors.js";
import { computeDigest, type Plan } from "./plan.js";

export function planPath(cwd: string, planId: string): string {
  return join(cwd, ".pi-ship", "plans", `${planId}.json`);
}

export async function persistPlan(cwd: string, plan: Plan): Promise<void> {
  const path = planPath(cwd, plan.planId);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, JSON.stringify(plan, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw err("E_STATE_CONFLICT", `plan ${plan.planId} already exists`);
    throw e;
  }
}

export async function loadPlan(cwd: string, planId: string): Promise<Plan> {
  const path = planPath(cwd, planId);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    throw err("E_PLAN_NOT_FOUND", `plan ${planId} not found: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw err("E_CONFIG_INVALID", `plan ${planId} is invalid JSON: ${(e as Error).message}`);
  }
  return parsed as Plan;
}

export function verifyDigest(plan: Plan, suppliedDigest: string): boolean {
  if (plan.planDigest !== suppliedDigest) return false;
  const recomputed = computeDigest(plan);
  return recomputed === suppliedDigest;
}
