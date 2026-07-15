import { describe, expect, it } from "vitest";
import { createDialectRegistry } from "../../../src/database/dialect/registry.js";
import type { DialectAdapter } from "../../../src/database/dialect/contracts.js";

/** Minimal stub adapter factory. */
function stubAdapter(overrides: Partial<DialectAdapter> & { id: any; schemes: any }): DialectAdapter {
  return {
    id: overrides.id,
    schemes: overrides.schemes,
    label: overrides.label ?? `stub-${overrides.id}`,
    local: overrides.local ?? false,
    classify: overrides.classify ?? (async () => { throw new Error("unused"); }) as any,
    assertPublicQuery: overrides.assertPublicQuery ?? (async () => { throw new Error("unused"); }) as any,
    assertPublicPlan: overrides.assertPublicPlan ?? (async () => { throw new Error("unused"); }) as any,
    fingerprint: overrides.fingerprint ?? (() => { throw new Error("unused"); }) as any,
    connect: overrides.connect ?? (async () => { throw new Error("unused"); }) as any,
    inspect: overrides.inspect ?? (async () => { throw new Error("unused"); }) as any,
    browse: overrides.browse ?? (async () => { throw new Error("unused"); }) as any,
    read: overrides.read ?? (async () => { throw new Error("unused"); }) as any,
    executeApproved: overrides.executeApproved ?? (async () => { throw new Error("unused"); }) as any,
    quoteIdentifier: overrides.quoteIdentifier ?? ((v: string) => `"${v}"`),
  };
}

describe("DialectRegistry", () => {
  it("resolves adapter by remote postgres target via scheme", () => {
    const pg = stubAdapter({ id: "postgres", schemes: ["postgres", "postgresql"] });
    const registry = createDialectRegistry([pg]);
    const target = { kind: "remote" as const, dialect: "postgres" as const, url: "postgres://host/db" };
    expect(registry.resolve(target)).toBe(pg);
  });

  it("resolves adapter by remote mysql target via scheme", () => {
    const mysql = stubAdapter({ id: "mysql", schemes: ["mysql", "mariadb"] });
    const registry = createDialectRegistry([mysql]);
    const target = { kind: "remote" as const, dialect: "mysql" as const, url: "mysql://host/db" };
    expect(registry.resolve(target)).toBe(mysql);
  });

  it("resolves adapter by local target via dialect field", () => {
    const pglite = stubAdapter({ id: "pglite", schemes: ["pglite"], local: true });
    const registry = createDialectRegistry([pglite]);
    const target = { kind: "local" as const, dialect: "pglite" as const, dataDir: "/tmp/db" };
    expect(registry.resolve(target)).toBe(pglite);
  });

  it("resolves adapter by file target via dialect field", () => {
    const sqlite = stubAdapter({ id: "sqlite", schemes: ["sqlite"], local: true });
    const registry = createDialectRegistry([sqlite]);
    const target = { kind: "file" as const, dialect: "sqlite" as const, path: "/tmp/db.sqlite" };
    expect(registry.resolve(target)).toBe(sqlite);
  });

  it("rejects duplicate dialect ids", () => {
    const a = stubAdapter({ id: "postgres", schemes: ["postgres"] });
    const b = stubAdapter({ id: "postgres", schemes: ["postgresql"] });
    expect(() => createDialectRegistry([a, b])).toThrow(/duplicate dialect/);
  });

  it("rejects duplicate schemes", () => {
    const a = stubAdapter({ id: "postgres", schemes: ["postgres"] });
    const b = stubAdapter({ id: "mysql", schemes: ["postgres"] });
    expect(() => createDialectRegistry([a, b])).toThrow(/duplicate dialect scheme/);
  });

  it("returns supported schemes", () => {
    const pg = stubAdapter({ id: "postgres", schemes: ["postgres", "postgresql"] });
    const mysql = stubAdapter({ id: "mysql", schemes: ["mysql", "mariadb"] });
    const registry = createDialectRegistry([pg, mysql]);
    const schemes = registry.supportedSchemes();
    expect(schemes).toContain("postgres");
    expect(schemes).toContain("postgresql");
    expect(schemes).toContain("mysql");
    expect(schemes).toContain("mariadb");
    expect(schemes.length).toBe(4);
  });

  it("throws for unknown remote scheme", () => {
    const pg = stubAdapter({ id: "postgres", schemes: ["postgres"] });
    const registry = createDialectRegistry([pg]);
    const target = { kind: "remote" as const, dialect: "mysql" as const, url: "sqlite:///db" };
    expect(() => registry.resolve(target)).toThrow(/no dialect adapter/);
  });

  it("throws for unknown dialect field", () => {
    const pg = stubAdapter({ id: "postgres", schemes: ["postgres"] });
    const registry = createDialectRegistry([pg]);
    const target = { kind: "file" as const, dialect: "sqlite" as const, path: "/tmp/db.sqlite" };
    expect(() => registry.resolve(target)).toThrow(/no dialect adapter/);
  });
});
