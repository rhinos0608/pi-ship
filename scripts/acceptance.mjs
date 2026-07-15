import { spawnSync } from "node:child_process";

// Cloud-free end-to-end contracts for both registered providers and shared DB.
const result = spawnSync("npx", [
  "vitest",
  "--run",
  "test/acceptance/railway.e2e.test.ts",
  "test/acceptance/vercel.e2e.test.ts",
  "test/acceptance/database.e2e.test.ts",
], {
  stdio: "inherit",
  env: { ...process.env, RAILWAY_API_TOKEN: "", RAILWAY_TOKEN: "", VERCEL_TOKEN: "" },
});
if (result.status !== 0) process.exit(result.status ?? 1);
console.log("PASS acceptance lifecycles (Railway, Vercel, shared DB)");
