/** SQLite schema inspection — maps sqlite_master + PRAGMA to InspectResult. */
import type { DatabaseClient } from "../../client.js";
import type { InspectResult } from "../../inspect.js";
import { buildSafeDetails } from "../../output.js";
import type { SQLiteConnection } from "./client.js";

const CATEGORY_LIMIT = 500;

/**
 * Inspect a SQLite database.
 * Queries sqlite_master for relations, PRAGMA table_info for columns,
 * PRAGMA index_list/index_info for indexes, PRAGMA foreign_key_list for constraints.
 * PG-only categories (enums, triggers, policies) return empty arrays.
 */
export async function inspectSQLite(
  client: DatabaseClient,
  _signal?: AbortSignal,
): Promise<InspectResult> {
  // ── Relations (tables + views from sqlite_master) ──────────────
  const relationsResult = await client.query(
    "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name LIMIT ?",
    [CATEGORY_LIMIT + 1],
  );
  const relations = (relationsResult.rows ?? []).map((r: Record<string, unknown>) => ({
    schema: "main",
    name: String(r.name ?? ""),
    kind: String(r.type ?? "table"),
    rlsEnabled: false,
  }));

  // ── Columns per table ──────────────────────────────────────────
  const columns: InspectResult["columns"] = [];
  for (const rel of relations) {
    const colResult = await client.query(
      `SELECT name, type, [notnull], [pk], dflt_value FROM pragma_table_info(?)`,
      [rel.name],
    );
    for (const row of colResult.rows ?? []) {
      const r = row as Record<string, unknown>;
      columns.push({
        schema: "main",
        table: rel.name,
        name: String(r.name ?? ""),
        type: String(r.type ?? "TEXT"),
        nullable: r.notnull === 0 || r.notnull === false,
        default: r.dflt_value !== null && r.dflt_value !== undefined ? String(r.dflt_value) : undefined,
        isIdentity: r.pk === 1 || r.pk === true,
        isGenerated: false,
      });
    }
    if (columns.length > CATEGORY_LIMIT * 10) break; // safety
  }

  // ── Indexes ────────────────────────────────────────────────────
  const indexes: InspectResult["indexes"] = [];
  for (const rel of relations.filter((r) => r.kind === "table")) {
    const idxResult = await client.query(
      `SELECT name, [unique], origin FROM pragma_index_list(?)`,
      [rel.name],
    );
    for (const idxRow of idxResult.rows ?? []) {
      const ir = idxRow as Record<string, unknown>;
      const idxName = String(ir.name ?? "");
      // Get index columns
      const infoResult = await client.query(
        `SELECT name FROM pragma_index_info(?)`,
        [idxName],
      );
      const idxColumns = (infoResult.rows ?? []).map(
        (r: Record<string, unknown>) => String(r.name ?? ""),
      );
      indexes.push({
        schema: "main",
        table: rel.name,
        name: idxName,
        unique: ir.unique === 1 || ir.unique === true,
        primary: ir.origin === "pk",
        valid: true,
        columns: idxColumns,
      });
    }
    if (indexes.length > CATEGORY_LIMIT) break;
  }

  // ── Constraints (foreign keys) ─────────────────────────────────
  const constraints: InspectResult["constraints"] = [];
  for (const rel of relations.filter((r) => r.kind === "table")) {
    const fkResult = await client.query(
      `SELECT [from] AS fk_from, [to] AS fk_to, [table] AS fk_table, id FROM pragma_foreign_key_list(?)`,
      [rel.name],
    );
    for (const fkRow of fkResult.rows ?? []) {
      const fkr = fkRow as Record<string, unknown>;
      constraints.push({
        schema: "main",
        table: rel.name,
        name: `fk_${rel.name}_${String(fkr.id ?? 0)}`,
        type: "foreign_key",
        columns: typeof fkr.fk_from === "string" ? [String(fkr.fk_from)] : [],
        refSchema: "main",
        refTable: fkr.fk_table ? String(fkr.fk_table) : undefined,
        refColumns: typeof fkr.fk_to === "string" ? [String(fkr.fk_to)] : undefined,
        deferrable: false,
        deferred: false,
      });
    }
    if (constraints.length > CATEGORY_LIMIT) break;
  }

  // ── Schemas (just "main") ──────────────────────────────────────
  const schemas: InspectResult["schemas"] = [{ name: "main", owner: undefined }];

  // ── PG-only empty categories ───────────────────────────────────
  const enums: InspectResult["enums"] = [];
  const triggers: InspectResult["triggers"] = [];
  const policies: InspectResult["policies"] = [];

  const result: InspectResult = {
    schemas,
    relations: relations.slice(0, CATEGORY_LIMIT),
    columns: columns.slice(0, CATEGORY_LIMIT),
    indexes: indexes.slice(0, CATEGORY_LIMIT),
    enums,
    constraints: constraints.slice(0, CATEGORY_LIMIT),
    triggers,
    policies,
    truncatedCategories: [],
  };

  // Enforce total output budget (matching PG inspect behavior)
  const serialized = JSON.stringify(result);
  // Use buildSafeDetails-like budget check
  if (Buffer.byteLength(serialized, "utf8") > 512 * 1024) {
    result.truncatedCategories.push("columns");
    // Drop columns until under budget
    while (
      result.columns.length > 0 &&
      Buffer.byteLength(JSON.stringify(result), "utf8") > 512 * 1024
    ) {
      result.columns.splice(Math.ceil(result.columns.length / 2));
    }
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > 512 * 1024) {
      // Drop relations too
      result.truncatedCategories.push("relations");
      while (
        result.relations.length > 0 &&
        Buffer.byteLength(JSON.stringify(result), "utf8") > 512 * 1024
      ) {
        result.relations.splice(Math.ceil(result.relations.length / 2));
      }
    }
  }

  return result;
}
