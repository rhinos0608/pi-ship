/**
 * Cloud-free database acceptance test through the registered DB tool.
 * Plans with fake UI, applies with fake PG client, inspects persisted
 * plan/journal for no secrets, verifies transaction behavior.
 */
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerDB } from "../../src/tools/db/index.js";
import type { DBInput } from "../../src/tools/db/schema.js";
import { ApprovalRegistry } from "../../src/core/approval.js";
import { readDatabaseJournal } from "../../src/database/journal.js";
import { readPlanFile } from "../../src/persistence/plan-store.js";
import type { DatabaseClient } from "../../src/database/client.js";

type ToolExecute = (...args: unknown[]) => Promise<unknown>;

function makeFakeClient(): DatabaseClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ fields: [], rows: [], rowCount: 0, command: "SELECT" }),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

describe("cloud-free database acceptance", () => {
  it("plans with fake UI, applies with fake PG client, no secrets leaked", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-db-accept-"));
    try {
      const registry = new ApprovalRegistry(cwd);
      const envSource = {
        get: (name: string) => {
          if (name === "PI_SHIP_DATABASE_ENVIRONMENT") return "development";
          if (name === "DATABASE_URL") return "postgres://user:token@localhost:5432/testdb";
          if (name === "PI_SHIP_ALLOW_PRODUCTION_DB_WRITES") return undefined;
          return undefined;
        },
      };
      const fakeClient = makeFakeClient();
      const clientFactory = vi.fn(() => fakeClient);

      let execute: ToolExecute | undefined;
      const pi = {
        registerTool(def: { name: string; execute: ToolExecute }) {
          execute = def.execute;
        },
      };

      registerDB(pi as never, registry, {
        credentialSource: envSource,
        clientFactory,
      });

      if (!execute) throw new Error("DB tool not registered");

      const context = { cwd, hasUI: true, ui: { confirm: async () => true } };

      // ── Plan with fake UI ────────────────────────────────────────────
      const planResult = await execute(
        "accept-call",
        { action: "plan", sql: "INSERT INTO users (name) VALUES ($1)", params: ["alice"] } as DBInput,
        undefined,
        undefined,
        context,
      ) as { details: { planId: string; planDigest: string; approved: boolean; statements: unknown[]; riskLevel: string } };

      expect(planResult.details.approved).toBe(true);
      expect(planResult.details.planId).toBeTruthy();
      expect(planResult.details.planDigest).toMatch(/^[0-9a-f]{64}$/);

      // ── Apply with fake PG client ────────────────────────────────────
      const applyResult = await execute(
        "accept-call",
        { action: "apply_plan", planId: planResult.details.planId, planDigest: planResult.details.planDigest } as DBInput,
        undefined,
        undefined,
        context,
      ) as { details: { planId: string; planDigest: string; status: string; statementCount: number; affectedRows: number } };

      expect(applyResult.details.status).toBe("committed");
      expect(applyResult.details.statementCount).toBe(1);

      // ── Inspect persisted plan — no secrets, no SQL ──────────────────
      const persisted = JSON.parse(await readFile(
        join(cwd, ".pi-ship", "plans", `${planResult.details.planId}.json`),
        "utf8",
      ));
      expect(persisted).not.toHaveProperty("sql");
      expect(persisted).not.toHaveProperty("params");
      expect(JSON.stringify(persisted)).not.toContain("alice");
      expect(JSON.stringify(persisted)).not.toContain("password");
      expect(JSON.stringify(persisted)).not.toContain("token");

      // ── Inspect journal — no secrets, no SQL ─────────────────────────
      const journal = await readDatabaseJournal(cwd);
      expect(journal.length).toBe(2);
      expect(journal[0]?.status).toBe("started");
      expect(journal[1]?.status).toBe("committed");
      const journalText = JSON.stringify(journal);
      expect(journalText).not.toContain("alice");
      expect(journalText).not.toContain("INSERT");
      expect(journalText).not.toContain("password");
      expect(journalText).not.toContain("token");
      expect(journalText).not.toContain("localhost");

      // ── Verify transaction: BEGIN + SET + INSERT + COMMIT ────────────
      const queryCalls = (fakeClient.query as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => ({ text: c[0], params: c[1] }),
      );
      expect(queryCalls[0]?.text).toBe("BEGIN");
      expect(queryCalls[1]?.text).toBe("SET LOCAL statement_timeout = '30000ms'");
      expect(queryCalls[2]?.text).toBe("SET LOCAL lock_timeout = '5000ms'");
      expect(queryCalls[3]?.text).toBe("INSERT INTO users (name) VALUES ($1)");
      expect(queryCalls[3]?.params).toEqual(["alice"]);
      expect(queryCalls[4]?.text).toBe("COMMIT");

      // ── Verify no open handles (client end) ──────────────────────────
      expect(fakeClient.end).toHaveBeenCalledTimes(1);

      // ── Client factory called exactly once ───────────────────────────
      expect(clientFactory).toHaveBeenCalledTimes(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
