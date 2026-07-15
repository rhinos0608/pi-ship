import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  detectPermissionSystem,
  type PermissionSystemDetection,
} from "../../../src/boundary/integration/permission-system.js";

interface PermissionSystemRuntime {
  getYoloMode?(): unknown;
  setYoloMode?(enabled: boolean, options?: Record<string, unknown>): unknown;
  toggleYoloMode?(options?: Record<string, unknown>): unknown;
}

interface PermissionSystemGlobal {
  __piPermissionSystem?: PermissionSystemRuntime;
}

describe("detectPermissionSystem", () => {
  let saved: PermissionSystemRuntime | undefined;

  beforeEach(() => {
    saved = (globalThis as PermissionSystemGlobal).__piPermissionSystem;
    delete (globalThis as PermissionSystemGlobal).__piPermissionSystem;
  });

  afterEach(() => {
    if (saved !== undefined) {
      (globalThis as PermissionSystemGlobal).__piPermissionSystem = saved;
    } else {
      delete (globalThis as PermissionSystemGlobal).__piPermissionSystem;
    }
  });

  it("returns active:false when sentinel is absent", () => {
    const result = detectPermissionSystem();
    expect(result.active).toBe(false);
    expect(result.reason).toContain("not installed");
  });

  it("returns active:false when sentinel is null", () => {
    (globalThis as PermissionSystemGlobal).__piPermissionSystem = null as unknown as PermissionSystemRuntime;
    const result = detectPermissionSystem();
    expect(result.active).toBe(false);
  });

  it("returns active:false when sentinel is not an object", () => {
    (globalThis as PermissionSystemGlobal).__piPermissionSystem = "not-an-object" as unknown as PermissionSystemRuntime;
    const result = detectPermissionSystem();
    expect(result.active).toBe(false);
    expect(result.reason).toContain("not an object");
  });

  it("returns active:false when sentinel is an object but missing getYoloMode", () => {
    (globalThis as PermissionSystemGlobal).__piPermissionSystem = {} as PermissionSystemRuntime;
    const result = detectPermissionSystem();
    expect(result.active).toBe(false);
    expect(result.reason).toContain("missing getYoloMode");
  });

  it("returns active:true when getYoloMode is a function", () => {
    (globalThis as PermissionSystemGlobal).__piPermissionSystem = {
      getYoloMode: () => false,
    };
    const result = detectPermissionSystem();
    expect(result.active).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns active:false when getYoloMode returns non-boolean", () => {
    (globalThis as PermissionSystemGlobal).__piPermissionSystem = {
      getYoloMode: () => "string-not-boolean",
    };
    const result = detectPermissionSystem();
    expect(result.active).toBe(false);
  });

  it("returns active:false when getYoloMode throws", () => {
    (globalThis as PermissionSystemGlobal).__piPermissionSystem = {
      getYoloMode: () => { throw new Error("fail"); },
    };
    const result = detectPermissionSystem();
    expect(result.active).toBe(false);
  });

  it("returns active:true when toggleYoloMode is a function alongside getYoloMode", () => {
    (globalThis as PermissionSystemGlobal).__piPermissionSystem = {
      getYoloMode: () => false,
      toggleYoloMode: () => ({ error: undefined }),
    };
    const result = detectPermissionSystem();
    expect(result.active).toBe(true);
  });

  it("returns active:true with all three API methods present", () => {
    (globalThis as PermissionSystemGlobal).__piPermissionSystem = {
      getYoloMode: () => false,
      setYoloMode: () => undefined,
      toggleYoloMode: () => ({ error: undefined }),
    };
    const result = detectPermissionSystem();
    expect(result.active).toBe(true);
  });
});
