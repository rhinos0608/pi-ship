import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import piShipExtension from "../src/index.js";

describe("piShipExtension", () => {
  it("registers tools, gate, commands, and shutdown listener", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ship-test-"));
    writeFileSync(join(dir, "pi-ship.json"), JSON.stringify({ provider: "railway", version: 1, name: "test", project: "test-project", run: { command: ["echo"] } }));
    const originalCwd = process.cwd;
    process.cwd = () => dir;
    try {
    const tools: string[] = [];
    const commands: string[] = [];
    const events: string[] = [];
    const pi = {
      registerTool: (def: { name: string }) => {
        tools.push(def.name);
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
    expect(events).toContain("tool_call");
    expect(events).toContain("session_shutdown");
    } finally {
      process.cwd = originalCwd;
    }
  });
});
