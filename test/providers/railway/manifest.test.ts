import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadRailwayManifest } from "../../../src/providers/railway/manifest.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pi-ship-manifest-"));
});

async function writeManifest(content: object): Promise<void> {
  await writeFile(join(tmp, "pi-ship.json"), JSON.stringify(content, null, 2));
}

function assertConfigInvalid(promise: Promise<unknown>, substring: string) {
  return expect(promise).rejects.toMatchObject({
    code: "E_CONFIG_INVALID",
    message: expect.stringContaining(substring),
  });
}

describe("loadRailwayManifest", () => {
  it("loads minimal valid manifest", async () => {
    await writeManifest({
      name: "app",
      provider: "railway",
      project: "my-project",
      run: { command: ["node", "server.js"] },
    });
    const m = await loadRailwayManifest(tmp);
    expect(m.name).toBe("app");
    expect(m.provider).toBe("railway");
    expect(m.run.command).toEqual(["node", "server.js"]);
  });

  it("loads full valid manifest", async () => {
    await writeManifest({
      name: "app",
      provider: "railway",
      project: "my-project",
      build: { command: ["npm", "run", "build"] },
      run: { command: ["node", "dist/index.js"] },
      checks: [["npm", "test"], ["npm", "run", "lint"]],
      secrets: ["DATABASE_URL", "API_KEY"],
      db: {
        migrate: { command: ["npx", "prisma", "migrate", "deploy"], allowProductionMigrations: true },
        provision: "external",
      },
    });
    const m = await loadRailwayManifest(tmp);
    expect(m.build?.command).toEqual(["npm", "run", "build"]);
    expect(m.checks).toHaveLength(2);
    expect(m.secrets).toEqual(["DATABASE_URL", "API_KEY"]);
    expect(m.db?.migrate?.allowProductionMigrations).toBe(true);
    expect(m.db?.provision).toBe("external");
  });

  it("rejects unknown top-level key", async () => {
    await writeManifest({
      name: "app",
      provider: "railway",
      project: "p",
      run: { command: ["node", "server.js"] },
      unknownKey: true,
    } as object);
    await assertConfigInvalid(loadRailwayManifest(tmp), "unknownKey");
  });

  it("rejects unknown key inside db", async () => {
    await writeManifest({
      name: "app",
      provider: "railway",
      project: "p",
      run: { command: ["node", "server.js"] },
      db: { migrate: { command: ["npx", "prisma", "migrate", "deploy"], extra: true } },
    } as object);
    await assertConfigInvalid(loadRailwayManifest(tmp), "extra");
  });

  it("rejects missing project", async () => {
    await writeManifest({ name: "app", provider: "railway", run: { command: ["node"] } } as object);
    await assertConfigInvalid(loadRailwayManifest(tmp), "project");
  });

  it("rejects missing run", async () => {
    await writeManifest({ name: "app", provider: "railway", project: "p" } as object);
    await assertConfigInvalid(loadRailwayManifest(tmp), "run");
  });

  it("rejects empty run.command array", async () => {
    await writeManifest({
      name: "app",
      provider: "railway",
      project: "p",
      run: { command: [] },
    } as object);
    await assertConfigInvalid(loadRailwayManifest(tmp), "run.command");
  });

  it("rejects run.command with non-string token", async () => {
    await writeManifest({
      name: "app",
      provider: "railway",
      project: "p",
      run: { command: ["node", 123] },
    } as object);
    await assertConfigInvalid(loadRailwayManifest(tmp), "run.command");
  });

  it("rejects provider other than railway", async () => {
    await writeManifest({
      name: "app",
      provider: "aws",
      project: "p",
      run: { command: ["node"] },
    } as object);
    await assertConfigInvalid(loadRailwayManifest(tmp), "provider");
  });

  it("rejects malformed JSON", async () => {
    await writeFile(join(tmp, "pi-ship.json"), "{not json");
    await assertConfigInvalid(loadRailwayManifest(tmp), "invalid JSON");
  });
});
