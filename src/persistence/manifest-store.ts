/**
 * Manifest file loading — reads pi-ship.json and returns a parsed raw object.
 * No provider-specific validation; the registry uses package predicates to resolve.
 *
 * Also provides one-read startup binding and byte-only drift guard.
 */
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { err } from "../core/errors.js";
import type { ProviderPackage } from "../providers/contracts.js";
import { localCapabilityProfile, type ProviderCapabilityProfile, type ProviderRuntimeBinding } from "../providers/capability-profile.js";

const MANIFEST_FILENAME = "pi-ship.json";

export function manifestPath(cwd: string): string {
  return join(cwd, MANIFEST_FILENAME);
}

/** Read and parse pi-ship.json; returns the raw parsed value. */
export async function readManifestRaw(cwd: string): Promise<unknown> {
  const path = manifestPath(cwd);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw err("E_CONFIG_INVALID", "manifest could not be read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw err("E_CONFIG_INVALID", "manifest is invalid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw err("E_CONFIG_INVALID", "manifest must be a JSON object");
  }
  return parsed;
}

/** Resolve one strict manifest owner without importing concrete providers. */
export async function loadManifestContract(
  cwd: string,
  packages: readonly ProviderPackage[],
): Promise<unknown> {
  const manifest = await readManifestRaw(cwd);
  const matches = packages.filter((providerPackage) => providerPackage.isManifest(manifest));
  if (matches.length > 1) {
    throw err("E_CONFIG_INVALID", "ambiguous manifest contract matched multiple provider packages");
  }
  const owner = matches[0];
  if (!owner) throw err("E_CONFIG_INVALID", "unsupported manifest provider/version");
  owner.validateManifest?.(manifest);
  return manifest;
}

// ── Startup binding ─────────────────────────────────────────────────────

/**
 * Read raw bytes of pi-ship.json and return them along with a SHA-256 digest.
 * Returns undefined if file does not exist (ENOENT).
 */
async function readManifestBytes(cwd: string): Promise<{ bytes: Buffer; digest: string } | undefined> {
  const path = manifestPath(cwd);
  try {
    const bytes = await readFile(path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    return { bytes, digest };
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err("E_CONFIG_INVALID", "manifest could not be read");
  }
}

/**
 * Build one startup binding from cwd + available packages.
 *
 * - ENOENT → local binding (no manifest, local profile)
 * - Present file → parse once, resolve one package, validate, capture SHA-256 digest
 * - Invalid/unreadable/unresolvable → throws E_CONFIG_INVALID (never downgrades)
 */
export async function loadProviderRuntimeBinding(
  cwd: string,
  packages: readonly ProviderPackage[],
): Promise<ProviderRuntimeBinding> {
  // Canonicalize startup cwd once
  const startupCwd = await realpath(cwd);
  const bytesResult = await readManifestBytes(startupCwd);

  if (!bytesResult) {
    // No manifest — local profile
    return makeLocalBinding(startupCwd);
  }

  const { bytes, digest } = bytesResult;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw err("E_CONFIG_INVALID", "manifest is invalid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw err("E_CONFIG_INVALID", "manifest must be a JSON object");
  }

  // Resolve exactly one package
  const matches = packages.filter((p) => p.isManifest(parsed));
  if (matches.length > 1) {
    throw err("E_CONFIG_INVALID", "ambiguous manifest contract matched multiple provider packages");
  }
  const providerPackage = matches[0];
  if (!providerPackage) {
    throw err("E_CONFIG_INVALID", "unsupported manifest provider/version");
  }
  providerPackage.validateManifest?.(parsed);

  // Build immutable binding
  const profile = providerPackage.profile;

  // Validate selected profile at startup
  validateProfile(profile, providerPackage.id);
  const binding: ProviderRuntimeBinding = {
    cwd: startupCwd,
    manifest: parsed,
    package: providerPackage,
    profile,
    manifestBytesDigest: digest,
    async assertIntact(runtimeCwd: string): Promise<void> {
      const canonicalRuntime = await realpath(runtimeCwd).catch(() => {
        throw err("E_STATE_CONFLICT", "runtime working directory does not exist");
      });
      if (canonicalRuntime !== startupCwd) {
        throw err("E_STATE_CONFLICT", "runtime working directory changed since startup; reload or restart");
      }
      let current;
      try {
        current = await readManifestBytes(startupCwd);
      } catch {
        // Post-startup read/permission errors normalized to E_STATE_CONFLICT
        throw err("E_STATE_CONFLICT", "provider manifest changed since startup; reload or restart");
      }
      if (!current) {
        throw err("E_STATE_CONFLICT", "provider manifest changed since startup; reload or restart");
      }
      if (current.digest !== digest) {
        throw err("E_STATE_CONFLICT", "provider manifest changed since startup; reload or restart");
      }
    },
  };
  return binding;
}

/** Validate profile integrity at startup. Aborts E_CONFIG_INVALID on mismatch. */
function validateProfile(profile: ProviderCapabilityProfile, expectedPackageId: string): void {
  if (profile.id !== expectedPackageId) {
    throw err("E_CONFIG_INVALID", `profile id "${profile.id}" does not match package id "${expectedPackageId}"`);
  }
  if (profile.commands.length !== new Set(profile.commands).size) {
    throw err("E_CONFIG_INVALID", `profile "${profile.id}" has duplicate commands`);
  }
  if (profile.ship.length > 0 && !profile.boundaryResource) {
    throw err("E_CONFIG_INVALID", `profile "${profile.id}" has ship variants but no boundary resource`);
  }
}

function makeLocalBinding(cwd: string): ProviderRuntimeBinding {
  return {
    cwd,
    manifest: undefined,
    package: undefined,
    profile: localCapabilityProfile,
    manifestBytesDigest: undefined,
    async assertIntact(runtimeCwd: string): Promise<void> {
      const canonicalRuntime = await realpath(runtimeCwd).catch(() => {
        throw err("E_STATE_CONFLICT", "runtime working directory does not exist");
      });
      if (canonicalRuntime !== cwd) {
        throw err("E_STATE_CONFLICT", "runtime working directory changed since startup; reload or restart");
      }
      // Local binding: reject if manifest now exists (created after startup)
      const path = manifestPath(cwd);
      try {
        await access(path);
        throw err("E_STATE_CONFLICT", "provider manifest changed since startup; reload or restart");
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          // Still no manifest — all good
          return;
        }
        if ((e as NodeJS.ErrnoException).code === "E_STATE_CONFLICT") {
          throw e;
        }
        throw err("E_STATE_CONFLICT", "provider manifest changed since startup; reload or restart");
      }
    },
  };
}
