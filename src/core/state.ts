import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { err } from "./errors.js";

export interface LocalState {
  version: 1;
  provider: "railway";
  projectId?: string;
  projectName?: string;
  environmentId?: string;
  environmentName?: string;
  serviceIds: {
    app?: string;
    postgres?: string;
  };
  serviceNames?: {
    app?: string;
    postgres?: string;
  };
  lastRelease?: {
    id: string;
    digest: string;
    url?: string;
    at: string;
  };
  history: Array<{
    planId: string;
    digest: string;
    at: string;
    status: string;
  }>;
}

export function defaultState(): LocalState {
  return {
    version: 1,
    provider: "railway",
    environmentId: undefined,
    environmentName: "production",
    serviceIds: {},
    serviceNames: {},
    history: [],
  };
}

export function statePath(cwd: string): string {
  return join(cwd, ".pi-ship", "state.json");
}

export async function loadState(cwd: string): Promise<LocalState> {
  const path = statePath(cwd);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return defaultState();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw err("E_CONFIG_INVALID", `state.json is invalid JSON: ${(e as Error).message}`);
  }
  if (!isLocalState(parsed)) {
    throw err("E_CONFIG_INVALID", "state.json has invalid shape");
  }
  return parsed;
}

export async function saveState(cwd: string, state: LocalState): Promise<void> {
  const path = statePath(cwd);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

function isLocalState(value: unknown): value is LocalState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    v.provider === "railway" &&
    (v.projectId === undefined || typeof v.projectId === "string") &&
    (v.projectName === undefined || typeof v.projectName === "string") &&
    (v.environmentId === undefined || typeof v.environmentId === "string") &&
    (v.environmentName === undefined || typeof v.environmentName === "string") &&
    !!v.serviceIds && typeof v.serviceIds === "object" && !Array.isArray(v.serviceIds) &&
    (() => { const s = v.serviceIds as Record<string, unknown>; return (s.app === undefined || typeof s.app === "string") && (s.postgres === undefined || typeof s.postgres === "string"); })() &&
    (v.serviceNames === undefined || (!!v.serviceNames && typeof v.serviceNames === "object" && !Array.isArray(v.serviceNames) && (() => { const s = v.serviceNames as Record<string, unknown>; return (s.app === undefined || typeof s.app === "string") && (s.postgres === undefined || typeof s.postgres === "string"); })())) &&
    Array.isArray(v.history) &&
    v.history.every((h) => !!h && typeof h === "object" && typeof (h as Record<string, unknown>).planId === "string" && typeof (h as Record<string, unknown>).digest === "string" && typeof (h as Record<string, unknown>).at === "string")
  );
}
