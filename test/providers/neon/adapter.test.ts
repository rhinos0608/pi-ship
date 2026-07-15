import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NeonClient, NeonProject, NeonBranch, NeonOperation, CreateProjectResponse, CreateBranchResponse } from "../../../src/providers/neon/client.js";

// ── Fake client ───────────────────────────────────────────────────────────

function createFakeClient(): NeonClient & {
  projects: Map<string, { id: string; name: string }>;
  branches: Map<string, Map<string, { id: string; name: string }>>;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const projects = new Map<string, { id: string; name: string }>();
  const branches = new Map<string, Map<string, { id: string; name: string }>>();
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let projCounter = 0;
  let brCounter = 0;

  function pBranches(projectId: string) {
    if (!branches.has(projectId)) branches.set(projectId, new Map());
    return branches.get(projectId)!;
  }

  return {
    projects,
    branches,
    calls,
    async checkAuth() { calls.push({ method: "checkAuth", args: [] }); return { ok: true, accountId: "acc-1" }; },
    async listProjects() { calls.push({ method: "listProjects", args: [] }); return Array.from(projects.values()).map((p) => ({ id: p.id, name: p.name, platform_primary_branch: "main", pg_version: 16, region_id: "aws-us-east-1", created_at: "t", updated_at: "t" } as NeonProject)); },
    async getProject(projectId) { calls.push({ method: "getProject", args: [projectId] }); const p = [...projects.values()].find((x) => x.id === projectId); if (!p) throw Object.assign(new Error("not found"), { code: "E_PROVIDER" }); return { id: p.id, name: p.name, platform_primary_branch: "main", pg_version: 16, region_id: "aws-us-east-1", created_at: "t", updated_at: "t" } as NeonProject; },
    async createProject(config) { calls.push({ method: "createProject", args: [config] }); projCounter++; const id = `proj-${projCounter}`; const name = config.project.name; projects.set(name, { id, name }); return { project: { id, name, platform_primary_branch: "main", pg_version: 16, region_id: "aws-us-east-1", created_at: "t", updated_at: "t" }, operations: [{ id: "op-create", project_id: id, action: "create_project", status: "running", created_at: "t", updated_at: "t" } as NeonOperation] } as CreateProjectResponse; },
    async listBranches(projectId) { calls.push({ method: "listBranches", args: [projectId] }); return Array.from(pBranches(projectId).values()).map((b) => ({ id: b.id, project_id: projectId, name: b.name, created_at: "t", updated_at: "t", primary: false } as NeonBranch)); },
    async getBranch(projectId, branchId) { calls.push({ method: "getBranch", args: [projectId, branchId] }); for (const b of pBranches(projectId).values()) { if (b.id === branchId) return { id: b.id, project_id: projectId, name: b.name, created_at: "t", updated_at: "t", primary: false } as NeonBranch; } throw Object.assign(new Error("not found"), { code: "E_PROVIDER" }); },
    async createBranch(projectId, config) { calls.push({ method: "createBranch", args: [projectId, config] }); brCounter++; const id = `br-${brCounter}`; const name = config.branch.name; pBranches(projectId).set(name, { id, name }); return { branch: { id, project_id: projectId, name, created_at: "t", updated_at: "t", primary: false }, endpoints: [{ id: "ep-1", project_id: projectId, branch_id: id, type: "read_write" as const, host: "host.neon.tech", port: 5432 }], operations: [{ id: "op-br", project_id: projectId, action: "create_branch", status: "running", created_at: "t", updated_at: "t" } as NeonOperation], connection_uris: [{ connection_uri: `postgresql://user:pass@${id}.neon.tech/db`, database: "neondb", role: "neondb_owner" }] } as CreateBranchResponse; },
    async getConnectionUri(_projectId, _branchId, dbName) { calls.push({ method: "getConnectionUri", args: [_projectId, _branchId, dbName] }); return `postgresql://user:pass@host.neon.tech/${dbName}`; },
    async listDatabases() { calls.push({ method: "listDatabases", args: [] }); return [{ id: "db-1", branch_id: "br-1", name: "neondb", owner_name: "neondb_owner", created_at: "t", updated_at: "t" }]; },
    async getOperation(_projectId, opId) { calls.push({ method: "getOperation", args: [_projectId, opId] }); return { id: opId, project_id: _projectId, action: "create", status: "finished", created_at: "t", updated_at: "t" } as NeonOperation; },
    async restoreBranch() { calls.push({ method: "restoreBranch", args: [] }); return { operations: [] }; },
    async pollOperation(_projectId, opId) { calls.push({ method: "pollOperation", args: [_projectId, opId] }); return { id: opId, project_id: _projectId, action: "create", status: "finished", created_at: "t", updated_at: "t" } as NeonOperation; },
  };
}

// ── Mock createNeonClient ─────────────────────────────────────────────────

let fakeClient: ReturnType<typeof createFakeClient>;

vi.mock("../../../src/providers/neon/client.js", () => ({
  createNeonClient: () => fakeClient,
}));

// Import after mock
const { createNeonAdapter } = await import("../../../src/providers/neon/adapter.js");

function makeAdapter() {
  fakeClient = createFakeClient();
  const pi = { exec: vi.fn() } as unknown as Pick<ExtensionAPI, "exec">;
  return { adapter: createNeonAdapter(pi, { apiKey: "test-key" }), client: fakeClient };
}

describe("NeonAdapter", () => {
  describe("checkAuth", () => {
    it("returns ok when auth succeeds", async () => {
      const { adapter, client } = makeAdapter();
      const result = await adapter.checkAuth();
      expect(result.ok).toBe(true);
      expect(client.calls[0].method).toBe("checkAuth");
    });

    it("returns missing when auth fails", async () => {
      const { adapter, client } = makeAdapter();
      client.checkAuth = async () => ({ ok: false });
      const result = await adapter.checkAuth();
      expect(result.ok).toBe(false);
      expect(result.missing).toEqual(["NEON_API_KEY"]);
    });
  });

  describe("ensureProject", () => {
    it("creates project when not exists", async () => {
      const { adapter, client } = makeAdapter();
      const result = await adapter.ensureProject("my-project");
      expect(result.projectId).toBeDefined();
      expect(result.projectName).toBe("my-project");
      expect(result.created).toBe(true);
      expect(client.calls.some((c) => c.method === "createProject")).toBe(true);
    });

    it("returns existing project when already exists (idempotent)", async () => {
      const { adapter, client } = makeAdapter();
      const r1 = await adapter.ensureProject("my-project");
      expect(r1.created).toBe(true);

      const r2 = await adapter.ensureProject("my-project");
      expect(r2.created).toBe(false);
      expect(r2.projectId).toBe(r1.projectId);
      // Should not call createProject again
      const createCalls = client.calls.filter((c) => c.method === "createProject");
      expect(createCalls).toHaveLength(1);
    });

    it("passes pgVersion and regionId to creation", async () => {
      const { adapter, client } = makeAdapter();
      const result = await adapter.ensureProject("my-project", { pgVersion: 15, regionId: "aws-us-west-2" });
      expect(result.created).toBe(true);
      const createCall = client.calls.find((c) => c.method === "createProject");
      expect(createCall).toBeDefined();
      const config = createCall!.args[0] as any;
      expect(config.project.pg_version).toBe(15);
      expect(config.project.region_id).toBe("aws-us-west-2");
    });
  });

  describe("ensureBranch", () => {
    it("creates branch when not exists", async () => {
      const { adapter, client } = makeAdapter();
      // First ensure a project
      const project = await adapter.ensureProject("my-project");

      const result = await adapter.ensureBranch(project.projectId, "main");
      expect(result.branchId).toBeDefined();
      expect(result.branchName).toBe("main");
      expect(result.created).toBe(true);
      expect(result.connectionUri).toBeDefined();
    });

    it("returns existing branch when already exists (idempotent)", async () => {
      const { adapter, client } = makeAdapter();
      const project = await adapter.ensureProject("my-project");
      const r1 = await adapter.ensureBranch(project.projectId, "main");
      expect(r1.created).toBe(true);

      const r2 = await adapter.ensureBranch(project.projectId, "main");
      expect(r2.created).toBe(false);
      expect(r2.branchId).toBe(r1.branchId);
    });
  });

  describe("getConnectionUri", () => {
    it("returns connection URI", async () => {
      const { adapter } = makeAdapter();
      const uri = await adapter.getConnectionUri("p1", "br-1", "neondb", "neondb_owner");
      expect(uri).toContain("postgresql://");
    });
  });

  describe("createPreviewBranch", () => {
    it("creates preview branch with expiresAt", async () => {
      const { adapter, client } = makeAdapter();
      const project = await adapter.ensureProject("my-project");
      const mainBranch = await adapter.ensureBranch(project.projectId, "main");
      const expiresAt = new Date(Date.now() + 86400000).toISOString();

      const result = await adapter.createPreviewBranch(project.projectId, mainBranch.branchId, "preview-feat", expiresAt);
      expect(result.branchId).toBeDefined();
      expect(result.connectionUri).toBeDefined();
    });

    it("creates preview branch without expiresAt", async () => {
      const { adapter } = makeAdapter();
      const project = await adapter.ensureProject("my-project");
      const mainBranch = await adapter.ensureBranch(project.projectId, "main");

      const result = await adapter.createPreviewBranch(project.projectId, mainBranch.branchId, "preview-noexp");
      expect(result.branchId).toBeDefined();
    });
  });
});
