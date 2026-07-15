import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalRegistry } from "../src/core/approval.js";
import { registerGate } from "../src/gate.js";
import { buildDatabasePlan } from "../src/database/plan.js";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

describe("gate", () => {
  let cwd: string;
  let registry: ApprovalRegistry;
  let handler: ((event: unknown, ctx: { cwd: string }) => Promise<unknown>) | undefined;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-ship-gate-"));
    registry = new ApprovalRegistry(cwd);
    handler = undefined;
    const pi = {
      on: (_event: string, fn: (event: unknown, ctx: { cwd: string }) => Promise<unknown>) => {
        handler = fn;
      },
    };
    registerGate(pi as unknown as never, registry);
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function toolCall(toolName: string, input: unknown): Parameters<typeof isToolCallEventType>[1] {
    if (toolName === "ship") {
      return { type: "tool_call", toolName, input } as unknown as Parameters<
        typeof isToolCallEventType
      >[1];
    }
    if (toolName === "DB") {
      return { type: "tool_call", toolName, input } as unknown as Parameters<
        typeof isToolCallEventType
      >[1];
    }
    throw new Error(`unknown tool: ${toolName}`);
  }

  it("allows approved ship.apply_plan", async () => {
    if (!handler) throw new Error("handler not registered");
    registry.approve("p1", "d1", cwd);
    const event = toolCall("ship", { action: "apply_plan", planId: "p1", planDigest: "d1" });
    const result = await handler(event, { cwd });
    expect(result).toBeUndefined();
  });

  it("blocks DB with command field", async () => {
    if (!handler) throw new Error("handler not registered");
    const event = toolCall("DB", {
      action: "apply_plan",
      planId: "p1",
      planDigest: "d1",
      command: ["rm", "-rf", "/"],
    });
    const result = await handler(event, { cwd });
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("command field"),
    });
  });

  it("allows non-mutating ship without approval", async () => {
    if (!handler) throw new Error("handler not registered");
    const event = toolCall("ship", { action: "validate" });
    const result = await handler(event, { cwd });
    expect(result).toBeUndefined();
  });

  const hex64 = "0000000000000000000000000000000000000000000000000000000000000000";
  async function dbPlan() {
    const classification = await import("../src/database/classifier.js").then((m) => m.classifySQL("DELETE FROM x"));
    const plan = buildDatabasePlan({ environment: "development", targetFingerprint: hex64, providerFingerprint: hex64, manifestFingerprint: hex64, sql: "DELETE FROM x", params: [], classification });
    await mkdir(join(cwd, ".pi-ship", "plans"), { recursive: true });
    await writeFile(join(cwd, ".pi-ship", "plans", `${plan.planId}.json`), JSON.stringify(plan));
    return plan;
  }
  it("blocks DB apply_plan when not approved", async () => {
    if (!handler) throw new Error("handler not registered");
    const plan = await dbPlan();
    const event = toolCall("DB", { action: "apply_plan", planId: plan.planId, planDigest: plan.planDigest });
    const result = await handler(event, { cwd });
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("lacks approval"),
    });
  });
  it("does not guard legacy tool events", async () => {
    if (!handler) throw new Error("handler not registered");
    const event = { type: "tool_call", toolName: "db_ops", input: { action: "apply_plan", planId: "p", planDigest: "d", command: ["x"] } } as never;
    await expect(handler(event, { cwd })).resolves.toBeUndefined();
  });

  it("allows approved DB.apply_plan", async () => {
    if (!handler) throw new Error("handler not registered");
    const plan = await dbPlan();
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "database", risk: "destructive" });
    await expect(handler(toolCall("DB", { action: "apply_plan", planId: plan.planId, planDigest: plan.planDigest }), { cwd })).resolves.toBeUndefined();
  });

  it("blocks DB apply_plan when digest does not match persisted plan", async () => {
    if (!handler) throw new Error("handler not registered");
    const plan = await dbPlan();
    registry.approve(plan.planId, plan.planDigest, cwd, { domain: "database", risk: "destructive" });
    const result = await handler(toolCall("DB", { action: "apply_plan", planId: plan.planId, planDigest: "bad1111111111111111111111111111111111111111111111111111111111111111" }), { cwd });
    expect(result).toEqual({ block: true, reason: expect.stringContaining("digest mismatch") });
  });

  it("preserves generic approval for provider migration plans", async () => {
    if (!handler) throw new Error("handler not registered");
    const digest = "0000000000000000000000000000000000000000000000000000000000000000";
    await mkdir(join(cwd, ".pi-ship", "plans"), { recursive: true });
    await writeFile(join(cwd, ".pi-ship", "plans", "provider-plan.json"), JSON.stringify({ planId: "provider-plan", planDigest: digest }));

    await expect(handler(toolCall("DB", { action: "apply_plan", planId: "provider-plan", planDigest: digest }), { cwd }))
      .resolves.toEqual({ block: true, reason: expect.stringContaining("lacks approval") });

    registry.approve("provider-plan", digest, cwd);
    await expect(handler(toolCall("DB", { action: "apply_plan", planId: "provider-plan", planDigest: digest }), { cwd }))
      .resolves.toBeUndefined();
  });

  it("blocks DB apply_plan with malformed db-plan/1 despite generic approval", async () => {
    if (!handler) throw new Error("handler not registered");
    const h = "0000000000000000000000000000000000000000000000000000000000000000";
    await mkdir(join(cwd, ".pi-ship", "plans"), { recursive: true });
    await writeFile(join(cwd, ".pi-ship", "plans", "bad.json"), JSON.stringify({ kind: "db-plan/1", planId: "bad", riskLevel: "write" }));
    registry.approve("bad", h, cwd);
    const result = await handler(toolCall("DB", { action: "apply_plan", planId: "bad", planDigest: h }), { cwd });
    expect(result).toEqual({ block: true, reason: expect.stringContaining("invalid") });
  });

  it("preserves generic approval for persisted non-database provider plans", async () => {
    if (!handler) throw new Error("handler not registered");
    const h = "0000000000000000000000000000000000000000000000000000000000000000";
    await mkdir(join(cwd, ".pi-ship", "plans"), { recursive: true });
    await writeFile(join(cwd, ".pi-ship", "plans", "provider.json"), JSON.stringify({ kind: "ship-plan/1", planId: "provider", planDigest: h }));
    registry.approve("provider", h, cwd);
    await expect(handler(toolCall("ship", { action: "apply_plan", planId: "provider", planDigest: h }), { cwd })).resolves.toBeUndefined();
  });

});
