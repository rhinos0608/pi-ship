/** Safe JSON output normalization for database read results. */
const CELL_STRING_MAX_BYTES = 8_192; // ~8KiB per cell string cap
const DETAILS_MAX_BYTES = 512 * 1024; // 512KiB total serialized details cap

export interface SafeDetails {
  columns: { name: string; dataTypeID?: number }[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  rowCount: number;
}

/**
 * Truncate string to fit within `maxBytes` UTF-8 bytes.
 * Appends "..." when truncated.
 */
function truncateUTF8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let len = maxBytes - 3; // reserve space for "..."
  if (len <= 0) return "...";
  while (len > 0 && Buffer.byteLength(value.slice(0, len), "utf8") > maxBytes - 3) len--;
  return value.slice(0, len) + "...";
}

/**
 * Normalize a single cell value for safe JSON serialization.
 * - bigint → string
 * - Date → ISO string
 * - Buffer → hex string (UTF-8 byte truncated)
 * - Non-finite number (NaN, Infinity, -Infinity) → null
 * - Objects/arrays recursed with depth limit
 * - Strings truncated to CELL_STRING_MAX_BYTES (UTF-8 aware)
 * - null/boolean/string/number pass through
 */
export function normalizeCell(
  value: unknown,
  depth: number = 0,
  maxDepth: number = 5,
): unknown {
  if (depth > maxDepth) return null;
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    return truncateUTF8(value, CELL_STRING_MAX_BYTES);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    const hex = value.toString("hex");
    return truncateUTF8(hex, CELL_STRING_MAX_BYTES);
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      result.push(normalizeCell(item, depth + 1, maxDepth));
    }
    return result;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      result[key] = normalizeCell(record[key], depth + 1, maxDepth);
    }
    return result;
  }
  // symbol, function, etc.
  return null;
}

/**
 * Normalize all rows and compute total byte budget.
 * Returns normalized rows capped to total serialized budget of 512KiB.
 * Does NOT throw when budget exceeded — returns truncated=true.
 * Returns actual safe row count as rowCount.
 * Measures the full SafeDetails JSON each row to accurately count all overhead.
 */
export function buildSafeDetails(
  columns: { name: string; dataTypeID?: number }[],
  rows: Record<string, unknown>[],
  options?: { maxTotalBytes?: number },
): SafeDetails {
  const maxBytes = options?.maxTotalBytes ?? DETAILS_MAX_BYTES;

  const safeRows: Record<string, unknown>[] = [];
  let truncated = false;

  for (const raw of rows) {
    const safe: Record<string, unknown> = {};
    for (const col of columns) {
      safe[col.name] = normalizeCell(raw[col.name]);
    }
    // Measure full serialized result with this row included
    const candidate = JSON.stringify({ columns, rows: [...safeRows, safe], truncated: false, rowCount: safeRows.length + 1 });
    if (Buffer.byteLength(candidate, "utf8") > maxBytes) {
      truncated = true;
      break;
    }
    safeRows.push(safe);
  }

  return { columns, rows: safeRows, truncated, rowCount: safeRows.length };
}
