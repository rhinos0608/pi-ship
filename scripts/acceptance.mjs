import { spawnSync } from "node:child_process";

// Cloud-free end-to-end contract: exported plan/apply runtime with FakeProvider.
const result = spawnSync("npx", ["vitest", "--run", "test/acceptance.e2e.test.ts"], {
  stdio: "inherit",
  env: { ...process.env, RAILWAY_API_TOKEN: "", RAILWAY_TOKEN: "" },
});
if (result.status !== 0) process.exit(result.status ?? 1);
console.log("PASS cloud-free FakeProvider acceptance lifecycle");
