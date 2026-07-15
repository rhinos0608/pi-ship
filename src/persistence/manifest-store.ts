/**
 * Manifest file loading — reads pi-ship.json and returns a parsed raw object.
 * No provider-specific validation; the registry uses package predicates to resolve.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { err } from "../core/errors.js";
import type { ProviderPackage } from "../providers/contracts.js";

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
