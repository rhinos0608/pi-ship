import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { ApprovalRegistry } from "../../src/core/approval.js";
import { readOperationJournal } from "../../src/providers/vercel/operation-journal.js";
import { loadVercelState } from "../../src/providers/vercel/state.js";
import { registerShip } from "../../src/tools/ship/index.js";
import type { VercelFetchLike } from "../../src/providers/vercel/client.js";

const execFileAsync = promisify(execFile);

type ToolExecute = (...args: unknown[]) => Promise<unknown>;
type ToolResponse = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
};
type PlanResponse = ToolResponse & {
  details: {
    planId: string;
    planDigest: string;
    approved: boolean;
    environment: "preview" | "production";
  };
};

interface FakeProject {
  id: string;
  name: string;
  accountId: string;
}

interface FakeDeployment {
  id: string;
  name: string;
  url: string;
  readyState: "READY";
  createdAt: number;
  projectId: string;
  meta?: Record<string, string>;
}

interface FakeVercelState {
  projects: FakeProject[];
  deployments: FakeDeployment[];
  envValues: Map<string, string>;
  requests: Array<{ url: string; method: string; authorization: string | null }>;
  rollbackTargets: string[];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createFakeVercelFetch(state: FakeVercelState): VercelFetchLike {
  return async (url, init) => {
    const method = init?.method ?? "GET";
    const authorization = new Headers(init?.headers).get("Authorization");
    state.requests.push({ url, method, authorization });

    if (url.includes("/v2/user") && method === "GET") {
      return json({ user: { id: "user-1", email: "user@example.test", name: null, username: "user", avatar: null, defaultTeamId: null } });
    }
    if (url.includes("/v10/projects") && method === "GET") {
      const search = new URL(url).searchParams.get("search");
      return json({ projects: search ? state.projects.filter((project) => project.name === search) : state.projects });
    }
    if (url.includes("/v11/projects") && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { name: string };
      const project = { id: `project-${state.projects.length + 1}`, name: body.name, accountId: "user-1" };
      state.projects.push(project);
      return json(project, 201);
    }
    if (url.includes("/env") && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { key: string; value: string };
      state.envValues.set(body.key, body.value);
      return json({ created: {} });
    }
    if (url.includes("/v2/files") && method === "POST") {
      return json({ urls: [] });
    }
    if (url.includes("/v13/deployments") && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { name: string; meta?: Record<string, string> };
      const project = state.projects.find((candidate) => candidate.name === body.name);
      if (!project) return json({ error: { message: "project missing" } }, 404);
      const deployment: FakeDeployment = {
        id: `deployment-${state.deployments.length + 1}`,
        name: body.name,
        url: `https://${body.name}-${state.deployments.length + 1}.vercel.app`,
        readyState: "READY",
        createdAt: Date.now() + state.deployments.length,
        projectId: project.id,
        meta: body.meta,
      };
      state.deployments.push(deployment);
      return json(deployment, 201);
    }
    if (url.includes("/v13/deployments/") && method === "GET") {
      const id = new URL(url).pathname.split("/").at(-1);
      const deployment = state.deployments.find((candidate) => candidate.id === id);
      return deployment ? json(deployment) : json({ error: { message: "deployment missing" } }, 404);
    }
    if (url.includes("/v3/deployments/") && url.includes("/events") && method === "GET") {
      return json([{ type: "stdout", created: Date.now(), payload: { text: "build complete" } }]);
    }
    if (url.includes("/runtime-logs") && method === "GET") {
      return json([
        { level: "info", message: "application ready", rowId: "row-1", source: "serverless", timestampInMs: Date.now() },
        { level: "error", message: "secret=acceptance-app-secret", rowId: "row-2", source: "serverless", timestampInMs: Date.now() + 1 },
      ]);
    }
    if (url.includes("/rollback/") && method === "POST") {
      state.rollbackTargets.push(new URL(url).pathname.split("/").at(-1) ?? "");
      return new Response(null, { status: 201 });
    }
    throw new Error(`unexpected fake Vercel request: ${method} ${url}`);
  };
}

describe("cloud-free Vercel acceptance lifecycle", () => {
  it("runs ship preview, production, status, logs, and rollback through V2 engine", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-vercel-accept-"));
    const nativeFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("live fetch forbidden"));
    try {
      await execFileAsync("git", ["init"], { cwd });
      await execFileAsync("git", ["config", "user.email", "t@t.local"], { cwd });
      await execFileAsync("git", ["config", "user.name", "T"], { cwd });
      await writeFile(join(cwd, ".gitignore"), ".pi-ship\n");
      await writeFile(join(cwd, "index.js"), "export default function handler() { return 'ok'; }\n");
      await writeFile(join(cwd, "pi-ship.json"), JSON.stringify({
        version: 2,
        name: "acceptance-vercel-project",
        app: { provider: "vercel", config: { projectName: "acceptance-vercel-project" } },
        secrets: ["APP_SECRET"],
      }));
      await execFileAsync("git", ["add", "."], { cwd });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd });

      const fakeState: FakeVercelState = {
        projects: [],
        deployments: [],
        envValues: new Map(),
        requests: [],
        rollbackTargets: [],
      };
      const credentialReads: string[] = [];
      const credentialSource = {
        get(name: string): string | undefined {
          credentialReads.push(name);
          if (name === "VERCEL_TOKEN") return "acceptance-vercel-token";
          if (name === "APP_SECRET") return "acceptance-app-secret";
          return undefined;
        },
      };
      let execute: ToolExecute | undefined;
      const pi = {
        registerTool(definition: unknown) {
          execute = (definition as { execute: ToolExecute }).execute;
        },
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      };
      registerShip(pi as never, new ApprovalRegistry(cwd), {
        credentialSource,
        fetchImpl: createFakeVercelFetch(fakeState),
      });
      if (!execute) throw new Error("ship was not registered");
      const context = { cwd, hasUI: true, ui: { confirm: async () => true } };
      const invoke = async (params: Record<string, unknown>): Promise<ToolResponse> => execute!(
        "acceptance-call",
        params,
        undefined,
        undefined,
        context,
      ) as Promise<ToolResponse>;

      const validation = await invoke({ action: "validate" });
      expect(validation.details.missingSecrets).toEqual([]);

      const previewPlan = await invoke({ action: "plan", environment: "preview" }) as PlanResponse;
      expect(previewPlan.details).toMatchObject({ approved: true, environment: "preview" });
      await invoke({
        action: "apply_plan",
        planId: previewPlan.details.planId,
        planDigest: previewPlan.details.planDigest,
      });
      let state = await loadVercelState(cwd);
      expect(state.app?.environments.preview?.lastRelease).toMatchObject({ status: "ready" });
      expect(fakeState.projects).toHaveLength(1);
      expect(fakeState.deployments).toHaveLength(1);
      expect(fakeState.envValues.get("APP_SECRET")).toBe("acceptance-app-secret");

      const status = await invoke({ action: "status" });
      // status/details are now spotlighted by defendToolResult
      expect(status.details.status).toContain("ready");
      expect(status.details.releaseId).toContain("deployment-1");
      const logs = await invoke({ action: "logs", lines: 100 });
      // content[0] is the spotlighting preamble, content[1] is the wrapped logs
      expect(logs.content[1]?.text).toContain("application ready");
      expect(logs.content[1]?.text).toContain("***");
      expect(logs.content[1]?.text).not.toContain("acceptance-app-secret");

      const productionPlan = await invoke({ action: "plan", environment: "production" }) as PlanResponse;
      expect(productionPlan.details.approved).toBe(true);
      await invoke({
        action: "apply_plan",
        planId: productionPlan.details.planId,
        planDigest: productionPlan.details.planDigest,
      });
      state = await loadVercelState(cwd);
      const productionRelease = state.app?.environments.production?.lastRelease;
      expect(productionRelease).toMatchObject({ id: "deployment-2", status: "ready" });

      const rollbackPlan = await invoke({
        action: "plan",
        environment: "production",
        intent: "rollback",
        targetReleaseId: productionRelease?.id,
      }) as PlanResponse;
      expect(rollbackPlan.details.approved).toBe(true);
      await invoke({
        action: "apply_plan",
        planId: rollbackPlan.details.planId,
        planDigest: rollbackPlan.details.planDigest,
      });

      state = await loadVercelState(cwd);
      expect(state.history.map((entry) => entry.planId)).toEqual([
        previewPlan.details.planId,
        productionPlan.details.planId,
        rollbackPlan.details.planId,
      ]);
      expect(fakeState.rollbackTargets).toEqual(["deployment-2"]);
      const journal = await readOperationJournal(cwd);
      expect(journal.length).toBeGreaterThan(0);
      expect(journal[0]?.previousHash).toBeNull();
      for (let index = 1; index < journal.length; index += 1) {
        expect(journal[index]?.previousHash).toBe(journal[index - 1]?.entryHash);
      }

      expect(nativeFetch).not.toHaveBeenCalled();
      expect(fakeState.requests.length).toBeGreaterThan(0);
      expect(fakeState.requests.every(({ url }) => url.startsWith("https://api.vercel.com/"))).toBe(true);
      expect(fakeState.requests.every(({ authorization }) => authorization === "Bearer acceptance-vercel-token")).toBe(true);
      expect(new Set(credentialReads)).toEqual(new Set(["VERCEL_TOKEN", "APP_SECRET"]));
      expect(credentialReads).not.toContain("RAILWAY_API_TOKEN");
      expect(credentialReads).not.toContain("RAILWAY_TOKEN");
    } finally {
      nativeFetch.mockRestore();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
