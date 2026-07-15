import { describe, expect, it } from "vitest";
import { createRailwayCliClient, parseUpOutput } from "../../../src/providers/railway/cli.js";

function fakeExec(records: Array<{ code: number; stdout: string; stderr?: string; cwd?: string }>) {
  let index = 0;
  return async (_cmd: string, args?: string[], options?: { cwd?: string; signal?: AbortSignal }) => {
    const rec = records[index++] ?? { code: 1, stdout: "", stderr: "unexpected call" };
    return { code: rec.code, stdout: rec.stdout, stderr: rec.stderr ?? "", killed: false, cancelled: false, truncated: false };
  };
}

describe("createRailwayCliClient", () => {
  it("up arg array contains --json --yes --ci and IDs, no shell", async () => {
    let capturedArgs: string[] | undefined;
    const exec = async (_cmd: string, args?: string[]) => {
      capturedArgs = args;
      return { code: 0, stdout: '{"status":"success","deploymentId":"d1"}\n', stderr: "", killed: false, cancelled: false, truncated: false };
    };
    const client = createRailwayCliClient(exec);
    await client.up("svc-1", "env-1", "proj-1", "/tmp/dir");
    expect(capturedArgs).toContain("--json");
    expect(capturedArgs).toContain("--yes");
    expect(capturedArgs).toContain("--ci");
    expect(capturedArgs).toContain("--service");
    expect(capturedArgs?.indexOf("--service")! + 1).toBe(capturedArgs?.indexOf("svc-1"));
    expect(capturedArgs).not.toContain("sh");
    expect(capturedArgs).not.toContain("-c");
  });

  it("logs caps lines at 500", async () => {
    let capturedArgs: string[] | undefined;
    const exec = async (_cmd: string, args?: string[]) => {
      capturedArgs = args;
      return { code: 0, stdout: '{"timestamp":"t","message":"m"}\n', stderr: "", killed: false, cancelled: false, truncated: false };
    };
    const client = createRailwayCliClient(exec);
    await client.logs("svc-1", "env-1", 1000);
    const idx = capturedArgs?.indexOf("--lines") ?? -1;
    expect(capturedArgs?.[idx + 1]).toBe("500");
  });

  it("parser extracts deploymentId, url, status", () => {
    const out = '{"level":"info","message":"building"}\n{"status":"success","deploymentId":"d1","url":"https://x.railway.app"}';
    const r = parseUpOutput(out);
    expect(r.status).toBe("success");
    expect(r.deploymentId).toBe("d1");
    expect(r.url).toBe("https://x.railway.app");
  });

  it("auth failure maps to E_AUTH_MISSING", async () => {
    const exec = fakeExec([{ code: 1, stdout: "", stderr: "Error: NotAuthenticated" }]);
    const client = createRailwayCliClient(exec);
    await expect(client.up("svc", "env", "proj", "/tmp")).rejects.toMatchObject({ code: "E_AUTH_MISSING" });
  });

  it("empty output maps to E_PROVIDER", async () => {
    const exec = fakeExec([{ code: 0, stdout: "" }]);
    const client = createRailwayCliClient(exec);
    await expect(client.up("svc", "env", "proj", "/tmp")).rejects.toMatchObject({ code: "E_PROVIDER" });
  });
});
