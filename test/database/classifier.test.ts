import { describe, expect, it } from "vitest";
import { assertPublicPlan, assertPublicQuery, classifySQL, nestedStatementRisk, walkAST, type WalkResult } from "../../src/database/classifier.js";

describe("database classifier", () => {
  // ── Empty / comments ──────────────────────────────────────────────
  describe("empty and comment-only input", () => {
    it("rejects empty string", async () => {
      await expect(classifySQL("")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("rejects whitespace-only", async () => {
      await expect(classifySQL("   \n  ")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("rejects SQL comment only", async () => {
      await expect(classifySQL("-- just a comment")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("rejects block comment only", async () => {
      await expect(classifySQL("/* block comment */")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
  });

  // ── >20 statements boundary ───────────────────────────────────────
  it("rejects more than 20 statements", async () => {
    const sql = Array.from({ length: 21 }, (_, i) => `SELECT ${i + 1}`).join("; ");
    await expect(classifySQL(sql)).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("accepts exactly 20 statements", async () => {
    const sql = Array.from({ length: 20 }, (_, i) => `SELECT ${i + 1}`).join("; ");
    await expect(classifySQL(sql)).resolves.toMatchObject({ riskLevel: "read" });
  });

  // ── Syntax error ───────────────────────────────────────────────────
  it("rejects SQL with syntax error", async () => {
    await expect(classifySQL("SEL ECT 1")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  // ── Plain SELECT ──────────────────────────────────────────────────
  describe("SELECT variants", () => {
    it("allows plain SELECT as read", async () => {
      await expect(classifySQL("SELECT 1")).resolves.toMatchObject({ riskLevel: "read" });
    });
    it("allows SELECT with WHERE", async () => {
      await expect(classifySQL("SELECT * FROM users WHERE id = $1", [1])).resolves.toMatchObject({ riskLevel: "read" });
    });
    it("allows SELECT with JOIN", async () => {
      await expect(classifySQL("SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id")).resolves.toMatchObject({ riskLevel: "read" });
    });
    it("allows SELECT with GROUP BY / HAVING", async () => {
      await expect(classifySQL("SELECT department, count(*) FROM employees GROUP BY department HAVING count(*) > 5")).resolves.toMatchObject({ riskLevel: "read" });
    });
  });

  // ── UNION / set operations ────────────────────────────────────────
  describe("set operations", () => {
    it("allows UNION as read", async () => {
      await expect(classifySQL("SELECT 1 UNION SELECT 2")).resolves.toMatchObject({ riskLevel: "read" });
    });
    it("allows INTERSECT as read", async () => {
      await expect(classifySQL("SELECT 1 INTERSECT SELECT 2")).resolves.toMatchObject({ riskLevel: "read" });
    });
    it("allows EXCEPT as read", async () => {
      await expect(classifySQL("SELECT 1 EXCEPT SELECT 2")).resolves.toMatchObject({ riskLevel: "read" });
    });
    it("allows multi-level UNION", async () => {
      await expect(classifySQL("SELECT 1 UNION SELECT 2 UNION SELECT 3")).resolves.toMatchObject({ riskLevel: "read" });
    });
  });

  // ── Subquery ──────────────────────────────────────────────────────
  it("allows SELECT with subquery in WHERE", async () => {
    await expect(classifySQL("SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)")).resolves.toMatchObject({ riskLevel: "read" });
  });
  it("allows SELECT with scalar subquery", async () => {
    await expect(classifySQL("SELECT (SELECT count(*) FROM orders) AS cnt")).resolves.toMatchObject({ riskLevel: "read" });
  });

  // ── SELECT INTO ────────────────────────────────────────────────────
  it("classifies SELECT INTO as write", async () => {
    const result = await classifySQL("SELECT * INTO backup_users FROM users");
    expect(result.riskLevel).toBe("write");
    expect(result.statements[0]?.risk).toBe("write");
  });

  // ── Locking ────────────────────────────────────────────────────────
  it("classifies SELECT FOR UPDATE as write", async () => {
    await expect(classifySQL("SELECT * FROM users FOR UPDATE")).resolves.toMatchObject({ riskLevel: "write" });
  });
  it("classifies SELECT FOR SHARE as write", async () => {
    await expect(classifySQL("SELECT * FROM users FOR SHARE")).resolves.toMatchObject({ riskLevel: "write" });
  });
  it("classifies SELECT FOR NO KEY UPDATE as write", async () => {
    await expect(classifySQL("SELECT * FROM users FOR NO KEY UPDATE")).resolves.toMatchObject({ riskLevel: "write" });
  });
  it("classifies SELECT FOR UPDATE NOWAIT as write", async () => {
    await expect(classifySQL("SELECT * FROM users FOR UPDATE NOWAIT")).resolves.toMatchObject({ riskLevel: "write" });
  });

  // ── INSERT ─────────────────────────────────────────────────────────
  describe("INSERT", () => {
    it("classifies simple INSERT as write", async () => {
      await expect(classifySQL("INSERT INTO users (name) VALUES ($1)", ["alice"])).resolves.toMatchObject({ riskLevel: "write" });
    });
    it("classifies INSERT ... SELECT as write", async () => {
      await expect(classifySQL("INSERT INTO archive SELECT * FROM old_records")).resolves.toMatchObject({ riskLevel: "write" });
    });
    it("classifies INSERT ... ON CONFLICT as write", async () => {
      await expect(classifySQL("INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = $2", [1, "bob"])).resolves.toMatchObject({ riskLevel: "write" });
    });
    it("classifies INSERT ... DEFAULT VALUES as write", async () => {
      await expect(classifySQL("INSERT INTO logs DEFAULT VALUES")).resolves.toMatchObject({ riskLevel: "write" });
    });
  });

  // ── UPDATE ─────────────────────────────────────────────────────────
  describe("UPDATE", () => {
    it("classifies simple UPDATE as write", async () => {
      await expect(classifySQL("UPDATE users SET name = $1 WHERE id = $2", ["alice", 1])).resolves.toMatchObject({ riskLevel: "write" });
    });
    it("classifies UPDATE with FROM as write", async () => {
      await expect(classifySQL("UPDATE users SET name = o.name FROM orders o WHERE users.id = o.user_id")).resolves.toMatchObject({ riskLevel: "write" });
    });
    it("classifies UPDATE RETURNING as write", async () => {
      await expect(classifySQL("UPDATE users SET name = $1 WHERE id = $2 RETURNING id", ["alice", 1])).resolves.toMatchObject({ riskLevel: "write" });
    });
  });

  // ── DELETE ─────────────────────────────────────────────────────────
  describe("DELETE", () => {
    it("classifies plain DELETE as destructive", async () => {
      await expect(classifySQL("DELETE FROM users WHERE id = $1", [1])).resolves.toMatchObject({ riskLevel: "destructive" });
    });
    it("classifies DELETE with USING as destructive", async () => {
      await expect(classifySQL("DELETE FROM users USING orders WHERE users.id = orders.user_id")).resolves.toMatchObject({ riskLevel: "destructive" });
    });
    it("classifies DELETE RETURNING as destructive", async () => {
      await expect(classifySQL("DELETE FROM users WHERE id = $1 RETURNING name", [1])).resolves.toMatchObject({ riskLevel: "destructive" });
    });
    it("classifies TRUNCATE as destructive", async () => {
      await expect(classifySQL("TRUNCATE users")).resolves.toMatchObject({ riskLevel: "destructive" });
    });
    it("classifies TRUNCATE CASCADE as destructive", async () => {
      await expect(classifySQL("TRUNCATE users CASCADE")).resolves.toMatchObject({ riskLevel: "destructive" });
    });
  });

  // ── MERGE ─────────────────────────────────────────────────────────
  it("blocks MERGE", async () => {
    await expect(classifySQL("MERGE INTO target USING source ON target.id = source.id WHEN MATCHED THEN UPDATE SET name = source.name")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  // ── Modifying CTEs ────────────────────────────────────────────────
  describe("modifying CTEs", () => {
    it("classifies DELETE in CTE as destructive", async () => {
      const result = await classifySQL("WITH deleted AS (DELETE FROM users WHERE id = $1 RETURNING *) SELECT * FROM deleted", [1]);
      expect(result.riskLevel).toBe("destructive");
    });
    it("classifies INSERT in CTE as write", async () => {
      const result = await classifySQL("WITH inserted AS (INSERT INTO log VALUES ($1) RETURNING *) SELECT * FROM inserted", ["event"]);
      expect(result.riskLevel).toBe("write");
    });
    it("classifies UPDATE in CTE as write", async () => {
      const result = await classifySQL("WITH updated AS (UPDATE users SET name = $1 WHERE id = $2 RETURNING *) SELECT * FROM updated", ["new", 1]);
      expect(result.riskLevel).toBe("write");
    });
    it("blocks MERGE in CTE", async () => {
      await expect(classifySQL("WITH merged AS (MERGE INTO target USING src ON target.id = src.id WHEN MATCHED THEN UPDATE SET name = src.name) SELECT * FROM merged")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
  });

  it("aggregates hidden DML through arbitrary nested expression wrappers", () => {
    const [risk, reasons] = nestedStatementRisk({
      SelectStmt: {
        whereClause: {
          BoolExpr: {
            args: [{
              CaseExpr: {
                args: [{
                  CaseWhen: { expr: { SubLink: { subselect: { DeleteStmt: {} } } } },
                }],
              },
            }],
          },
        },
      },
    });
    expect(risk).toBe("destructive");
    expect(reasons).toContain("DELETE");
  });

  // ── Functions ──────────────────────────────────────────────────────
  describe("function risk detection", () => {
    it("blocks pg_sleep", async () => {
      await expect(classifySQL("SELECT pg_sleep(1)")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it.each([
      "SELECT pg_catalog.pg_sleep(1)",
      "SELECT pg_catalog.pg_terminate_backend(1)",
      "SELECT pg_catalog.set_config('search_path', 'public', false)",
      "SELECT public.dblink('connstr', 'SELECT 1')",
      "SELECT pg_catalog.pg_read_file('/etc/passwd')",
    ])("blocks schema-qualified dangerous function: %s", async (sql) => {
      await expect(classifySQL(sql)).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks pg_advisory_lock", async () => {
      await expect(classifySQL("SELECT pg_advisory_lock(1)")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks pg_cancel_backend", async () => {
      await expect(classifySQL("SELECT pg_cancel_backend(42)")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks pg_terminate_backend", async () => {
      await expect(classifySQL("SELECT pg_terminate_backend(42)")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks lo_import", async () => {
      await expect(classifySQL("SELECT lo_import('/etc/passwd')")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks dblink", async () => {
      await expect(classifySQL("SELECT dblink('connstr','SELECT 1')")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks pg_read_file", async () => {
      await expect(classifySQL("SELECT pg_read_file('/etc/passwd')")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks set_config", async () => {
      await expect(classifySQL("SELECT set_config('some.setting', 'value', true)")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks pg_reload_conf", async () => {
      await expect(classifySQL("SELECT pg_reload_conf()")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("allows harmless functions like length", async () => {
      await expect(classifySQL("SELECT length($1)", ["hello"])).resolves.toMatchObject({ riskLevel: "read" });
    });
    it("allows count", async () => {
      await expect(classifySQL("SELECT count(*) FROM users")).resolves.toMatchObject({ riskLevel: "read" });
    });
    it("allows now()", async () => {
      await expect(classifySQL("SELECT now()")).resolves.toMatchObject({ riskLevel: "read" });
    });
    it("allows COALESCE", async () => {
      await expect(classifySQL("SELECT COALESCE($1, 'default')", [null])).resolves.toMatchObject({ riskLevel: "read" });
    });
  });

  // ── Allowlisted additive DDL ──────────────────────────────────────
  describe("additive DDL", () => {
    it("allows CREATE TABLE as write", async () => {
      await expect(classifySQL("CREATE TABLE users (id INT PRIMARY KEY)")).resolves.toMatchObject({ riskLevel: "write" });
    });
    it("allows CREATE TABLE AS as write", async () => {
      await expect(classifySQL("CREATE TABLE backup AS SELECT * FROM users")).resolves.toMatchObject({ riskLevel: "write" });
    });
    it("allows CREATE VIEW as write", async () => {
      await expect(classifySQL("CREATE VIEW active_users AS SELECT * FROM users WHERE active = true")).resolves.toMatchObject({ riskLevel: "write" });
    });
    it("allows CREATE INDEX as write", async () => {
      await expect(classifySQL("CREATE INDEX idx_users_name ON users (name)")).resolves.toMatchObject({ riskLevel: "write" });
    });
    it("allows CREATE SCHEMA as write", async () => {
      await expect(classifySQL("CREATE SCHEMA staging")).resolves.toMatchObject({ riskLevel: "write" });
    });
    it("allows CREATE SEQUENCE as write", async () => {
      await expect(classifySQL("CREATE SEQUENCE user_id_seq START 1000")).resolves.toMatchObject({ riskLevel: "write" });
    });
    it("allows CREATE TYPE AS ENUM as write", async () => {
      await expect(classifySQL("CREATE TYPE mood AS ENUM ('happy', 'sad')")).resolves.toMatchObject({ riskLevel: "write" });
    });
    it("allows ALTER TABLE ADD COLUMN as write", async () => {
      await expect(classifySQL("ALTER TABLE users ADD COLUMN age INT")).resolves.toMatchObject({ riskLevel: "write" });
    });
    it("allows ALTER TABLE ADD CONSTRAINT as write", async () => {
      await expect(classifySQL("ALTER TABLE users ADD CONSTRAINT uq_name UNIQUE (name)")).resolves.toMatchObject({ riskLevel: "write" });
    });
    it("allows ALTER TABLE ALTER COLUMN SET DEFAULT as write", async () => {
      await expect(classifySQL("ALTER TABLE users ALTER COLUMN status SET DEFAULT 'active'")).resolves.toMatchObject({ riskLevel: "write" });
    });
    it("allows ALTER TABLE ALTER COLUMN SET NOT NULL as write", async () => {
      await expect(classifySQL("ALTER TABLE users ALTER COLUMN email SET NOT NULL")).resolves.toMatchObject({ riskLevel: "write" });
    });
    it("allows ALTER TABLE ADD INDEX as write", async () => {
      await expect(classifySQL("ALTER TABLE users ADD INDEX idx_name (name)")).resolves.toMatchObject({ riskLevel: "write" });
    });
    it("allows ALTER ENUM ADD VALUE as write", async () => {
      await expect(classifySQL("ALTER TYPE mood ADD VALUE 'ecstatic'")).resolves.toMatchObject({ riskLevel: "write" });
    });
    it("allows COMMENT ON as write", async () => {
      await expect(classifySQL("COMMENT ON TABLE users IS 'user records'")).resolves.toMatchObject({ riskLevel: "write" });
    });
  });

  // ── Destructive DDL ───────────────────────────────────────────────
  describe("destructive DDL", () => {
    it("classifies DROP TABLE as destructive", async () => {
      await expect(classifySQL("DROP TABLE users")).resolves.toMatchObject({ riskLevel: "destructive" });
    });
    it("classifies DROP VIEW as destructive", async () => {
      await expect(classifySQL("DROP VIEW active_users")).resolves.toMatchObject({ riskLevel: "destructive" });
    });
    it("classifies DROP INDEX as destructive", async () => {
      await expect(classifySQL("DROP INDEX idx_users_name")).resolves.toMatchObject({ riskLevel: "destructive" });
    });
    it("classifies TRUNCATE as destructive", async () => {
      await expect(classifySQL("TRUNCATE users")).resolves.toMatchObject({ riskLevel: "destructive" });
    });
    it("classifies ALTER TABLE DROP COLUMN as destructive", async () => {
      await expect(classifySQL("ALTER TABLE users DROP COLUMN age")).resolves.toMatchObject({ riskLevel: "destructive" });
    });
    it("classifies ALTER TABLE DROP CONSTRAINT as destructive", async () => {
      await expect(classifySQL("ALTER TABLE users DROP CONSTRAINT uq_name")).resolves.toMatchObject({ riskLevel: "destructive" });
    });
    it("classifies ALTER TABLE ALTER COLUMN TYPE as destructive", async () => {
      await expect(classifySQL("ALTER TABLE users ALTER COLUMN id TYPE bigint")).resolves.toMatchObject({ riskLevel: "destructive" });
    });
    it("classifies ALTER TABLE ALTER COLUMN DROP NOT NULL as destructive", async () => {
      await expect(classifySQL("ALTER TABLE users ALTER COLUMN email DROP NOT NULL")).resolves.toMatchObject({ riskLevel: "destructive" });
    });
    it("classifies ALTER TABLE DETACH PARTITION as destructive", async () => {
      await expect(classifySQL("ALTER TABLE sales DETACH PARTITION sales_2023")).resolves.toMatchObject({ riskLevel: "destructive" });
    });
    it("classifies ALTER ENUM RENAME VALUE as destructive", async () => {
      await expect(classifySQL("ALTER TYPE mood RENAME VALUE 'happy' TO 'glad'")).resolves.toMatchObject({ riskLevel: "destructive" });
    });
  });

  // ── Hard-blocked statements ───────────────────────────────────────
  describe("hard-blocked statements", () => {
    it("blocks CREATE ROLE", async () => {
      await expect(classifySQL("CREATE ROLE evil_role")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks ALTER ROLE", async () => {
      await expect(classifySQL("ALTER ROLE postgres WITH PASSWORD 'newpass'")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks DROP ROLE", async () => {
      await expect(classifySQL("DROP ROLE evil_role")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks GRANT", async () => {
      await expect(classifySQL("GRANT SELECT ON users TO public")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks GRANT ROLE", async () => {
      await expect(classifySQL("GRANT evil_role TO postgres")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks ALTER DEFAULT PRIVILEGES", async () => {
      await expect(classifySQL("ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO public")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks CREATE EXTENSION", async () => {
      await expect(classifySQL("CREATE EXTENSION pgcrypto")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks ALTER EXTENSION", async () => {
      await expect(classifySQL("ALTER EXTENSION pgcrypto UPDATE TO '1.1'")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks CREATE FOREIGN DATA WRAPPER", async () => {
      await expect(classifySQL("CREATE FOREIGN DATA WRAPPER mywrapper VALIDATOR postgresql_fdw_validator")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks ALTER FOREIGN DATA WRAPPER", async () => {
      await expect(classifySQL("ALTER FOREIGN DATA WRAPPER mywrapper OPTIONS (SET host 'localhost')")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks CREATE FOREIGN SERVER", async () => {
      await expect(classifySQL("CREATE SERVER myserver FOREIGN DATA WRAPPER postgresql_fdw")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks CREATE FUNCTION", async () => {
      await expect(classifySQL("CREATE FUNCTION add(a INT, b INT) RETURNS INT LANGUAGE SQL AS 'SELECT a + b'")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks ALTER FUNCTION", async () => {
      await expect(classifySQL("ALTER FUNCTION add(a INT, b INT) IMMUTABLE")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks CREATE TRIGGER", async () => {
      await expect(classifySQL("CREATE TRIGGER check_update BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION check_update()")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks CREATE EVENT TRIGGER", async () => {
      await expect(classifySQL("CREATE EVENT TRIGGER block_ddl ON ddl_command_start EXECUTE FUNCTION block_func()")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks CREATE POLICY", async () => {
      await expect(classifySQL("CREATE POLICY user_select ON users FOR SELECT USING (true)")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks ALTER POLICY", async () => {
      await expect(classifySQL("ALTER POLICY user_select ON users USING (false)")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks CREATE LANGUAGE", async () => {
      await expect(classifySQL("CREATE LANGUAGE plpythonu")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks COPY", async () => {
      await expect(classifySQL("COPY users TO '/tmp/users.csv' CSV")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks BEGIN / COMMIT / ROLLBACK", async () => {
      await expect(classifySQL("BEGIN")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
      await expect(classifySQL("COMMIT")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
      await expect(classifySQL("ROLLBACK")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks SET statement (session)", async () => {
      await expect(classifySQL("SET statement_timeout = 1000")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks SHOW", async () => {
      await expect(classifySQL("SHOW statement_timeout")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks DISCARD", async () => {
      await expect(classifySQL("DISCARD ALL")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks PREPARE / EXECUTE / DEALLOCATE", async () => {
      await expect(classifySQL("PREPARE myplan AS SELECT 1")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
      await expect(classifySQL("EXECUTE myplan")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
      await expect(classifySQL("DEALLOCATE myplan")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks LISTEN / NOTIFY / UNLISTEN", async () => {
      await expect(classifySQL("LISTEN channel")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
      await expect(classifySQL("NOTIFY channel, 'msg'")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
      await expect(classifySQL("UNLISTEN channel")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks LOCK TABLE", async () => {
      await expect(classifySQL("LOCK TABLE users IN ACCESS EXCLUSIVE MODE")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks EXPLAIN", async () => {
      await expect(classifySQL("EXPLAIN SELECT 1")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks VACUUM", async () => {
      await expect(classifySQL("VACUUM users")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks REINDEX", async () => {
      await expect(classifySQL("REINDEX TABLE users")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks CLUSTER", async () => {
      await expect(classifySQL("CLUSTER users USING idx_users_name")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks CHECKPOINT", async () => {
      await expect(classifySQL("CHECKPOINT")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks CALL", async () => {
      await expect(classifySQL("CALL some_procedure()")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks DO", async () => {
      await expect(classifySQL("DO $$ BEGIN RAISE NOTICE 'hello'; END $$")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("blocks LOAD", async () => {
      await expect(classifySQL("LOAD '/tmp/mylib.so'")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
  });

  // ── Unknown nested AST wrapper ────────────────────────────────────
  describe("unknown nested AST wrapper detection", () => {
    it("rejects statement containing unknown node tag", async () => {
      // If the AST walk encounters a wrapper tag not in the allowlist, reject
      // We use the exported pure-AST analysis seam to directly test this
      const result = walkAST({ SelectStmt: { targetList: [{ ResTarget: { val: { EvilUnknownTag: { malicious: true } }, name: null } }] } } as any);
      expect(result.blocked).toBe(true);
      expect(result.reasons[0]).toMatch(/unknown.*tag/i);
    });
    it("rejects statement with unknown top-level wrapper", async () => {
      const result = walkAST({ MadeUpFakeStmt: { someField: "value" } } as any);
      expect(result.blocked).toBe(true);
      expect(result.reasons[0]).toMatch(/unknown.*tag/i);
    });
  });

  // ── Parameters ────────────────────────────────────────────────────
  describe("parameter validation", () => {
    it("requires contiguous parameters", async () => {
      await expect(classifySQL("SELECT $2", ["x", "y"])).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("requires exact parameter count match", async () => {
      await expect(classifySQL("SELECT $1", ["x", "y"])).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("requires contiguous in second statement", async () => {
      await expect(classifySQL("SELECT $1; SELECT $3", ["a", "b", "c"])).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("rejects non-finite numeric param values in classifySQL interface", async () => {
      await expect(classifySQL("SELECT $1", [NaN])).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
      await expect(classifySQL("SELECT $1", [Infinity])).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("rejects non-scalar param values", async () => {
      await expect(classifySQL("SELECT $1", [{ key: "value" }])).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
      await expect(classifySQL("SELECT $1", [[1, 2, 3]])).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("accepts exact params matching references", async () => {
      const result = await classifySQL("SELECT $1, $2", [true, 42]);
      expect(result.riskLevel).toBe("read");
    });
  });

  // ── UTF-8 statement slicing ──────────────────────────────────────
  it("slices UTF-8 statements correctly", async () => {
    const result = await classifySQL("SELECT 'é' FROM users; SELECT $1", ["x"]);
    expect(result.statements).toHaveLength(2);
    expect(result.statements[0]?.sql).toContain("é");
    expect(result.statements[1]?.sql).toContain("$1");
  });

  // ── Mixed statement risk ──────────────────────────────────────────
  it("escalates overall risk to highest level across statements", async () => {
    const result = await classifySQL("SELECT 1; INSERT INTO log VALUES ($1)", ["test"]);
    expect(result.riskLevel).toBe("write");
  });
  it("rejects plan when any statement is blocked", async () => {
    await expect(classifySQL("SELECT 1; SELECT pg_sleep(1)")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  // ── assertPublicQuery ────────────────────────────────────────────
  describe("assertPublicQuery", () => {
    it("accepts single read statement", async () => {
      await expect(assertPublicQuery("SELECT 1")).resolves.toMatchObject({ riskLevel: "read" });
    });
    it("rejects empty/missing statement", async () => {
      await expect(assertPublicQuery("")).rejects.toThrow();
    });
    it("rejects write as public query", async () => {
      await expect(assertPublicQuery("INSERT INTO users VALUES (1)")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("rejects destructive as public query", async () => {
      await expect(assertPublicQuery("DELETE FROM users")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("rejects multiple statements", async () => {
      await expect(assertPublicQuery("SELECT 1; SELECT 2")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
  });

  // ── assertPublicPlan ─────────────────────────────────────────────
  describe("assertPublicPlan", () => {
    it("rejects read-only plan", async () => {
      await expect(assertPublicPlan("SELECT 1")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("accepts write plan", async () => {
      await expect(assertPublicPlan("INSERT INTO users VALUES ($1)", [1])).resolves.toMatchObject({ riskLevel: "write" });
    });
    it("accepts destructive plan", async () => {
      await expect(assertPublicPlan("DELETE FROM users WHERE id = $1", [1])).resolves.toMatchObject({ riskLevel: "destructive" });
    });
    it("rejects read-only plan", async () => {
      await expect(assertPublicPlan("SELECT 1")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
    it("rejects blocked statement in plan", async () => {
      await expect(assertPublicPlan("DROP ROLE evil_role")).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    });
  });
});
