import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { providerRegistry, createProviderExecution } from "../../src/providers/registry.js";
import type { RailwayExecution } from "../../src/providers/railway/package.js";
import type { VercelExecution } from "../../src/providers/vercel/package.js";
import { railwayProviderPackage } from "../../src/providers/railway/package.js";
import { buildRailwayPlan } from "../../src/providers/railway/plan.js";
import { vercelProviderPackage } from "../../src/providers/vercel/package.js";
import { buildVercelPlan } from "../../src/providers/vercel/plan.js";

describe("provider registry", () => {
  it("exacts two provider IDs", () => {
    expect(providerRegistry.ids()).toEqual(["railway", "vercel"]);
  });

  it("rejects duplicate IDs in registry creation", async () => {
    const { createProviderRegistry } = await import("../../src/providers/registry.js");
    // Must throw when duplicate IDs
    const duplicateA = { ...railwayProviderPackage };
    const duplicateB = { ...railwayProviderPackage };
    expect(() => createProviderRegistry([duplicateA, duplicateB])).toThrow(
      expect.objectContaining({ code: "E_CONFIG_INVALID" })
    );
    // Verify the existing packages have distinct IDs
    expect(railwayProviderPackage.id).toBe("railway");
    expect(vercelProviderPackage.id).toBe("vercel");
    expect(railwayProviderPackage.id).not.toBe(vercelProviderPackage.id);
  });

  it("resolves Railway manifest", () => {
    const manifest = { name: "x", provider: "railway", project: "x", run: { command: ["echo"] } };
    const pkg = providerRegistry.resolveManifest(manifest);
    expect(pkg.id).toBe("railway");
  });

  it("resolves Vercel manifest", () => {
    const manifest = { version: 2, name: "x", app: { provider: "vercel", config: { projectName: "x" } } };
    const pkg = providerRegistry.resolveManifest(manifest);
    expect(pkg.id).toBe("vercel");
  });

  it("rejects unsupported manifest (no match)", () => {
    expect(() => providerRegistry.resolveManifest({ provider: "unknown" })).toThrow(
      expect.objectContaining({ code: "E_CONFIG_INVALID", message: "unsupported manifest provider/version" })
    );
    expect(() => providerRegistry.resolveManifest(null)).toThrow(
      expect.objectContaining({ code: "E_CONFIG_INVALID" })
    );
    expect(() => providerRegistry.resolveManifest("string")).toThrow(
      expect.objectContaining({ code: "E_CONFIG_INVALID" })
    );
  });

  it("rejects ambiguous manifest (matches multiple)", async () => {
    // Create a manifest that matches both - unlikely but test the guard
    const ambiguous = {
      name: "x",
      version: 2,
      provider: "railway",
      project: "x",
      run: { command: ["echo"] },
      app: { provider: "vercel", config: { projectName: "x" } },
    };
    expect(() => providerRegistry.resolveManifest(ambiguous)).toThrow(
      expect.objectContaining({ code: "E_CONFIG_INVALID" })
    );

    // Also test: createProviderRegistry with truly ambiguous predicates
    const { createProviderRegistry } = await import("../../src/providers/registry.js");
    const mockA = {
      id: "mock-a",
      isManifest: () => true,
      isPlan: () => false,
      isState: () => false,
      defaultState: () => ({}),
      conflictMessage: { loadStateFromOther: "", saveStateOverOther: "" },
    };
    const mockB = {
      id: "mock-b",
      isManifest: () => true,
      isPlan: () => false,
      isState: () => false,
      defaultState: () => ({}),
      conflictMessage: { loadStateFromOther: "", saveStateOverOther: "" },
    };
    const testRegistry = createProviderRegistry([mockA, mockB]);
    expect(() => testRegistry.resolveManifest({})).toThrow(
      expect.objectContaining({ code: "E_CONFIG_INVALID" })
    );
  });

  it("loads state with cross-provider conflict detection", async () => {
    // Railway state should be loadable
    const railwayState = { version: 1, provider: "railway", serviceIds: {}, history: [] };
    // Mock cwd with a state file - we use a temporary dir
    const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { statePath } = await import("../../src/persistence/state-store.js");

    const railCwd = await mkdtemp(join(tmpdir(), "pi-ship-reg-test-"));
    await mkdir(join(railCwd, ".pi-ship"), { recursive: true });
    // Write valid Railway state
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(statePath(railCwd), JSON.stringify(railwayState));

    const loaded = await providerRegistry.loadState(railCwd, "railway");
    expect(loaded).toMatchObject({ version: 1, provider: "railway" });

    // Vercel trying to load Railway state should fail with conflict
    await expect(providerRegistry.loadState(railCwd, "vercel")).rejects.toMatchObject({
      code: "E_STATE_CONFLICT",
    });

    // Vercel trying to save over Railway state should fail
    const vercelState = { version: 2, databases: {}, releases: [], history: [] };
    await expect(providerRegistry.saveState(railCwd, vercelState, "vercel")).rejects.toMatchObject({
      code: "E_STATE_CONFLICT",
    });

    // Overwrite Railway state with Railway state should work
    await providerRegistry.saveState(railCwd, railwayState, "railway");
  });

  it("preserves exact cross-provider plan errors", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const railwayCwd = await mkdtemp(join(tmpdir(), "pi-ship-reg-plan-"));
    const railwayPlan = await buildRailwayPlan(railwayCwd, {
      name: "x",
      provider: "railway",
      project: "x",
      run: { command: ["echo"] },
    }, "preview");
    await providerRegistry.persistPlan(railwayCwd, "railway", railwayPlan);
    await expect(providerRegistry.loadPlan(railwayCwd, "vercel", railwayPlan.planId)).rejects.toMatchObject({
      code: "E_STATE_CONFLICT",
      message: "V1 plan requires loadPlan",
    });

    const vercelCwd = await mkdtemp(join(tmpdir(), "pi-ship-reg-plan-"));
    const vercelPlan = await buildVercelPlan(vercelCwd, {
      version: 2,
      name: "x",
      app: { provider: "vercel", config: { projectName: "x" } },
    }, "preview", "deploy", {
      accountRef: { kind: "user", id: "user-1" },
      source: { kind: "local-files", rootDirectory: ".", fileCount: 0, totalBytes: 0, fingerprint: "source" },
    });
    await providerRegistry.persistPlan(vercelCwd, "vercel", vercelPlan);
    await expect(providerRegistry.loadPlan(vercelCwd, "railway", vercelPlan.planId)).rejects.toMatchObject({
      code: "E_STATE_CONFLICT",
      message: "V2 plan requires loadPlanV2",
    });
  });

  it("preserves exact invalid Vercel state save error", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-reg-state-"));

    await expect(providerRegistry.saveState(cwd, { version: 2, unexpected: true }, "vercel")).rejects.toMatchObject({
      code: "E_CONFIG_INVALID",
      message: "state V2 has invalid shape",
    });
  });

  it("returns default state for missing state file", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-reg-test-"));
    const railState = await providerRegistry.loadState(cwd, "railway");
    expect(railState).toMatchObject({ version: 1, provider: "railway" });

    const vercelState = await providerRegistry.loadState(cwd, "vercel");
    expect(vercelState).toMatchObject({ version: 2 });
  });

  it("produces exact conflict error texts", () => {
    expect(railwayProviderPackage.conflictMessage.loadStateFromOther).toBe(
      "state.json contains V2 state; V1 caller cannot load it"
    );
    expect(railwayProviderPackage.conflictMessage.saveStateOverOther).toBe(
      "cannot overwrite V2 state with V1 state"
    );
    expect(vercelProviderPackage.conflictMessage.loadStateFromOther).toBe(
      "state.json contains V1 state; V2 caller cannot load it"
    );
    expect(vercelProviderPackage.conflictMessage.saveStateOverOther).toBe(
      "cannot overwrite V1 state with V2 state"
    );
  });
});

describe("createProviderExecution facade", () => {
  const pi = { exec: async () => ({ code: 0, stdout: "", stderr: "" }) } as never;
  const credentials = { get(name: string) { return name === "VERCEL_TOKEN" ? "token" : undefined; } };

  it("scopes Railway credential reads", () => {
    const names: string[] = [];
    const result = createProviderExecution(
      { name: "x", provider: "railway", project: "x", run: { command: ["x"] } },
      { pi, credentialSource: { get(name) { names.push(name); return name === "RAILWAY_API_TOKEN" ? "token" : undefined; } }, appSecretValues: ["secret"] }
    );
    if (result.provider !== "railway") throw new Error("expected railway execution");
    // Narrow by discriminant
    const railwayResult = result as RailwayExecution;
    expect(railwayResult.contract).toBe(1);
    expect(names).toEqual(["RAILWAY_API_TOKEN", "RAILWAY_TOKEN"]);
  });

  it("rejects mismatched Railway state", () => {
    expect(() => createProviderExecution(
      { name: "x", provider: "railway", project: "x", run: { command: ["x"] } },
      { pi, credentialSource: { get: () => "token" }, state: { version: 2, databases: {}, releases: [], history: [] } },
    )).toThrow(expect.objectContaining({
      code: "E_STATE_CONFLICT",
      message: "Railway factory requires V1 state",
    }));
  });

  it("reads Vercel token and creates V2 runtime", () => {
    const names: string[] = [];
    const result = createProviderExecution(
      { version: 2, name: "x", app: { provider: "vercel", config: { projectName: "x" } } },
      { pi, credentialSource: { get(name) { names.push(name); return "token"; } }, cwd: process.cwd() }
    );
    if (result.provider !== "vercel") throw new Error("expected vercel execution");
    const vercelResult = result as VercelExecution;
    expect(vercelResult.contract).toBe(2);
    expect(vercelResult.provider).toBe("vercel");
    expect(vercelResult.runtime).toBeDefined();
    expect(vercelResult.client).toBeDefined();
    expect(names).toEqual(["VERCEL_TOKEN"]);
  });

  it("rejects manifest team against persisted user account", () => {
    expect(() => createProviderExecution(
      { version: 2, name: "x", app: { provider: "vercel", config: { projectName: "x", teamId: "team-1" } } },
      { pi, credentialSource: credentials, cwd: process.cwd(), state: { version: 2, app: { provider: "vercel", account: { kind: "user", id: "user-1" }, accountFingerprint: "afp", project: { id: "p1", name: "x", fingerprint: "pfp" }, environments: {} }, databases: {}, releases: [], history: [] } }
    )).toThrow(expect.objectContaining({ code: "E_STATE_CONFLICT" }));
  });

  it("rejects differing manifest and persisted teams", () => {
    expect(() => createProviderExecution(
      { version: 2, name: "x", app: { provider: "vercel", config: { projectName: "x", teamId: "team-2" } } },
      { pi, credentialSource: credentials, cwd: process.cwd(), state: { version: 2, app: { provider: "vercel", account: { kind: "team", id: "team-1" }, accountFingerprint: "afp", project: { id: "p1", name: "x", fingerprint: "pfp" }, environments: {} }, databases: {}, releases: [], history: [] } }
    )).toThrow(expect.objectContaining({ code: "E_STATE_CONFLICT" }));
  });
});

describe("load/save state conflict exact messages", () => {
  it("produces exact conflict error texts", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { statePath } = await import("../../src/persistence/state-store.js");

    const testCwd = await mkdtemp(join(tmpdir(), "pi-ship-conflict-"));
    await mkdir(join(testCwd, ".pi-ship"), { recursive: true });
    // Write Railway state
    await writeFile(statePath(testCwd), JSON.stringify({ version: 1, provider: "railway", serviceIds: {}, history: [] }));

    // Vercel loading Railway state
    await expect(providerRegistry.loadState(testCwd, "vercel")).rejects.toMatchObject({
      code: "E_STATE_CONFLICT",
      message: "state.json contains V1 state; V2 caller cannot load it",
    });

    // Vercel saving over Railway state
    await expect(providerRegistry.saveState(testCwd, { version: 2, databases: {}, releases: [], history: [] }, "vercel")).rejects.toMatchObject({
      code: "E_STATE_CONFLICT",
      message: "cannot overwrite V1 state with V2 state",
    });

    // Write Vercel state
    await writeFile(statePath(testCwd), JSON.stringify({ version: 2, databases: {}, releases: [], history: [] }));

    // Railway loading Vercel state
    await expect(providerRegistry.loadState(testCwd, "railway")).rejects.toMatchObject({
      code: "E_STATE_CONFLICT",
      message: "state.json contains V2 state; V1 caller cannot load it",
    });

    // Railway saving over Vercel state
    await expect(providerRegistry.saveState(testCwd, { version: 1, provider: "railway", serviceIds: {}, history: [] }, "railway")).rejects.toMatchObject({
      code: "E_STATE_CONFLICT",
      message: "cannot overwrite V2 state with V1 state",
    });

    await rm(testCwd, { recursive: true, force: true });
  });
});

describe("import locality assertions", () => {
  it("railway package does not import vercel", () => {
    const content = readFileSync(new URL("../../src/providers/railway/package.ts", import.meta.url), "utf8");
    expect(content).not.toContain("vercel");
  });

  it("vercel package does not import railway", () => {
    const content = readFileSync(new URL("../../src/providers/vercel/package.ts", import.meta.url), "utf8");
    expect(content).not.toContain("railway");
  });

  it("persistence layer does not import provider packages", () => {
    const files = ["json.ts", "manifest-store.ts", "plan-store.ts", "state-store.ts"];
    for (const file of files) {
      const content = readFileSync(new URL(`../../src/persistence/${file}`, import.meta.url), "utf8");
      expect(content).toSatisfy(
        (s: string) => !s.includes("providers/railway") && !s.includes("providers/vercel"),
        `${file} should not import provider packages`
      );
    }
  });

  it("src/tools layer delegates provider lookup to registry", () => {
    const files = ["ship/index.ts", "db/index.ts"];
    for (const file of files) {
      const content = readFileSync(new URL(`../../src/tools/${file}`, import.meta.url), "utf8");
      expect(content).toSatisfy(
        (s: string) => !s.includes("providers/railway") && !s.includes("providers/vercel"),
        `${file} should not import provider packages`
      );
      expect(content).not.toContain("providerRegistry.resolveManifest");
    }
    expect(readFileSync(new URL("../../src/tools/ship/index.ts", import.meta.url), "utf8"))
      .toContain("providerRegistry.getShipOpsHandler");
    expect(readFileSync(new URL("../../src/tools/db/index.ts", import.meta.url), "utf8"))
      .toContain("providerRegistry.getDatabaseOpsHandler");
  });

  it("src/index.ts does not import concrete provider packages", () => {
    const content = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
    expect(content).toSatisfy(
      (s: string) => !s.includes("providers/railway") && !s.includes("providers/vercel"),
      "src/index.ts should not import provider packages"
    );
  });

  it("keeps direct environment reads inside credential source", () => {
    expect(readFileSync(new URL("../../src/core/redact.ts", import.meta.url), "utf8"))
      .not.toContain("../deployment/");
    const files = [
      "../../src/core/redact.ts",
      "../../src/providers/railway/plan.ts",
      "../../src/providers/railway/commands.ts",
    ];
    for (const file of files) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8")).not.toContain("process.env");
    }
  });

  it("deployment layer does not import provider packages", () => {
    const files = ["contracts.ts", "credentials.ts", "operation-engine.ts", "operation-journal.ts", "git.ts"];
    for (const file of files) {
      let content: string;
      try {
        content = readFileSync(new URL(`../../src/deployment/${file}`, import.meta.url), "utf8");
      } catch {
        continue;
      }
      expect(content).toSatisfy(
        (s: string) => !s.includes("providers/railway") && !s.includes("providers/vercel"),
        `${file} should not import provider packages`
      );
    }
  });
});
