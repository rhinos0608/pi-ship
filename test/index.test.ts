import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { Value } from "typebox/value";
import piShipExtension from "../src/index.js";

describe("piShipExtension", () => {
  it("registers tools, gate, commands, and shutdown listener (Railway)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ship-test-"));
    writeFileSync(join(dir, "pi-ship.json"), JSON.stringify({ provider: "railway", name: "test", project: "test-project", run: { command: ["echo"] } }));
    const originalCwd = process.cwd;
    process.cwd = () => dir;
    try {
    const tools: string[] = [];
    const commands: string[] = [];
    const events: string[] = [];
    let dbParams: unknown;
    const pi = {
      registerTool: (def: { name: string; parameters: unknown }) => {
        tools.push(def.name);
        if (def.name === "DB") dbParams = def.parameters;
      },
      registerCommand: (name: string) => {
        commands.push(name);
      },
      on: (event: string) => {
        events.push(event);
      },
    };
    await piShipExtension(pi as unknown as never);

    expect(tools).toContain("ship");
    expect(tools).toContain("DB");
    expect(tools).not.toContain("ship_ops");
    expect(tools).not.toContain("db_ops");
    expect(commands).toEqual(
      expect.arrayContaining([
        "ship-init",
        "ship-plan",
        "ship-apply",
        "ship-status",
        "ship-logs",
        "ship-rollback",
      ])
    );
    expect(commands).toHaveLength(6);
    expect(events).toContain("tool_call");
    expect(events).toContain("session_shutdown");

    // Railway profile includes plan_migration.
    expect(Value.Check(dbParams as never, { action: "plan_migration" })).toBe(true);
    } finally {
      process.cwd = originalCwd;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  });

  it("skips ship tool and provider commands when no pi-ship.json exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ship-test-"));
    // No pi-ship.json written — simulates local mode.
    const originalCwd = process.cwd;
    process.cwd = () => dir;
    try {
    const tools: string[] = [];
    const commands: string[] = [];
    let dbParams: unknown;
    const pi = {
      registerTool: (def: { name: string; parameters: unknown }) => {
        tools.push(def.name);
        if (def.name === "DB") dbParams = def.parameters;
      },
      registerCommand: (name: string) => {
        commands.push(name);
      },
      on: () => {},
    };
    await piShipExtension(pi as unknown as never);

    expect(tools).toContain("DB");
    expect(tools).not.toContain("ship");
    expect(commands).toEqual([]);

    // Local profile uses composeDBSchema([]) — only 8 shared actions, no plan_migration.
    expect(Value.Check(dbParams as never, { action: "inspect" })).toBe(true);
    expect(Value.Check(dbParams as never, { action: "browse", table: "users", limit: 1, offset: 0 })).toBe(true);
    expect(Value.Check(dbParams as never, { action: "query", sql: "select 1", limit: 1 })).toBe(true);
    expect(Value.Check(dbParams as never, { action: "plan", sql: "select 1" })).toBe(true);
    expect(Value.Check(dbParams as never, { action: "migration_status" })).toBe(true);
    expect(Value.Check(dbParams as never, { action: "apply_plan", planId: "p", planDigest: "d" })).toBe(true);
    expect(Value.Check(dbParams as never, { action: "import", table: "t", format: "json" })).toBe(true);
    expect(Value.Check(dbParams as never, { action: "reset" })).toBe(true);
    expect(Value.Check(dbParams as never, { action: "plan_migration" })).toBe(false);
    expect(Value.Check(dbParams as never, { action: "provision" })).toBe(false);
    } finally {
      process.cwd = originalCwd;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  });

  it("registers DB only for Vercel manifest (no commands)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ship-test-"));
    writeFileSync(join(dir, "pi-ship.json"), JSON.stringify({
      version: 2, name: "vercel-test", app: { provider: "vercel", config: { projectName: "vercel-proj" } },
    }));
    const originalCwd = process.cwd;
    process.cwd = () => dir;
    try {
    const tools: string[] = [];
    const commands: string[] = [];
    let dbParams: unknown;
    const pi = {
      registerTool: (def: { name: string; parameters: unknown }) => {
        tools.push(def.name);
        if (def.name === "DB") dbParams = def.parameters;
      },
      registerCommand: (name: string) => { commands.push(name); },
      on: () => {},
    };
    await piShipExtension(pi as unknown as never);
    expect(tools).toContain("ship");
    expect(tools).toContain("DB");
    expect(commands).toEqual([]);

    // Vercel profile has no DB additions — plan_migration rejected.
    expect(Value.Check(dbParams as never, { action: "plan_migration" })).toBe(false);
    expect(Value.Check(dbParams as never, { action: "inspect" })).toBe(true);
    } finally {
      process.cwd = originalCwd;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  });

  it("registers DB only for Cloudflare manifest (no commands)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ship-test-"));
    writeFileSync(join(dir, "pi-ship.json"), JSON.stringify({
      provider: "cloudflare", version: 1, name: "cf-test", accountId: "acct_1",
      mainModule: "worker.js", compatibilityDate: "2025-01-01",
    }));
    const originalCwd = process.cwd;
    process.cwd = () => dir;
    try {
    const tools: string[] = [];
    const commands: string[] = [];
    let dbParams: unknown;
    const pi = {
      registerTool: (def: { name: string; parameters: unknown }) => {
        tools.push(def.name);
        if (def.name === "DB") dbParams = def.parameters;
      },
      registerCommand: (name: string) => { commands.push(name); },
      on: () => {},
    };
    await piShipExtension(pi as unknown as never);
    expect(tools).toContain("ship");
    expect(tools).toContain("DB");
    expect(commands).toEqual([]);

    // Cloudflare profile has no DB additions — plan_migration rejected.
    expect(Value.Check(dbParams as never, { action: "plan_migration" })).toBe(false);
    expect(Value.Check(dbParams as never, { action: "inspect" })).toBe(true);
    } finally {
      process.cwd = originalCwd;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  });

  it("registers DB only for Neon manifest (no commands)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ship-test-"));
    writeFileSync(join(dir, "pi-ship.json"), JSON.stringify({
      provider: "neon", version: 1, project: "neon-proj",
    }));
    const originalCwd = process.cwd;
    process.cwd = () => dir;
    try {
    const tools: string[] = [];
    const commands: string[] = [];
    let dbParams: unknown;
    const pi = {
      registerTool: (def: { name: string; parameters: unknown }) => {
        tools.push(def.name);
        if (def.name === "DB") dbParams = def.parameters;
      },
      registerCommand: (name: string) => { commands.push(name); },
      on: () => {},
    };
    await piShipExtension(pi as unknown as never);
    expect(tools).toContain("ship");
    expect(tools).toContain("DB");
    expect(commands).toEqual([]);

    // Neon profile includes plan_migration.
    expect(Value.Check(dbParams as never, { action: "plan_migration" })).toBe(true);
    } finally {
      process.cwd = originalCwd;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  });

  it("rejects invalid present JSON before any registration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ship-test-"));
    writeFileSync(join(dir, "pi-ship.json"), "{ invalid json");
    const originalCwd = process.cwd;
    process.cwd = () => dir;
    try {
    const tools: string[] = [];
    const commands: string[] = [];
    const pi = {
      registerTool: () => { tools.push("should-not-reach"); },
      registerCommand: () => { commands.push("should-not-reach"); },
      on: () => {},
    };
    await expect(piShipExtension(pi as unknown as never)).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    expect(tools).toEqual([]);
    expect(commands).toEqual([]);
    } finally {
      process.cwd = originalCwd;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  });

  it("rejects unsupported provider before any registration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ship-test-"));
    writeFileSync(join(dir, "pi-ship.json"), JSON.stringify({ provider: "nonexistent" }));
    const originalCwd = process.cwd;
    process.cwd = () => dir;
    try {
    const tools: string[] = [];
    const commands: string[] = [];
    const pi = {
      registerTool: () => { tools.push("should-not-reach"); },
      registerCommand: () => { commands.push("should-not-reach"); },
      on: () => {},
    };
    await expect(piShipExtension(pi as unknown as never)).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    expect(tools).toEqual([]);
    expect(commands).toEqual([]);
    } finally {
      process.cwd = originalCwd;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  });
});
