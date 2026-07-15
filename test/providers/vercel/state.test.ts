import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultState, loadRailwayState, saveRailwayState } from "../../../src/providers/railway/state.js";
import { defaultVercelState, loadVercelState, saveVercelState } from "../../../src/providers/vercel/state.js";

describe("Vercel state persistence", () => {
  it("returns Vercel default when state file is absent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-state-"));
    await expect(loadVercelState(cwd)).resolves.toEqual(defaultVercelState());
  });

  it("rejects other-provider state file when using direct load/save", async () => {
    const railwayCwd = await mkdtemp(join(tmpdir(), "pi-ship-state-"));
    await saveRailwayState(railwayCwd, defaultState());
    // Direct state functions now only validate own schema; cross-provider check moved to registry
    await expect(saveVercelState(railwayCwd, defaultVercelState())).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    await expect(loadVercelState(railwayCwd)).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rejects unknown nested fields", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ship-state-"));
    await expect(saveVercelState(cwd, { ...defaultVercelState(), extra: true } as never)).rejects.toMatchObject({
      code: "E_CONFIG_INVALID",
    });
  });
});
