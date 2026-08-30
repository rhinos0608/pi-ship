/**
 * Deterministic key-sorted JSON canonicalization.
 * Used by both Railway and Vercel packages for digest computation.
 * No provider imports — neutral utility.
 */
// Maximum recursion depth before cycle/stack guard kicks in
const MAX_DEPTH = 100;

function deepSortRec(val: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return val;
  if (Array.isArray(val)) return val.map((v) => deepSortRec(v, depth + 1));
  if (val && typeof val === "object" && !(val instanceof Date)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(val as Record<string, unknown>).sort()) {
      sorted[key] = deepSortRec((val as Record<string, unknown>)[key], depth + 1);
    }
    return sorted;
  }
  return val;
}

export function deepSort(val: unknown): unknown {
  return deepSortRec(val, 0);
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(deepSort(value));
}
