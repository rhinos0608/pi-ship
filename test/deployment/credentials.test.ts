import { describe, expect, it } from "vitest";
import { loadAppSecrets } from "../../src/deployment/credentials.js";
import { loadRailwayCredentials } from "../../src/providers/railway/credentials.js";
import { loadVercelCredentials } from "../../src/providers/vercel/credentials.js";

describe("provider credentials", () => {
  it("reads only provider names and keeps app secrets separate", () => {
    const reads: string[] = [];
    const source = { get(name: string) { reads.push(name); return ({ RAILWAY_API_TOKEN: "api", RAILWAY_TOKEN: "project", APP_KEY: "value", VERCEL_TOKEN: "other" } as Record<string, string>)[name]; } };
    expect(loadRailwayCredentials(source)).toEqual({ apiToken: "api", projectToken: "project" });
    expect(reads).toEqual(["RAILWAY_API_TOKEN", "RAILWAY_TOKEN"]);
    reads.length = 0;
    expect(loadAppSecrets(source, ["APP_KEY"])).toEqual({ APP_KEY: "value" });
    expect(reads).toEqual(["APP_KEY"]);
  });

  it("isolates Vercel token", () => {
    const reads: string[] = [];
    const source = { get(name: string) { reads.push(name); return "x"; } };
    expect(loadVercelCredentials(source)).toEqual({ apiToken: "x" });
    expect(reads).toEqual(["VERCEL_TOKEN"]);
  });
});
