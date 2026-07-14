import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { err } from "../../core/errors.js";
import { redact } from "../../core/redact.js";

export interface ExecLike {
  (command: string, args?: string[], options?: ExecOptions): Promise<ExecResult>;
}

export interface UpResult {
  status: string;
  releaseId: string;
  projectId?: string;
  projectName?: string;
  environmentId?: string;
  serviceId?: string;
  deploymentId?: string;
  logsUrl?: string;
  dashboardUrl?: string;
  url?: string;
}

export interface RailwayCliClient {
  version(signal?: AbortSignal): Promise<string>;
  up(serviceId: string, environmentId: string, projectId: string, dir: string, signal?: AbortSignal): Promise<UpResult>;
  logs(serviceId: string, environmentId: string, lines: number, signal?: AbortSignal): Promise<string>;
}

export function createRailwayCliClient(exec: ExecLike, secretValues: string[] = []): RailwayCliClient {
  const redactOutput = (text: string) => redact(text, ["RAILWAY_API_TOKEN", "RAILWAY_TOKEN"], secretValues);
  return {
    async version(signal) {
      const result = await exec("railway", ["--version"], { signal });
      if (result.code !== 0) {
        throw mapCliError("railway --version", result, secretValues);
      }
      return result.stdout.trim();
    },
    async up(serviceId, environmentId, projectId, dir, signal) {
      const args = [
        "up",
        "--json",
        "--yes",
        "--ci",
        "--service",
        serviceId,
        "--environment",
        environmentId,
        "--project",
        projectId,
      ];
      const result = await exec("railway", args, { signal, cwd: dir });
      if (result.code !== 0) {
        throw mapCliError("railway up", result, secretValues);
      }
      return parseUpOutput(result.stdout);
    },
    async logs(serviceId, environmentId, lines, signal) {
      const bounded = Math.min(Math.max(lines, 1), 500);
      const args = [
        "logs",
        "--json",
        "--lines",
        String(bounded),
        "--service",
        serviceId,
        "--environment",
        environmentId,
      ];
      const result = await exec("railway", args, { signal });
      if (result.code !== 0) {
        throw mapCliError("railway logs", result, secretValues);
      }
      return redactOutput(result.stdout);
    },
  };
}

export function parseUpOutput(stdout: string): UpResult {
  const lines = stdout.split("\n").filter((l) => l.trim());
  if (lines.length === 0) {
    throw err("E_PROVIDER", "railway up produced no output");
  }
  const last = lines[lines.length - 1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    throw err("E_PROVIDER", "railway up final line is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw err("E_PROVIDER", "railway up final line is not an object");
  }
  const p = parsed as Record<string, unknown>;
  return {
    status: String(p.status ?? "unknown"),
    releaseId: p.deploymentId ? String(p.deploymentId) : "unknown",
    projectId: p.projectId ? String(p.projectId) : undefined,
    projectName: p.projectName ? String(p.projectName) : undefined,
    environmentId: p.environmentId ? String(p.environmentId) : undefined,
    serviceId: p.serviceId ? String(p.serviceId) : undefined,
    deploymentId: p.deploymentId ? String(p.deploymentId) : undefined,
    logsUrl: p.logsUrl ? String(p.logsUrl) : undefined,
    dashboardUrl: p.dashboardUrl ? String(p.dashboardUrl) : undefined,
    url: p.url ? String(p.url) : undefined,
  };
}

function mapCliError(command: string, result: ExecResult, secretValues: string[] = []): Error {
  const combined = redact(`${result.stdout}\n${result.stderr}`.trim(), ["RAILWAY_API_TOKEN", "RAILWAY_TOKEN"], secretValues);
  const text = combined.toLowerCase();
  if (text.includes("not authenticated") || text.includes("notauthenticated") || text.includes("unauthorized") || result.code === 128) {
    return err("E_AUTH_MISSING", `auth failed for ${command}: ${combined}`);
  }
  return err("E_PROVIDER", `${command} failed: ${combined}`);
}
