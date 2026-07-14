import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ApprovalSidecar {
  planId: string;
  planDigest: string;
  approvedAt: string;
  environment: string;
}

export function approvalSidecarPath(cwd: string, planId: string): string {
  return join(cwd, ".pi-ship", "plans", `${planId}.approval.json`);
}

export async function writeApprovalSidecar(
  cwd: string,
  planId: string,
  planDigest: string,
  approvedAt: string,
  environment: string
): Promise<void> {
  const path = approvalSidecarPath(cwd, planId);
  await mkdir(dirname(path), { recursive: true });
  const sidecar: ApprovalSidecar = { planId, planDigest, approvedAt, environment };
  await writeFile(path, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
}

