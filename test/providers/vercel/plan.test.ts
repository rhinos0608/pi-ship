import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  buildVercelPlan,
  computeVercelPlanDigest,
  isVercelPlan,
  LocalSourceRefSchema,
  snapshotVercelSource,
} from "../../../src/providers/vercel/plan.js";

describe("Vercel plan contract", () => {
  const manifest = {
    version: 2 as const,
    name: "site",
    app: {
      provider: "vercel" as const,
      config: { projectName: "site", rootDirectory: "app" },
    },
    secrets: ["KEY"],
  };

  it("requires verified account and rollback target identity", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-vercel-plan-"));
    await mkdir(join(cwd, "app"));
    await expect(buildVercelPlan(cwd, manifest, "production", "deploy")).rejects.toMatchObject({
      code: "E_CONFIG_INVALID",
    });
    await expect(
      buildVercelPlan(cwd, manifest, "production", "rollback", {
        accountRef: { kind: "user", id: "u" },
      }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("builds deterministic strict operations and digest", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-vercel-plan-"));
    await mkdir(join(cwd, "app"));
    const options = {
      planId: "plan-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      accountRef: { kind: "user" as const, id: "user-1" },
      source: { kind: "local-files" as const, rootDirectory: "app", fileCount: 0, totalBytes: 0, fingerprint: "source" },
      gitCommit: "commit",
      worktreeHash: "worktree",
    };
    const first = await buildVercelPlan(cwd, manifest, "production", "deploy", options);
    const second = await buildVercelPlan(cwd, manifest, "production", "deploy", options);
    expect(first.operations.map((operation) => operation.kind)).toEqual(["ensure_project", "upsert_secrets", "deploy"]);
    expect(first.planDigest).toBe(second.planDigest);
    expect(first.planDigest).toBe(computeVercelPlanDigest(first));
    expect(isVercelPlan(first)).toBe(true);
  });

  it("keeps local source references strict", () => {
    expect(Value.Check(LocalSourceRefSchema, {
      kind: "local-files",
      rootDirectory: ".",
      fileCount: 0,
      totalBytes: 0,
      fingerprint: "source",
    })).toBe(true);
    expect(Value.Check(LocalSourceRefSchema, {
      kind: "local-files",
      rootDirectory: ".",
      fileCount: 0,
      totalBytes: 0,
      fingerprint: "source",
      unexpected: true,
    })).toBe(false);
  });

  it("fingerprints content and excludes generated directories", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-vercel-plan-"));
    await mkdir(join(cwd, "app", ".git"), { recursive: true });
    await mkdir(join(cwd, "app", "node_modules"), { recursive: true });
    await writeFile(join(cwd, "app", "index.js"), "one");
    const first = await snapshotVercelSource(cwd, "app");
    await writeFile(join(cwd, "app", "index.js"), "two");
    const second = await snapshotVercelSource(cwd, "app");
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(first.files.map((file) => file.path)).toEqual(["index.js"]);
  });
});
