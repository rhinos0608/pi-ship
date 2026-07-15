/**
 * Detector for the pi-permission-system extension.
 *
 * pi-ship's exclusive mode requires an active external boundary as defense-in-depth.
 * pi-permission-system provides independent policy-based tool gating — a complementary
 * layer that controls what tools/models can do before pi-ship's credential vault gates.
 *
 * Detection uses the public runtime sentinel `globalThis.__piPermissionSystem`,
 * documented in pi-permission-system's README. The sentinel is set during extension
 * bootstrap and exposes `getYoloMode` / `toggleYoloMode` / `setYoloMode`.
 *
 * We never import pi-permission-system as a dependency — structural feature detection only.
 */

interface PermissionSystemRuntime {
  getYoloMode?(): unknown;
  setYoloMode?(enabled: boolean, options?: Record<string, unknown>): unknown;
  toggleYoloMode?(options?: Record<string, unknown>): unknown;
}

interface PermissionSystemGlobal {
  __piPermissionSystem?: PermissionSystemRuntime;
}

/**
 * Result of probing for pi-permission-system at runtime.
 */
export interface PermissionSystemDetection {
  /** Whether the extension is loaded and responding. */
  active: boolean;
  /** Human-readable reason when inactive. */
  reason?: string;
}

/**
 * Feature-detect pi-permission-system via its public runtime sentinel.
 *
 * Checks that `globalThis.__piPermissionSystem` exists and has at minimum
 * the `getYoloMode` function — the canonical public API entry point.
 *
 * This does NOT validate policy strength. Exclusive mode only needs to know
 * another boundary extension is present; policy content is the operator's
 * responsibility.
 */
export function detectPermissionSystem(): PermissionSystemDetection {
  const g = globalThis as PermissionSystemGlobal;
  const sys = g.__piPermissionSystem;

  if (sys === undefined || sys === null) {
    return { active: false, reason: "pi-permission-system not installed or not loaded" };
  }

  if (typeof sys !== "object") {
    return { active: false, reason: "pi-permission-system runtime API is not an object" };
  }

  // getYoloMode is the canonical public entry point — require it specifically.
  if (typeof sys.getYoloMode !== "function") {
    return { active: false, reason: "pi-permission-system runtime API missing getYoloMode" };
  }

  try {
    const result = sys.getYoloMode();
    if (typeof result !== "boolean") {
      return { active: false, reason: "pi-permission-system getYoloMode did not return boolean" };
    }
  } catch {
    return { active: false, reason: "pi-permission-system getYoloMode threw an error" };
  }

  return { active: true };
}
