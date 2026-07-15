import type { ClassifiedStatement } from "./classifier.js";
import { err } from "../core/errors.js";
import { canonicalize } from "../core/canonicalize.js";

export type DBScalar = string | number | boolean | null;

export interface DatabasePayload {
  sql: string;
  params: DBScalar[];
  statements: ClassifiedStatement[];
}

function isScalar(value: unknown): value is DBScalar {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return true;
  return false;
}

export class DatabasePayloadRegistry {
  private records = new Map<string, DatabasePayload>();

  constructor(
    private readonly maxEntries = 100,
    private readonly maxTotalBytes = 10_000_000,
  ) {}

  private key(planId: string, digest: string): string {
    return `${planId}::${digest}`;
  }

  register(planId: string, digest: string, payload: DatabasePayload): void {
    if (!planId || !digest) {
      throw err("E_CONFIG_INVALID", "planId and digest required");
    }
    if (typeof payload.sql !== "string" || Buffer.byteLength(payload.sql, "utf8") < 1 || Buffer.byteLength(payload.sql, "utf8") > 100_000) {
      throw err("E_CONFIG_INVALID", "payload SQL must be 1..100000 bytes");
    }
    if (!Array.isArray(payload.params) || payload.params.length > 100 || !payload.params.every(isScalar)) {
      throw err("E_CONFIG_INVALID", "payload params must be at most 100 finite scalars");
    }
    if (!Array.isArray(payload.statements) || payload.statements.length < 1 || payload.statements.length > 20 || payload.statements.some((statement) => typeof statement.sql !== "string" || Buffer.byteLength(statement.sql, "utf8") < 1)) {
      throw err("E_CONFIG_INVALID", "payload statements must contain 1..20 nonempty SQL statements");
    }
    const copy = structuredClone(payload) as DatabasePayload;
    const key = this.key(planId, digest);
    const old = this.records.get(key);
    if (old) {
      const oldStr = canonicalize(old);
      const newStr = canonicalize(copy);
      if (oldStr !== newStr) {
        throw err("E_STATE_CONFLICT", "payload conflict: immutable payload differs");
      }
      return; // Already registered — no-op
    }
    // Check total byte budget
    const copyStr = canonicalize(copy);
    const newBytes = Buffer.byteLength(copyStr, "utf8");
    let totalBytes = newBytes;
    for (const [k, v] of this.records) {
      if (k !== key) totalBytes += Buffer.byteLength(canonicalize(v), "utf8");
    }
    if (totalBytes > this.maxTotalBytes) {
      throw err("E_CONFIG_INVALID", "payload registry over byte budget");
    }
    if (this.records.size >= this.maxEntries) {
      throw err("E_CONFIG_INVALID", "payload registry full");
    }
    this.records.set(key, copy);
  }

  get(planId: string, digest: string): DatabasePayload | undefined {
    const value = this.records.get(this.key(planId, digest));
    if (!value) return undefined;
    return structuredClone(value) as DatabasePayload;
  }

  /**
   * Returns the deep-cloned payload or throws E_STATE_CONFLICT when missing.
   * Use require when the payload must exist (after planning). Use get for optional lookup.
   */
  require(planId: string, digest: string): DatabasePayload {
    if (!planId || !digest) {
      throw err("E_CONFIG_INVALID", "planId and digest required");
    }
    const value = this.records.get(this.key(planId, digest));
    if (!value) {
      throw err("E_STATE_CONFLICT", `database payload missing for plan ${planId}; re-plan required`);
    }
    return structuredClone(value) as DatabasePayload;
  }

  clear(): void {
    this.records.clear();
  }

  get size(): number {
    return this.records.size;
  }
}
