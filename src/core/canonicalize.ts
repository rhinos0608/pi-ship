/**
 * Deterministic key-sorted JSON canonicalization.
 * Used by both Railway and Vercel packages for digest computation.
 * No provider imports — neutral utility.
 */
export function deepSort(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(deepSort);
  if (val && typeof val === "object" && !(val instanceof Date)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(val as Record<string, unknown>).sort()) {
      sorted[key] = deepSort((val as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return val;
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(deepSort(value));
}
