import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadProviderRuntimeBinding } from "../../src/persistence/manifest-store.js";
import type { ProviderPackage } from "../../src/providers/contracts.js";
import { localCapabilityProfile, type ProviderRuntimeBinding } from "../../src/providers/capability-profile.js";
import { isShipError } from "../../src/core/errors.js";

// ── Mock provider packages ──────────────────────────────────────────────

const mockProfileA = { id: "mock-a", ship: [], databaseAdditions: [], commands: [] };
const mockProfileB = { id: "mock-b", ship: [], databaseAdditions: [], commands: [] };

function makeMockPackageA(validate?: (m: unknown) => void): ProviderPackage {
  return {
    id: "mock-a",
    profile: mockProfileA,
    isManifest: (v: unknown) =>
      typeof v === "object" && v !== null && (v as Record<string, unknown>).provider === "mock-a",
    isPlan: () => false,
    isState: () => false,
    defaultState: () => ({}),
    conflictMessage: { loadStateFromOther: "", saveStateOverOther: "" },
    ...(validate ? { validateManifest: validate } : {}),
  };
}

function makeMockPackageB(): ProviderPackage {
  return {
    id: "mock-b",
    profile: mockProfileB,
    isManifest: (v: unknown) =>
      typeof v === "object" && v !== null && (v as Record<string, unknown>).provider === "mock-b",
    isPlan: () => false,
    isState: () => false,
    defaultState: () => ({}),
    conflictMessage: { loadStateFromOther: "", saveStateOverOther: "" },
  };
}

/** A package that matches ANY object — used for ambiguous-manifest tests */
function makeCatchAllPackage(id: string): ProviderPackage {
  return {
    id,
    profile: { id, ship: [], databaseAdditions: [], commands: [] },
    isManifest: () => true,
    isPlan: () => false,
    isState: () => false,
    defaultState: () => ({}),
    conflictMessage: { loadStateFromOther: "", saveStateOverOther: "" },
  };
}

const mockPackages = [makeMockPackageA(), makeMockPackageB()];

async function tmpDir(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "pi-binding-")));
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Assert error is a ShipError with exact code. Returns the error for further checks. */
async function expectCode<T>(promise: Promise<T>, code: string, msgSubstring?: string): Promise<Error> {
  let err: unknown;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  if (!isShipError(err)) {
    // If not ShipError, still check code via toMatchObject
    expect(err).toMatchObject({ code });
    return err as Error;
  }
  expect(err.code).toBe(code);
  if (msgSubstring !== undefined) {
    expect(err.message).toContain(msgSubstring);
  }
  return err;
}

describe("loadProviderRuntimeBinding — startup binding", () => {
  let cwd: string;

  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
  });

  it("returns local binding when no manifest file exists (ENOENT)", async () => {
    cwd = await tmpDir();
    const binding = await loadProviderRuntimeBinding(cwd, mockPackages);
    expect(binding.cwd).toBe(cwd);
    expect(binding.manifest).toBeUndefined();
    expect(binding.package).toBeUndefined();
    expect(binding.profile).toBe(localCapabilityProfile);
    expect(binding.profile.id).toBe("local");
    expect(binding.manifestBytesDigest).toBeUndefined();
  });

  it("returns provider binding for valid manifest", async () => {
    cwd = await tmpDir();
    await writeFile(join(cwd, "pi-ship.json"), JSON.stringify({ provider: "mock-a", name: "test" }));
    const binding = await loadProviderRuntimeBinding(cwd, mockPackages);
    expect(binding.cwd).toBe(cwd);
    expect(binding.manifest).toEqual({ provider: "mock-a", name: "test" });
    expect(binding.package?.id).toBe("mock-a");
    expect(binding.profile.id).toBe("mock-a");
    expect(binding.manifestBytesDigest).toBeDefined();
    expect(binding.manifestBytesDigest!.length).toBe(64); // SHA-256 hex
  });

  it("throws E_CONFIG_INVALID for invalid JSON in manifest", async () => {
    cwd = await tmpDir();
    await writeFile(join(cwd, "pi-ship.json"), "{not-json");
    await expectCode(loadProviderRuntimeBinding(cwd, mockPackages), "E_CONFIG_INVALID", "invalid JSON");
  });

  it("throws E_CONFIG_INVALID when manifest is a non-object value", async () => {
    cwd = await tmpDir();
    await writeFile(join(cwd, "pi-ship.json"), JSON.stringify("string-not-object"));
    await expectCode(loadProviderRuntimeBinding(cwd, mockPackages), "E_CONFIG_INVALID", "must be a JSON object");

    cwd = await tmpDir();
    await writeFile(join(cwd, "pi-ship.json"), JSON.stringify(42));
    await expectCode(loadProviderRuntimeBinding(cwd, mockPackages), "E_CONFIG_INVALID", "must be a JSON object");

    cwd = await tmpDir();
    await writeFile(join(cwd, "pi-ship.json"), JSON.stringify(null));
    await expectCode(loadProviderRuntimeBinding(cwd, mockPackages), "E_CONFIG_INVALID", "must be a JSON object");
  });

  it("throws E_CONFIG_INVALID for unsupported manifest (no match)", async () => {
    cwd = await tmpDir();
    await writeFile(join(cwd, "pi-ship.json"), JSON.stringify({ provider: "unknown" }));
    await expectCode(loadProviderRuntimeBinding(cwd, mockPackages), "E_CONFIG_INVALID", "unsupported manifest");
  });

  it("throws E_CONFIG_INVALID for ambiguous manifest (multiple matches)", async () => {
    cwd = await tmpDir();
    const catchAll = [makeCatchAllPackage("catch-1"), makeCatchAllPackage("catch-2")];
    await writeFile(join(cwd, "pi-ship.json"), JSON.stringify({ provider: "any" }));
    await expectCode(loadProviderRuntimeBinding(cwd, catchAll), "E_CONFIG_INVALID", "ambiguous");
  });

  it("throws E_CONFIG_INVALID when validateManifest rejects", async () => {
    cwd = await tmpDir();
    const validating = [
      makeMockPackageA((m: unknown) => {
        throw Object.assign(new Error("bad config: missing project"), { code: "E_CONFIG_INVALID", retryable: false });
      }),
      makeMockPackageB(),
    ];
    await writeFile(join(cwd, "pi-ship.json"), JSON.stringify({ provider: "mock-a", name: "test" }));
    await expectCode(loadProviderRuntimeBinding(cwd, validating), "E_CONFIG_INVALID", "missing project");
  });

  it("throws E_CONFIG_INVALID for unreadable manifest file at startup", async () => {
    cwd = await tmpDir();
    const manifestPath = join(cwd, "pi-ship.json");
    await writeFile(manifestPath, JSON.stringify({ provider: "mock-a", name: "test" }));
    // Remove read permission
    try {
      await chmod(manifestPath, 0o000);
      // Try reading to confirm it fails — if root, this may not fail; skip if so
      try {
        await readFile(manifestPath);
        // Read succeeded (running as root), cannot test permission error
        return;
      } catch {
        // Permission error works — proceed with test
      }
      await expectCode(loadProviderRuntimeBinding(cwd, mockPackages), "E_CONFIG_INVALID", "could not be read");
    } finally {
      await chmod(manifestPath, 0o644).catch(() => {});
    }
  });
});

describe("assertIntact — provider binding (with manifest)", () => {
  let cwd: string;
  let binding: ProviderRuntimeBinding;

  beforeEach(async () => {
    cwd = await tmpDir();
    await writeFile(join(cwd, "pi-ship.json"), JSON.stringify({ provider: "mock-a", name: "test" }));
    binding = await loadProviderRuntimeBinding(cwd, mockPackages);
  });

  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
  });

  it("passes when manifest is unchanged", async () => {
    await expect(binding.assertIntact(cwd)).resolves.toBeUndefined();
  });

  it("passes with symlink-resolved equal cwd", async () => {
    // cwd from mkdtemp is already canonical; test with explicit realpath
    const canonical = await realpath(cwd);
    await expect(binding.assertIntact(canonical)).resolves.toBeUndefined();
  });

  it("throws E_STATE_CONFLICT on canonical cwd mismatch", async () => {
    const otherDir = await tmpDir();
    try {
      await expectCode(binding.assertIntact(otherDir), "E_STATE_CONFLICT", "working directory changed");
    } finally {
      await rm(otherDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("throws E_STATE_CONFLICT when runtime cwd does not exist", async () => {
    const nonExistent = join(cwd, "does-not-exist-at-all");
    await expectCode(binding.assertIntact(nonExistent), "E_STATE_CONFLICT", "does not exist");
  });

  it("throws E_STATE_CONFLICT when manifest is removed after startup", async () => {
    await rm(join(cwd, "pi-ship.json"));
    await expectCode(binding.assertIntact(cwd), "E_STATE_CONFLICT", "changed");
  });

  it("throws E_STATE_CONFLICT when manifest bytes change (byte drift)", async () => {
    await writeFile(join(cwd, "pi-ship.json"), JSON.stringify({ provider: "mock-a", name: "changed" }));
    await expectCode(binding.assertIntact(cwd), "E_STATE_CONFLICT", "changed");
  });

  it("throws E_STATE_CONFLICT when manifest becomes unreadable (permission error)", async () => {
    const manifestPath = join(cwd, "pi-ship.json");
    try {
      await chmod(manifestPath, 0o000);
      // Confirm it's actually unreadable — skip if running as root
      try {
        await readFile(manifestPath);
        // Read succeeded (root), cannot test permission error
        return;
      } catch {
        // expected
      }
      await expectCode(binding.assertIntact(cwd), "E_STATE_CONFLICT", "changed");
    } finally {
      await chmod(manifestPath, 0o644).catch(() => {});
    }
  });

  it("throws E_STATE_CONFLICT (not E_CONFIG_INVALID) for post-startup read errors", async () => {
    const manifestPath = join(cwd, "pi-ship.json");
    try {
      await chmod(manifestPath, 0o000);
      try {
        await readFile(manifestPath);
        return; // root — skip
      } catch {
        // expected
      }
      // Must be E_STATE_CONFLICT, never E_CONFIG_INVALID
      let caught: unknown;
      try {
        await binding.assertIntact(cwd);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      expect(isShipError(caught)).toBe(true);
      if (isShipError(caught)) {
        expect(caught.code).toBe("E_STATE_CONFLICT");
        expect(caught.code).not.toBe("E_CONFIG_INVALID");
      }
    } finally {
      await chmod(manifestPath, 0o644).catch(() => {});
    }
  });

  it("does not JSON.parse manifest in assertIntact (bytes-only drift check)", async () => {
    // Replace manifest with invalid JSON — bytes changed, assertIntact should
    // detect digest mismatch, NOT try to parse and throw E_CONFIG_INVALID
    await writeFile(join(cwd, "pi-ship.json"), Buffer.from("not-json-at-all-{"));
    const err = await expectCode(binding.assertIntact(cwd), "E_STATE_CONFLICT");
    // Verify error code is NOT E_CONFIG_INVALID (no JSON parse attempted)
    if (isShipError(err)) {
      expect(err.code).toBe("E_STATE_CONFLICT");
    }
  });
});

describe("assertIntact — local binding (no manifest)", () => {
  let cwd: string;
  let binding: ProviderRuntimeBinding;

  beforeEach(async () => {
    cwd = await tmpDir();
    binding = await loadProviderRuntimeBinding(cwd, mockPackages);
    expect(binding.manifest).toBeUndefined();
    expect(binding.package).toBeUndefined();
    expect(binding.profile.id).toBe("local");
  });

  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
  });

  it("passes when no manifest file exists (remains absent)", async () => {
    await expect(binding.assertIntact(cwd)).resolves.toBeUndefined();
  });

  it("passes when no manifest file exists and cwd is correct (symlink-resolved)", async () => {
    const canonical = await realpath(cwd);
    await expect(binding.assertIntact(canonical)).resolves.toBeUndefined();
  });

  it("throws E_STATE_CONFLICT when manifest is created after startup", async () => {
    await writeFile(join(cwd, "pi-ship.json"), JSON.stringify({ provider: "mock-a" }));
    await expectCode(binding.assertIntact(cwd), "E_STATE_CONFLICT", "changed");
  });

  it("throws E_STATE_CONFLICT on cwd mismatch", async () => {
    const other = await tmpDir();
    try {
      await expectCode(binding.assertIntact(other), "E_STATE_CONFLICT", "changed");
    } finally {
      await rm(other, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("throws E_STATE_CONFLICT when runtime cwd does not exist", async () => {
    const gone = join(cwd, "nowhere");
    await expectCode(binding.assertIntact(gone), "E_STATE_CONFLICT", "does not exist");
  });
});

describe("error code contract — startup vs post-startup", () => {
  let cwd: string;

  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
  });

  it("startup errors always use E_CONFIG_INVALID", async () => {
    cwd = await tmpDir();
    // Missing file at startup → local binding (not error), so test invalid JSON
    await writeFile(join(cwd, "pi-ship.json"), "{bad");
    let err: unknown;
    try {
      await loadProviderRuntimeBinding(cwd, mockPackages);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    if (isShipError(err)) {
      expect(err.code).toBe("E_CONFIG_INVALID");
    } else {
      expect(err).toMatchObject({ code: "E_CONFIG_INVALID" });
    }

    // Unsupported provider
    cwd = await tmpDir();
    await writeFile(join(cwd, "pi-ship.json"), JSON.stringify({ provider: "nonexistent" }));
    try {
      await loadProviderRuntimeBinding(cwd, mockPackages);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    if (isShipError(err)) {
      expect(err.code).toBe("E_CONFIG_INVALID");
    } else {
      expect(err).toMatchObject({ code: "E_CONFIG_INVALID" });
    }
  });

  it("post-startup integrity errors use E_STATE_CONFLICT", async () => {
    cwd = await tmpDir();
    await writeFile(join(cwd, "pi-ship.json"), JSON.stringify({ provider: "mock-a", name: "test" }));
    const binding = await loadProviderRuntimeBinding(cwd, mockPackages);

    // Byte drift
    await writeFile(join(cwd, "pi-ship.json"), JSON.stringify({ provider: "mock-a", name: "other" }));
    let err: unknown;
    try {
      await binding.assertIntact(cwd);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    if (isShipError(err)) {
      expect(err.code).toBe("E_STATE_CONFLICT");
    } else {
      expect(err).toMatchObject({ code: "E_STATE_CONFLICT" });
    }
  });
});

describe("assertIntact — no JSON reparse", () => {
  let cwd: string;

  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
  });

  it("detects changed file via digest without parsing JSON", async () => {
    cwd = await tmpDir();
    // Start with valid JSON
    await writeFile(join(cwd, "pi-ship.json"), JSON.stringify({ provider: "mock-a" }));
    const binding = await loadProviderRuntimeBinding(cwd, mockPackages);

    // Replace with invalid JSON content — different bytes, digest mismatch
    await writeFile(join(cwd, "pi-ship.json"), Buffer.from("<<<NOT JSON>>>"));

    // assertIntact must throw E_STATE_CONFLICT (digest changed), not E_CONFIG_INVALID (parse error)
    let err: unknown;
    try {
      await binding.assertIntact(cwd);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    if (isShipError(err)) {
      expect(err.code).toBe("E_STATE_CONFLICT");
      expect(err.code).not.toBe("E_CONFIG_INVALID");
    } else {
      expect(err).toMatchObject({ code: "E_STATE_CONFLICT" });
    }
  });
});

describe("profile validation — startup", () => {
  let cwd: string;

  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
  });

  it("rejects profile.id mismatch with package id", async () => {
    cwd = await tmpDir();
    const mismatchPackage = makeMockPackageA();
    // Override the package id to differ from profile
    const bad: ProviderPackage = { ...mismatchPackage, id: "wrong-id" };
    await writeFile(join(cwd, "pi-ship.json"), JSON.stringify({ provider: "mock-a", name: "test" }));
    await expectCode(
      loadProviderRuntimeBinding(cwd, [bad]),
      "E_CONFIG_INVALID",
      'does not match package id',
    );
  });

  it("rejects ship-bearing profile without boundaryResource", async () => {
    cwd = await tmpDir();
    const profile = { id: "ship-only", ship: [{} as never], databaseAdditions: [], commands: [] };
    const pkg: ProviderPackage = {
      id: "ship-only",
      profile,
      isManifest: (v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).provider === "ship-only",
      isPlan: () => false,
      isState: () => false,
      defaultState: () => ({}),
      conflictMessage: { loadStateFromOther: "", saveStateOverOther: "" },
    };
    await writeFile(join(cwd, "pi-ship.json"), JSON.stringify({ provider: "ship-only" }));
    await expectCode(
      loadProviderRuntimeBinding(cwd, [pkg]),
      "E_CONFIG_INVALID",
      'no boundary resource',
    );
  });

  it("rejects profile with duplicate commands", async () => {
    cwd = await tmpDir();
    const profile = { id: "dup-cmds", ship: [], databaseAdditions: [], commands: ["cmd-a", "cmd-a"] };
    const pkg: ProviderPackage = {
      id: "dup-cmds",
      profile,
      isManifest: (v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).provider === "dup-cmds",
      isPlan: () => false,
      isState: () => false,
      defaultState: () => ({}),
      conflictMessage: { loadStateFromOther: "", saveStateOverOther: "" },
    };
    await writeFile(join(cwd, "pi-ship.json"), JSON.stringify({ provider: "dup-cmds" }));
    await expectCode(
      loadProviderRuntimeBinding(cwd, [pkg]),
      "E_CONFIG_INVALID",
      'duplicate commands',
    );
  });
});
