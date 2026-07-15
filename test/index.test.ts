import { describe, expect, it } from "vitest";
import piShipExtension from "../src/index.js";

describe("piShipExtension", () => {
  it("registers tools, gate, commands, and shutdown listener", () => {
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
    piShipExtension(pi as unknown as never);

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
  });
});
