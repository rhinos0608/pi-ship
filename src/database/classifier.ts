import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { err } from "../core/errors.js";

const require = createRequire(import.meta.url);
// @pgsql/parser 1.5.0 v17: both CJS (require) and ESM exports exist.
// wasm/v17.cjs re-exports wasm/v17/index.cjs; wasm/v17/index.d.ts confirms parse export.
const parser: { parse(sql: string): Promise<{ stmts?: unknown[] }> } = require("@pgsql/parser/v17");

export type RiskLevel = "read" | "write" | "destructive" | "blocked";
export interface StatementDescriptor {
  index: number; tag: string; risk: RiskLevel; tables: string[]; sqlFingerprint: string; paramCount: number; reasons: string[];
}
export interface ClassifiedStatement extends StatementDescriptor { sql: string; }
export interface Classification { riskLevel: RiskLevel; statements: ClassifiedStatement[]; destructiveReasons: string[]; maxParamRef: number; }

export interface WalkResult { blocked: boolean; reasons: string[]; }

const rank: Record<RiskLevel, number> = { read: 0, write: 1, destructive: 2, blocked: 3 };
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");

// ── Bad function patterns ───────────────────────────────────────────
const badFunction = /^(pg_sleep|pg_advisory_|pg_cancel_backend|pg_terminate_backend|lo_(import|export|create|unlink|open|write|read|truncate)|dblink|pg_read_|pg_ls_|pg_stat_file|set_config|pg_reload_conf|pg_notify|nextval|setval|pg_(start|stop)_backup|pg_switch_wal|pg_create_restore_point|pg_logical_emit)/i;

function isBlockedFunction(name: string): boolean {
  const localName = name.slice(name.lastIndexOf(".") + 1);
  return badFunction.test(localName);
}

// ── Version-pinned PG17 support/expression/type node allowlist ─────
// Tags from @pgsql/parser v17 Node type that are safe expression/type/utility nodes.
// Any node in the parsed AST whose tag is not in this set or in statementTags is rejected.
const supportTags = new Set([
  // Base values
  "Integer", "Float", "Boolean", "String", "BitString",
  // Lists
  "List", "OidList", "IntList",
  // Expressions / values
  "A_Const", "Alias", "RangeVar", "TableFunc", "IntoClause",
  "Var", "Param", "Aggref", "GroupingFunc", "WindowFunc", "WindowFuncRunCondition", "MergeSupportFunc",
  "SubscriptingRef", "FuncExpr", "NamedArgExpr", "OpExpr", "DistinctExpr", "NullIfExpr",
  "ScalarArrayOpExpr", "BoolExpr", "SubLink", "SubPlan", "AlternativeSubPlan",
  "FieldSelect", "FieldStore", "RelabelType", "CoerceViaIO", "ArrayCoerceExpr",
  "ConvertRowtypeExpr", "CollateExpr", "CaseExpr", "CaseWhen", "CaseTestExpr",
  "ArrayExpr", "RowExpr", "RowCompareExpr", "CoalesceExpr", "MinMaxExpr",
  "SQLValueFunction", "XmlExpr", "XmlSerialize",
  // JSON expressions (PG17)
  "JsonFormat", "JsonReturning", "JsonValueExpr", "JsonConstructorExpr",
  "JsonIsPredicate", "JsonBehavior", "JsonExpr", "JsonTablePath", "JsonTablePathScan",
  "JsonTableSiblingJoin", "JsonFuncExpr", "JsonAggConstructor", "JsonArrayAgg",
  "JsonArrayConstructor", "JsonArrayQueryConstructor", "JsonObjectAgg",
  "JsonObjectConstructor", "JsonOutput", "JsonParseExpr", "JsonScalarExpr",
  "JsonSerializeExpr", "JsonTable", "JsonTableColumn", "JsonTablePathSpec",
  "JsonKeyValue", "JsonArgument",
  // Tests / coercions
  "NullTest", "BooleanTest",
  // Merge internals
  "MergeAction", "MergeWhenClause",
  // Domain / coercion
  "CoerceToDomain", "CoerceToDomainValue", "SetToDefault", "CurrentOfExpr", "NextValueExpr",
  // Inference
  "InferenceElem",
  // Query representation
  "TargetEntry", "RangeTblRef", "JoinExpr", "FromExpr", "OnConflictExpr",
  "Query", "SortGroupClause",
  // Types / columns
  "TypeName", "ColumnRef", "ParamRef",
  // Operators / casts
  "A_Expr", "TypeCast", "CollateClause",
  // Roles
  "RoleSpec",
  // Function calls
  "FuncCall",
  // Star / indirection
  "A_Star", "A_Indices", "A_Indirection", "A_ArrayExpr",
  // Targets
  "ResTarget", "MultiAssignRef",
  // Sorting / windowing
  "SortBy", "WindowDef", "WindowClause",
  // Range
  "RangeSubselect", "RangeFunction", "RangeTableFunc", "RangeTableFuncCol", "RangeTableSample",
  // Columns / constraints
  "ColumnDef", "Constraint", "IndexElem",
  // Partitions
  "PartitionBoundSpec", "PartitionCmd", "PartitionElem", "PartitionRangeDatum",
  "PartitionSpec", "SinglePartitionSpec",
  // Table-like
  "TableLikeClause", "TableSampleClause",
  // Locking / row marks
  "LockingClause", "RowMarkClause",
  // CTE / with clause
  "WithClause", "CommonTableExpr", "CTECycleClause", "CTESearchClause",
  // On conflict
  "OnConflictClause", "InferClause",
  // Function internals
  "FunctionParameter", "ObjectWithArgs", "DefElem", "InlineCodeBlock", "PLAssignStmt",
  // Grant
  "AccessPriv",
  // Trigger transitions
  "TriggerTransition",
  // Alter table commands
  "AlterTableCmd",
  // Create op class
  "CreateOpClassItem",
  // Publication
  "PublicationObjSpec", "PublicationTable",
  // Stats
  "StatsElem",
  // RTE
  "RangeTblEntry", "RangeTblFunction", "RTEPermissionInfo",
  // Vacuum
  "VacuumRelation",
  // With check option
  "WithCheckOption",
  // Parser wrappers and expression support
  "RawStmt", "ScanToken", "ReturnStmt", "CallContext", "GroupingSet",
]);

// ── Statement allowlist — each tagged statement node must be explicitly classified ──
const blockedTop = new Set([
  "TransactionStmt", "DoStmt", "CallStmt", "CopyStmt",
  "CreateRoleStmt", "AlterRoleStmt", "DropRoleStmt",
  "GrantStmt", "GrantRoleStmt", "AlterDefaultPrivilegesStmt",
  "CreateExtensionStmt", "AlterExtensionStmt",
  "CreateFdwStmt", "AlterFdwStmt",
  "CreateForeignServerStmt", "AlterForeignServerStmt",
  "CreateUserMappingStmt", "AlterUserMappingStmt", "DropUserMappingStmt",
  "CreateFunctionStmt", "AlterFunctionStmt",
  "CreateTrigStmt", "CreateEventTrigStmt",
  "CreatePolicyStmt", "AlterPolicyStmt",
  "CreatePLangStmt", "AlterPLangStmt",
  "VariableSetStmt", "VariableShowStmt", "DiscardStmt",
  "PrepareStmt", "ExecuteStmt", "DeallocateStmt",
  "ListenStmt", "NotifyStmt", "UnlistenStmt",
  "LockStmt", "ExplainStmt",
  "VacuumStmt", "ReindexStmt", "ClusterStmt", "CheckPointStmt", "LoadStmt",
  "DeclareCursorStmt", "FetchStmt", "ClosePortalStmt",
  "AlterDatabaseStmt", "AlterDatabaseSetStmt", "AlterDatabaseRefreshCollStmt",
  "AlterOpFamilyStmt",
  "AlterEventTrigStmt",
  "AlterExtensionContentsStmt",
  "AlterObjectDependsStmt", "AlterObjectSchemaStmt", "AlterOwnerStmt", "AlterOperatorStmt",
  "AlterRoleSetStmt",
  "AlterSeqStmt",
  "AlterStatsStmt", "AlterSystemStmt",
  "AlterTSConfigurationStmt", "AlterTSDictionaryStmt",
  "AlterTableMoveAllStmt", "AlterTableSpaceOptionsStmt",
  "AlterDomainStmt", "AlterPublicationStmt", "AlterSubscriptionStmt",
  "AlterCollationStmt",
  "CreateAmStmt", "CreateCastStmt", "CreateConversionStmt", "CreateDomainStmt",
  "CreateOpClassStmt", "CreateOpFamilyStmt",
  "CreatePublicationStmt", "CreateSubscriptionStmt",
  "CreateStatsStmt", "CreateTableSpaceStmt", "CreateTransformStmt",
  "CreateRangeStmt",
  "ImportForeignSchemaStmt",
  "DropOwnedStmt", "ReassignOwnedStmt",
  "RuleStmt", "SecLabelStmt",
  "CompositeTypeStmt", "CreateTypeStmt",
  "ConstraintsSetStmt",
  "RefreshMatViewStmt",
  "ReplicaIdentityStmt",
  "CreatedbStmt", "DropdbStmt",
  "DropSubscriptionStmt", "DropTableSpaceStmt",
  "DefineStmt",
  "AlterForeignTableStmt",
  "CreateForeignTableStmt",
]);
const additiveCreate = new Set(["CreateStmt", "CreateTableAsStmt", "CreateSchemaStmt", "ViewStmt", "IndexStmt", "CreateSeqStmt", "CreateEnumStmt"]);
const destructiveTop = new Set(["DropStmt", "TruncateStmt"]);

// Combined allowlist for all known tags (statements + support)
const allTags = new Set([...supportTags, ...blockedTop, ...additiveCreate, ...destructiveTop,
  "SelectStmt", "InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt",
  "AlterTableStmt", "AlterEnumStmt", "SetOperationStmt",
  "CommentStmt", "AlterTypeStmt", "RenameStmt",
]);

// ── Tags representing actual SQL statements (not support/expression nodes) ──
// Used for recursive risk aggregation in subqueries/CTEs/UNION.
const statementTags = new Set([
  "SelectStmt", "InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt",
  "SetOperationStmt", "TruncateStmt", "DropStmt", "AlterTableStmt",
  "AlterEnumStmt", "RenameStmt", "CommentStmt", "AlterTypeStmt",
  ...additiveCreate, ...destructiveTop, ...blockedTop,
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function tagOf(value: unknown): [string, unknown] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const keys = Object.keys(record);
  return keys.length === 1 ? [keys[0]!, record[keys[0]!]] : undefined;
}

function bodyRecord(value: unknown): Record<string, unknown> | undefined {
  return asRecord(value);
}

function alterSubtype(value: unknown): string | undefined {
  const tagged = tagOf(value);
  if (!tagged || tagged[0] !== "AlterTableCmd") return undefined;
  const body = bodyRecord(tagged[1]);
  return typeof body?.subtype === "string" ? body.subtype : undefined;
}

function nameOf(node: unknown): string | undefined {
  const n = asRecord(node);
  if (!n) return undefined;
  const parts = n.funcname;
  if (!Array.isArray(parts)) return undefined;
  return parts.map((part: unknown) => {
    const tagged = tagOf(part);
    if (!tagged || typeof tagged[1] !== "object" || !tagged[1]) return "";
    const body = bodyRecord(tagged[1]);
    return typeof body?.sval === "string" ? body.sval : "";
  }).filter(Boolean).join(".");
}

// ── Pure AST walker — no parser dependency, exported as test seam ────
export function walkAST(top: unknown): WalkResult {
  const seen = new Set<unknown>();
  const bad: string[] = [];

  // Heuristic: AST node tags are PascalCase (/^[A-Z][a-z]/).
  // Lowercase/camelCase single keys like { ival: 1 }, { sval: "x" }, { location: 42 }
  // are field property bags, not node tags.
  function isNodeTag(key: string): boolean {
    return /^[A-Z]/.test(key);
  }

  function walk(value: unknown): void {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) { for (const item of value) walk(item); return; }

    const tagged = tagOf(value);
    if (tagged && allTags.has(tagged[0])) {
      // Known AST node tag — process it
      const [tag, body] = tagged;
      if (tag === "FuncCall") {
        const fname = nameOf(body);
        if (fname && isBlockedFunction(fname)) {
          bad.push(`blocked function ${fname}`);
        }
      }
      // Recurse into body properties (the actual node fields)
      const record = bodyRecord(body);
      if (record) {
        for (const child of Object.values(record)) walk(child);
      }
    } else if (tagged && isNodeTag(tagged[0]) && !allTags.has(tagged[0])) {
      // Single-key PascalCase that's not in the known allowlist — unknown future wrapper
      bad.push(`unknown AST tag: ${tagged[0]}`);
    } else if (tagged) {
      // Single-key lowercase/camelCase (field bag like { ival: 1 }, { sval: "x" })
      // Walk values as a plain object
      for (const child of Object.values(value as Record<string, unknown>)) walk(child);
    } else {
      // Plain object with multiple keys or zero keys — walk values
      for (const child of Object.values(value as Record<string, unknown>)) walk(child);
    }
  }

  walk(top);
  return { blocked: bad.length > 0, reasons: bad };
}

function walkForClassification(value: unknown, result: { tables: Set<string>; params: Set<number>; bad: string[] }, seen = new Set<unknown>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) { for (const item of value) walkForClassification(item, result, seen); return; }

  const tagged = tagOf(value);
  if (tagged && allTags.has(tagged[0])) {
    // Known AST node tag
    const [tag, body] = tagged;
    const record = bodyRecord(body);
    if (tag === "RangeVar" && typeof record?.relname === "string") {
      result.tables.add([record.schemaname, record.relname].filter((part): part is string => typeof part === "string").join("."));
    }
    const paramNumber = record?.number;
    if (tag === "ParamRef" && typeof paramNumber === "number" && Number.isInteger(paramNumber)) {
      result.params.add(paramNumber);
    }
    if (tag === "FuncCall") {
      const fname = nameOf(body);
      if (fname && isBlockedFunction(fname)) result.bad.push(`blocked function ${fname}`);
    }
    // Recurse into body properties
    if (record) {
      for (const child of Object.values(record)) walkForClassification(child, result, seen);
    }
  } else if (tagged && /^[A-Z]/.test(tagged[0]) && !allTags.has(tagged[0])) {
    // Unknown PascalCase tag — reject
    result.bad.push(`unknown AST tag: ${tagged[0]}`);
  } else if (tagged) {
    // Single-key lowercase/camelCase (field bag) — walk as plain object
    for (const child of Object.values(value as Record<string, unknown>)) walkForClassification(child, result, seen);
  } else {
    // Plain object with multiple or zero keys — walk values
    for (const child of Object.values(value as Record<string, unknown>)) walkForClassification(child, result, seen);
  }
}

function selectRisk(body: unknown): [RiskLevel, string[]] {
  const record = bodyRecord(body);
  if (!record) return ["blocked", ["invalid SelectStmt"]];
  if (record.intoClause || (Array.isArray(record.lockingClause) && record.lockingClause.length)) {
    return ["write", [record.intoClause ? "SELECT INTO" : "locking SELECT"]];
  }
  return ["read", []];
}

function classifyNode(node: unknown): [string, RiskLevel, string[]] {
  const tagged = tagOf(node);
  if (!tagged) return ["unknown", "blocked", ["unknown top-level AST node"]];
  const [tag, body] = tagged;

  // Unknown tag at top level
  if (!allTags.has(tag)) return [tag, "blocked", [`unknown AST tag: ${tag}`]];

  if (tag === "SelectStmt") return [tag, ...selectRisk(body)];
  if (tag === "InsertStmt" || tag === "UpdateStmt") return [tag, "write", []];
  if (tag === "DeleteStmt") return [tag, "destructive", ["DELETE"]];
  if (tag === "MergeStmt") return [tag, "blocked", ["MERGE"]];
  if (tag === "RenameStmt") return [tag, "destructive", ["RENAME"]];
  if (tag === "SetOperationStmt") return [tag, "read", []];

  if (additiveCreate.has(tag)) return [tag, "write", []];
  if (destructiveTop.has(tag)) return [tag, "destructive", [tag === "DropStmt" ? "DROP" : "TRUNCATE"]];
  if (blockedTop.has(tag)) return [tag, "blocked", [tag]];

  // ALTER TABLE — classify based on subtype commands
  if (tag === "AlterTableStmt") {
    const record = bodyRecord(body);
    const cmds = record?.cmds;
    if (!Array.isArray(cmds) || cmds.length === 0) return [tag, "blocked", ["unknown ALTER TABLE"]];
    // Destructive subtypes (PG17 enums)
    const destructiveSubtypes = new Set([
      "AT_DropColumn", "AT_DropConstraint", "AT_DropNotNull",
      "AT_AlterColumnType", "AT_DropExpression", "AT_DropIdentity",
      "AT_DetachPartition", "AT_DetachPartitionFinalize",
      "AT_DropInherit", "AT_DropCluster", "AT_DropOids",
      "AT_ChangeOwner",
    ]);
    // Additive/safe subtypes
    const additiveSubtypes = new Set([
      "AT_AddColumn", "AT_AddColumnToView", "AT_AddConstraint",
      "AT_AddIndex", "AT_ColumnDefault", "AT_SetNotNull",
      "AT_ValidateConstraint", "AT_AddIndexConstraint",
      "AT_SetStatistics", "AT_SetOptions", "AT_ResetOptions",
      "AT_SetStorage", "AT_SetCompression",
      "AT_AttachPartition",
      "AT_AddIdentity", "AT_SetIdentity",
      "AT_ReAddIndex", "AT_ReAddConstraint", "AT_ReAddDomainConstraint", "AT_ReAddComment", "AT_ReAddStatistics",
    ]);
    const hasDestructive = cmds.some((command) => {
      const subtype = alterSubtype(command);
      return subtype !== undefined && destructiveSubtypes.has(subtype);
    });
    const allAdditive = cmds.every((command) => {
      const subtype = alterSubtype(command);
      return subtype !== undefined && additiveSubtypes.has(subtype);
    });
    if (hasDestructive) return [tag, "destructive", ["destructive ALTER TABLE"]];
    if (allAdditive) return [tag, "write", []];
    return [tag, "blocked", ["mixed/unsupported ALTER TABLE commands"]];
  }

  const record = bodyRecord(body);
  if (tag === "AlterEnumStmt") return [tag, record?.oldVal ? "destructive" : "write", record?.oldVal ? ["ALTER ENUM rename"] : []];
  if (tag === "CommentStmt") return [tag, "write", []];
  if (tag === "AlterTypeStmt") return [tag, "blocked", ["AlterTypeStmt"]];

  return [tag, "blocked", [`unknown top-level AST node`]];
}

/** Test seam for parser-impossible nested statement AST shapes. */
export function nestedStatementRisk(root: unknown): [RiskLevel, string[]] {
  const seen = new Set<unknown>();
  let risk: RiskLevel = "read";
  const reasons: string[] = [];

  function walk(value: unknown): void {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const child of value) walk(child);
      return;
    }
    const tagged = tagOf(value);
    if (tagged && allTags.has(tagged[0])) {
      if (value !== root && statementTags.has(tagged[0])) {
        const [, childRisk, childReasons] = classifyNode(value);
        if (rank[childRisk] > rank[risk]) risk = childRisk;
        reasons.push(...childReasons);
      }
      const record = bodyRecord(tagged[1]);
      if (record) for (const child of Object.values(record)) walk(child);
      return;
    }
    const record = asRecord(value);
    if (record) for (const child of Object.values(record)) walk(child);
  }

  walk(root);
  return [risk, reasons];
}

function sliceSql(sql: string, loc: number | undefined, len: number | undefined, nextLoc: number | undefined): string {
  const bytes = Buffer.from(sql, "utf8");
  const start = loc ?? 0;
  const end = len ? start + len : (nextLoc ?? bytes.length);
  return bytes.subarray(start, end).toString("utf8");
}

export async function classifySQL(sql: string, params: readonly unknown[] = []): Promise<Classification> {
  // Validate params before parsing — no non-finite numbers, no non-scalar values
  if (params.some((p) => {
    if (p === null || typeof p === "boolean") return false;
    if (typeof p === "number") return !Number.isFinite(p);
    if (typeof p === "string") return false;
    return true;
  })) {
    throw err("E_CONFIG_INVALID", "SQL parameters must be finite scalar values");
  }

  interface ParsedRawStatement {
    stmt: unknown;
    stmt_location?: unknown;
    stmt_len?: unknown;
  }
  interface ParsedDocument { stmts?: ParsedRawStatement[]; }
  let parsed: ParsedDocument;
  try { parsed = await parser.parse(sql) as ParsedDocument; } catch { throw err("E_CONFIG_INVALID", "SQL parser rejected input"); }
  const stmts = parsed.stmts ?? [];
  if (!stmts.length || stmts.length > 20) {
    throw err("E_CONFIG_INVALID", !stmts.length ? "SQL must contain at least one statement" : "SQL has too many statements (max 20)");
  }

  // Pre-walk entire tree for unknown tag detection
  for (const item of stmts) {
    const result = walkAST(item.stmt);
    if (result.blocked) {
      throw err("E_CONFIG_INVALID", `SQL contains unknown AST wrapper: ${result.reasons.join("; ")}`);
    }
  }

  const statements: ClassifiedStatement[] = [];
  let overall: RiskLevel = "read";
  const allParams = new Set<number>();

  for (let index = 0; index < stmts.length; index++) {
    const item = stmts[index]!;
    const [tag, initialRisk, initialReasons] = classifyNode(item.stmt);
    const [nestedRisk, nestedReasons] = nestedStatementRisk(item.stmt);
    const detail = { tables: new Set<string>(), params: new Set<number>(), bad: [] as string[] };
    walkForClassification(item.stmt, detail);
    let risk = rank[nestedRisk] > rank[initialRisk] ? nestedRisk : initialRisk;
    const reasons = [...initialReasons, ...nestedReasons, ...detail.bad];
    if (detail.bad.length) risk = "blocked";

    const max = detail.params.size ? Math.max(...detail.params) : 0;
    for (let n = 1; n <= max; n++) {
      if (!detail.params.has(n)) throw err("E_CONFIG_INVALID", `statement ${index + 1} parameter references must be contiguous`);
    }
    detail.params.forEach((n) => allParams.add(n));

    if (rank[risk] > rank[overall]) overall = risk;
    const location = typeof item.stmt_location === "number" ? item.stmt_location : undefined;
    const length = typeof item.stmt_len === "number" ? item.stmt_len : undefined;
    const nextStatement = stmts[index + 1];
    const nextLocation = typeof nextStatement?.stmt_location === "number" ? nextStatement.stmt_location : undefined;
    const text = sliceSql(sql, location, length, nextLocation);
    statements.push({
      index, tag, risk, tables: [...detail.tables].sort(),
      sqlFingerprint: fingerprint(text), paramCount: max, reasons, sql: text,
    });
  }

  const maxParamRef = allParams.size ? Math.max(...allParams) : 0;
  const accumulatedParamCount = statements.reduce((sum, s) => sum + s.paramCount, 0);
  if (params.length !== accumulatedParamCount) {
    throw err("E_CONFIG_INVALID", "SQL parameters must exactly match references");
  }

  if (statements.some((s) => s.risk === "blocked")) {
    throw err("E_CONFIG_INVALID", "SQL contains blocked statement");
  }

  return {
    riskLevel: overall,
    statements,
    destructiveReasons: statements.filter((statement) => statement.risk === "destructive").flatMap((statement) => statement.reasons),
    maxParamRef,
  };
}

export async function assertPublicQuery(sql: string, params: readonly unknown[] = []): Promise<Classification> {
  const result = await classifySQL(sql, params);
  if (result.statements.length !== 1 || result.riskLevel !== "read") {
    throw err("E_CONFIG_INVALID", "query requires exactly one read statement");
  }
  return result;
}

export async function assertPublicPlan(sql: string, params: readonly unknown[] = []): Promise<Classification> {
  const result = await classifySQL(sql, params);
  if (result.riskLevel === "read") {
    throw err("E_CONFIG_INVALID", "plan requires write or destructive statement");
  }
  return result;
}
