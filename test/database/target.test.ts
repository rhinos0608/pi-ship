import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDatabaseTarget, fingerprintLocalTarget } from "../../src/database/target.js";
import { fingerprintTarget } from "../../src/database/plan.js";

describe("resolveDatabaseTarget", () => {
  it("returns remote postgres target when DATABASE_URL is postgres://", () => {
    const source = { get: (name: string) => name === "DATABASE_URL" ? "postgres://user:pass@host:5432/db" : undefined };
    const target = resolveDatabaseTarget(source, "/tmp/project");
    expect(target).toEqual({ kind: "remote", dialect: "postgres", url: "postgres://user:pass@host:5432/db" });
  });

  it("returns remote postgres target for postgresql:// scheme", () => {
    const source = { get: (name: string) => name === "DATABASE_URL" ? "postgresql://user:pass@host:5432/db" : undefined };
    const target = resolveDatabaseTarget(source, "/tmp/project");
    expect(target).toEqual({ kind: "remote", dialect: "postgres", url: "postgresql://user:pass@host:5432/db" });
  });

  it("returns remote mysql target for mysql:// scheme", () => {
    const source = { get: (name: string) => name === "DATABASE_URL" ? "mysql://user:pass@host:3306/db" : undefined };
    const target = resolveDatabaseTarget(source, "/tmp/project");
    expect(target).toEqual({ kind: "remote", dialect: "mysql", url: "mysql://user:pass@host:3306/db" });
  });

  it("returns remote mysql target for mariadb:// scheme", () => {
    const source = { get: (name: string) => name === "DATABASE_URL" ? "mariadb://user:pass@host:3306/db" : undefined };
    const target = resolveDatabaseTarget(source, "/tmp/project");
    expect(target).toEqual({ kind: "remote", dialect: "mysql", url: "mariadb://user:pass@host:3306/db" });
  });

  it("returns local target when DATABASE_URL is absent", () => {
    const source = { get: () => undefined };
    const target = resolveDatabaseTarget(source, "/tmp/project");
    expect(target).toEqual({ kind: "local", dialect: "pglite", dataDir: "/tmp/project/.pi-ship/local-db" });
  });

  it("returns local target when DATABASE_URL is empty string", () => {
    const source = { get: () => "" };
    const target = resolveDatabaseTarget(source, "/tmp/project");
    expect(target.kind).toBe("local");
    expect(target.dialect).toBe("pglite");
  });

  it("returns local target when DATABASE_URL is whitespace-only", () => {
    const source = { get: () => "   " };
    const target = resolveDatabaseTarget(source, "/tmp/project");
    expect(target.kind).toBe("local");
  });

  it("returns sqlite file target for sqlite: URL", () => {
    const source = { get: () => "sqlite:./data.db" };
    const target = resolveDatabaseTarget(source, "/tmp/project");
    expect(target).toEqual({ kind: "file", dialect: "sqlite", path: "/tmp/project/data.db" });
  });

  it("returns sqlite file target for .sqlite plain path", () => {
    const source = { get: () => "data.sqlite" };
    const target = resolveDatabaseTarget(source, "/tmp/project");
    expect(target).toEqual({ kind: "file", dialect: "sqlite", path: "/tmp/project/data.sqlite" });
  });

  it("returns sqlite file target for .db plain path", () => {
    const source = { get: () => "./mydb.db" };
    const target = resolveDatabaseTarget(source, "/tmp/project");
    expect(target).toEqual({ kind: "file", dialect: "sqlite", path: "/tmp/project/mydb.db" });
  });

  it("returns sqlite file target for .sqlite3 plain path", () => {
    const source = { get: () => "app.sqlite3" };
    const target = resolveDatabaseTarget(source, "/tmp/project");
    expect(target).toEqual({ kind: "file", dialect: "sqlite", path: "/tmp/project/app.sqlite3" });
  });

  it("rejects unsupported URL scheme", () => {
    const source = { get: () => "mongodb://host/db" };
    expect(() => resolveDatabaseTarget(source, "/tmp/project")).toThrow(/unsupported/);
  });

  it("rejects sqlite absolute path outside cwd", () => {
    const source = { get: () => "/etc/data.db" };
    expect(() => resolveDatabaseTarget(source, "/tmp/project")).toThrow(/must be within working directory/);
  });

  it("rejects sqlite .. escape outside cwd", () => {
    const source = { get: () => "../outside.db" };
    expect(() => resolveDatabaseTarget(source, "/tmp/project")).toThrow(/must be within working directory/);
  });

  it("rejects malformed unrecognized input", () => {
    const source = { get: () => "not-a-url-and-not-a-path" };
    expect(() => resolveDatabaseTarget(source, "/tmp/project")).toThrow(/not recognized/);
  });

  describe("symlink containment (resolveSqliteRef)", () => {
    let cwd: string;

    beforeEach(() => {
      // Create a real temp dir for each test
      cwd = mkdtempSync(join(tmpdir(), "target-symlink-"));
      // Create a real file inside cwd
      writeFileSync(join(cwd, "real.db"), "");
    });

    afterEach(() => {
      rmSync(cwd, { recursive: true, force: true });
    });

    it("rejects symlinked file pointing outside cwd", () => {
      // Create a target file outside cwd
      const outsideDir = mkdtempSync(join(tmpdir(), "outside-"));
      writeFileSync(join(outsideDir, "secret.db"), "");
      const symPath = join(cwd, "evil-link.db");
      symlinkSync(join(outsideDir, "secret.db"), symPath);

      const source = { get: () => symPath };
      expect(() => resolveDatabaseTarget(source, cwd)).toThrow(/must be within working directory/);

      rmSync(outsideDir, { recursive: true, force: true });
    });

    it("rejects symlinked directory pointing outside cwd", () => {
      // Create an outside directory
      const outsideDir = mkdtempSync(join(tmpdir(), "outside-"));
      writeFileSync(join(outsideDir, "target.db"), "");
      // Create symlink to outside directory
      const linkPath = join(cwd, "evil-dir");
      symlinkSync(outsideDir, linkPath);

      // Try to reference a file through the symlink directory
      const source = { get: () => join(linkPath, "target.db") };
      expect(() => resolveDatabaseTarget(source, cwd)).toThrow(/must be within working directory/);

      rmSync(outsideDir, { recursive: true, force: true });
    });

    it("rejects symlink with .. escape in non-existent portion", () => {
      // Symlink inside cwd to outside
      const outsideDir = mkdtempSync(join(tmpdir(), "outside-"));
      writeFileSync(join(outsideDir, "secret.db"), "");
      const symPath = join(cwd, "innocent.db");
      symlinkSync(outsideDir, symPath);

      // Use .. to traverse out
      const source = { get: () => join(symPath, "..", "..", "escaped.db") };
      expect(() => resolveDatabaseTarget(source, cwd)).toThrow(/must be within working directory/);

      rmSync(outsideDir, { recursive: true, force: true });
    });

    it("accepts legit new-file path inside cwd", () => {
      const source = { get: () => "new_project.db" };
      const target = resolveDatabaseTarget(source, cwd);
      expect(target).toEqual({ kind: "file", dialect: "sqlite", path: join(cwd, "new_project.db") });
    });

    it("accepts legit existing file inside cwd", () => {
      const source = { get: () => "real.db" };
      const target = resolveDatabaseTarget(source, cwd);
      expect(target).toEqual({ kind: "file", dialect: "sqlite", path: join(cwd, "real.db") });
    });
  });
});

describe("fingerprintLocalTarget", () => {
  it("returns deterministic 64-hex hash for local dataDir", () => {
    const a = fingerprintLocalTarget("/projects/app/.pi-ship/local-db");
    const b = fingerprintLocalTarget("/projects/app/.pi-ship/local-db");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("fingerprintTarget", () => {
  it("handles remote DatabaseTarget", () => {
    const a = fingerprintTarget({ kind: "remote", dialect: "postgres", url: "postgres://user:pass@host:5432/db" });
    const b = fingerprintTarget("postgres://user:pass@host:5432/db");
    expect(a).toBe(b);
  });

  it("handles local DatabaseTarget deterministically", () => {
    const a = fingerprintTarget({ kind: "local", dialect: "pglite", dataDir: "/projects/app/.pi-ship/local-db" });
    const b = fingerprintTarget({ kind: "local", dialect: "pglite", dataDir: "/projects/app/.pi-ship/local-db" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles undefined target", () => {
    expect(() => fingerprintTarget(undefined)).toThrow();
  });

  it("handles legacy undefined (throws with DATABASE_URL missing message)", () => {
    expect(() => fingerprintTarget(undefined)).toThrow(/DATABASE_URL/);
  });

  it("preserves existing behavior for URL strings", () => {
    const fp = fingerprintTarget("postgres://alice:secret@db.example.com:5432/myapp");
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(
      fingerprintTarget("postgres://u:p@h:5432/d")
    ).toBe(
      fingerprintTarget("postgresql://u:p@h:5432/d")
    );
  });
});
