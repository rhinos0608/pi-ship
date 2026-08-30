import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stat, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { ReplayStore, hashJti, replayDir } from "../../src/boundary/replay-store.js";
import { mintSignedCapability, verifySignedCapability, verifySignedCapabilityAsync, clearJtiCacheForTests } from "../../src/boundary/capability.js";
import { EphemeralKeyStore } from "../../src/boundary/key-store.js";
import { BoundaryEnforcer } from "../../src/boundary/enforcement.js";
import { ProtectedResourceRegistry, createDatabaseResource } from "../../src/boundary/resource.js";
import { ApprovalRegistry } from "../../src/core/approval.js";
import { CredentialVault } from "../../src/boundary/vault.js";

function makeSigned(store: EphemeralKeyStore, ttlMs = 5*60*1000) {
  return mintSignedCapability({
    resource: "db", operation: "execute", planId: "p1", planDigest: "x",
    riskLevel: "write", issuer: "pi-ship", audience: "child", projectBinding: "proj-1",
    keyId: store.getPublicKeyId(), ttlMs,
  }, store.getSigner());
}

describe("durable replay", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pi-replay-")); clearJtiCacheForTests(); });
  afterEach(() => { try{ rmSync(dir,{recursive:true,force:true}); }catch{} });

  it("same-process replay rejected (durable via explicit store)", () => {
    const store = new EphemeralKeyStore();
    const s = makeSigned(store);
    const keys = new Map([[store.getPublicKeyId(), store.publicKey]]);
    const rs = new ReplayStore(dir);
    expect(verifySignedCapability(s, keys, "child", rs).valid).toBe(true);
    expect(verifySignedCapability(s, keys, "child", rs).valid).toBe(false);
  });

  it("in-memory only when explicitly null (does not persist to file)", () => {
    const store = new EphemeralKeyStore();
    const s = makeSigned(store);
    const keys = new Map([[store.getPublicKeyId(), store.publicKey]]);
    expect(verifySignedCapability(s, keys, "child", null).valid).toBe(true);
    expect(verifySignedCapability(s, keys, "child", null).valid).toBe(false);
    clearJtiCacheForTests();
    const rs = new ReplayStore(dir);
    expect(verifySignedCapability(s, keys, "child", rs).valid).toBe(true);
  });

  it("reinitialized verifier replay rejected inside TTL (durable)", async () => {
    const ks = new EphemeralKeyStore();
    const s = makeSigned(ks);
    const keys = new Map([[ks.getPublicKeyId(), ks.publicKey]]);
    const rs1 = new ReplayStore(dir);
    expect((await verifySignedCapabilityAsync(s, keys, "child", rs1)).valid).toBe(true);
    clearJtiCacheForTests();
    const rs2 = new ReplayStore(dir);
    expect((await verifySignedCapabilityAsync(s, keys, "child", rs2)).valid).toBe(false);
    expect((await verifySignedCapabilityAsync(s, keys, "child", rs2)).reason).toContain("jti replay");
  });

  it("direct verifier survives new-process (file persists)", () => {
    const ks = new EphemeralKeyStore();
    const s = makeSigned(ks);
    const keys = new Map([[ks.getPublicKeyId(), ks.publicKey]]);
    const rs1 = new ReplayStore(dir);
    expect(verifySignedCapability(s, keys, "child", rs1).valid).toBe(true);
    clearJtiCacheForTests();
    const rs2 = new ReplayStore(dir);
    expect(verifySignedCapability(s, keys, "child", rs2).valid).toBe(false);
  });

  it("concurrent double-consume permits exactly one (in-process)", async () => {
    const ks = new EphemeralKeyStore();
    const s = makeSigned(ks);
    const keys = new Map([[ks.getPublicKeyId(), ks.publicKey]]);
    const rs = new ReplayStore(dir);
    const results = await Promise.all([
      verifySignedCapabilityAsync(s, keys, "child", rs),
      verifySignedCapabilityAsync(s, keys, "child", rs),
    ]);
    const validCount = results.filter(r=>r.valid).length;
    expect(validCount).toBe(1);
  });

  it("two-process race exactly one succeeds (true overlap via spawn + barrier)", async () => {
    const ks = new EphemeralKeyStore();
    const signed = makeSigned(ks);
    const hash = hashJti(signed.jti);
    const expiry = new Date(signed.expiresAt).getTime();
    const bucket = String(expiry);
    const claimFile = join(replayDir(dir), bucket, hash);
    const barrier = join(dir, "barrier");
    writeFileSync(barrier, "wait");
    const workerCode = `
      import { ReplayStore } from "/Users/rhinesharar/pi-ship/src/boundary/replay-store.ts";
      import { readFileSync } from "node:fs";
      const dir = ${JSON.stringify(dir)};
      const jti = ${JSON.stringify(signed.jti)};
      const expiry = ${expiry};
      const barrier = ${JSON.stringify(barrier)};
      // barrier spin
      while (true) {
        try { readFileSync(barrier); await new Promise(r=>setTimeout(r, 5)); } catch { break; }
      }
      const rs = new ReplayStore(dir);
      try {
        const ok = rs.consumeSync(jti, expiry);
        process.stdout.write(ok ? "ok" : "replay");
      } catch (e) {
        process.stdout.write("error:" + (e instanceof Error ? e.message : String(e)));
      }
    `;
    const workerPath = join(dir, "worker.mjs");
    writeFileSync(workerPath, workerCode);
    const spawnWorker = () => new Promise<string>((resolve, reject) => {
      const p = spawn("npx", ["tsx", workerPath], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", d => out += d.toString());
      p.on("error", reject);
      p.on("close", () => resolve(out.trim()));
    });
    const p1 = spawnWorker();
    const p2 = spawnWorker();
    // release barrier
    await new Promise(r => setTimeout(r, 20));
    rmSync(barrier, { force: true });
    const [r1, r2] = await Promise.all([p1, p2]);
    const sorted = [r1, r2].sort();
    expect(sorted).toEqual(["ok", "replay"]);
    // verify file exists and is in bucket
    expect(existsSync(claimFile)).toBe(true);
  });

  it("cleanup race cannot permit second claim (pause between O_EXCL and write)", async () => {
    const ks = new EphemeralKeyStore();
    const signed = makeSigned(ks);
    const hash = hashJti(signed.jti);
    const expiry = new Date(signed.expiresAt).getTime();
    const bucket = String(expiry);
    const claimFile = join(replayDir(dir), bucket, hash);
    // Simulate paused claimant: create file via O_EXCL but not yet written (empty), then concurrent cleanup should not delete it
    // Our bucket prune only deletes wholly expired buckets, so live bucket not pruned. But test empty file not parsed as 0.
    // Create empty file manually
    const { mkdirSync, openSync, closeSync } = await import("node:fs");
    const { join: join2 } = await import("node:path");
    const bucketDir = join(replayDir(dir), bucket);
    mkdirSync(bucketDir, { recursive: true, mode: 0o700 });
    const fd = openSync(claimFile, "wx", 0o600);
    // leave empty, not yet written - simulate pause
    // Concurrent prune attempt (should not delete live bucket)
    const rs = new ReplayStore(dir);
    // trigger prune via another consume with different hash
    const other = makeSigned(ks);
    const otherHash = hashJti(other.jti);
    const otherExpiry = new Date(other.expiresAt).getTime();
    // This will call pruneExpiredBucketsSync internally, should not delete our empty live file's bucket because bucket == expiry > now
    try { rs.consumeSync(other.jti, otherExpiry); } catch {}
    // Verify empty file still exists and not deleted as expired 0
    expect(existsSync(claimFile)).toBe(true);
    // Now complete first claimant write (simulate)
    const { writeFileSync, fsyncSync } = await import("node:fs");
    writeFileSync(fd, String(expiry));
    fsyncSync(fd);
    closeSync(fd);
    // Second attempt with same JTI should be replay, not allowed
    const rs2 = new ReplayStore(dir);
    expect(rs2.consumeSync(signed.jti, expiry)).toBe(false);
    // Also verify empty was never parsed as 0 and deleted
    expect(existsSync(claimFile)).toBe(true);
  });

  it("production vault signed first read succeeds second denied", () => {
    const registry = new ProtectedResourceRegistry();
    registry.register(createDatabaseResource());
    const approval = new ApprovalRegistry();
    approval.approve("p1", "x", dir, { domain: "database", risk: "write" });
    const keyStore = new EphemeralKeyStore();
    const replayStore = new ReplayStore(dir);
    const trusted = new Map([[keyStore.getPublicKeyId(), keyStore.publicKey]]);
    const enforcer = new BoundaryEnforcer("exclusive", registry, true, approval, dir, trusted, "child", replayStore);
    const source = { get: (n: string) => n === "DATABASE_URL" ? "postgres://secret" : undefined };
    const vault = new CredentialVault(source, registry, "exclusive", approval, dir, keyStore, enforcer);
    const signed = mintSignedCapability({
      resource: "production-database", operation: "execute", planId: "p1", planDigest: "x",
      riskLevel: "write", issuer: "pi-ship", audience: "child", projectBinding: dir,
      keyId: keyStore.getPublicKeyId(), ttlMs: 60000
    }, keyStore.getSigner());
    const first = vault.get("DATABASE_URL", signed, "execute", "write");
    expect(first).toBe("postgres://secret");
    const second = vault.get("DATABASE_URL", signed, "execute", "write");
    expect(second).toBeUndefined();
    const claimFile = join(replayDir(dir), String(new Date(signed.expiresAt).getTime()), hashJti(signed.jti));
    expect(existsSync(claimFile)).toBe(true);
    const content = readFileSync(claimFile, "utf8");
    expect(content).not.toContain(signed.jti);
    expect(content.trim()).toBe(String(new Date(signed.expiresAt).getTime()));
  });

  it("vault missing/mismatched operation/risk/project/issuer denies without consuming", () => {
    const registry = new ProtectedResourceRegistry();
    registry.register(createDatabaseResource());
    const approval = new ApprovalRegistry();
    approval.approve("p1", "x", dir, { domain: "database", risk: "write" });
    const keyStore = new EphemeralKeyStore();
    const replayStore = new ReplayStore(dir);
    const trusted = new Map([[keyStore.getPublicKeyId(), keyStore.publicKey]]);
    const enforcer = new BoundaryEnforcer("exclusive", registry, true, approval, dir, trusted, "child", replayStore);
    const source = { get: (n: string) => n === "DATABASE_URL" ? "postgres://secret" : undefined };
    const vault = new CredentialVault(source, registry, "exclusive", approval, dir, keyStore, enforcer);
    const signed = mintSignedCapability({
      resource: "production-database", operation: "execute", planId: "p1", planDigest: "x",
      riskLevel: "write", issuer: "pi-ship", audience: "child", projectBinding: dir,
      keyId: keyStore.getPublicKeyId(), ttlMs: 60000
    }, keyStore.getSigner());
    // missing operation
    expect(vault.get("DATABASE_URL", signed, undefined, "write")).toBeUndefined();
    // mismatched operation
    expect(vault.get("DATABASE_URL", signed, "read" as const, "write")).toBeUndefined();
    // mismatched risk
    expect(vault.get("DATABASE_URL", signed, "execute", "destructive" as const)).toBeUndefined();
    // correct should still succeed (not burned)
    expect(vault.get("DATABASE_URL", signed, "execute", "write")).toBe("postgres://secret");
    // replay should now be denied
    expect(vault.get("DATABASE_URL", signed, "execute", "write")).toBeUndefined();
  });

  it("context mismatch does not burn JTI", () => {
    const ks = new EphemeralKeyStore();
    const signed = mintSignedCapability({
      resource: "production-database", operation: "execute", planId: "p1", planDigest: "x",
      riskLevel: "write", issuer: "pi-ship", audience: "child", projectBinding: dir,
      keyId: ks.getPublicKeyId(), ttlMs: 60000
    }, ks.getSigner());
    const keys = new Map([[ks.getPublicKeyId(), ks.publicKey]]);
    const approval = new ApprovalRegistry();
    approval.approve("p1", "x", dir, { domain: "database", risk: "write" });
    const registry = new ProtectedResourceRegistry();
    registry.register(createDatabaseResource());
    const replayStore = new ReplayStore(dir);
    const enforcer = new BoundaryEnforcer("exclusive", registry, true, approval, dir, keys, "child", replayStore);
    const bad = enforcer.checkCredentialAccess({ credentialName: "DATABASE_URL", caller: "test", capability: signed, expectedResource: "other", expectedOperation: "execute", expectedRisk: "write", expectedProjectBinding: dir, expectedIssuer: "pi-ship" });
    expect(bad.allowed).toBe(false);
    expect(bad.reason).toContain("resource");
    const good = enforcer.checkCredentialAccess({ credentialName: "DATABASE_URL", caller: "test", capability: signed, expectedResource: "production-database", expectedOperation: "execute", expectedRisk: "write", expectedProjectBinding: dir, expectedIssuer: "pi-ship" });
    expect(good.allowed).toBe(true);
    const replay = enforcer.checkCredentialAccess({ credentialName: "DATABASE_URL", caller: "test", capability: signed, expectedResource: "production-database", expectedOperation: "execute", expectedRisk: "write", expectedProjectBinding: dir, expectedIssuer: "pi-ship" });
    expect(replay.allowed).toBe(false);
  });

  it("unapproved cap does not burn JTI", () => {
    const ks = new EphemeralKeyStore();
    const signed = mintSignedCapability({
      resource: "db", operation: "execute", planId: "p-unapproved", planDigest: "x",
      riskLevel: "write", issuer: "pi-ship", audience: "child", projectBinding: dir,
      keyId: ks.getPublicKeyId(), ttlMs: 60000
    }, ks.getSigner());
    const keys = new Map([[ks.getPublicKeyId(), ks.publicKey]]);
    const approval = new ApprovalRegistry();
    const registry = new ProtectedResourceRegistry();
    registry.register(createDatabaseResource());
    const replayStore = new ReplayStore(dir);
    const enforcer = new BoundaryEnforcer("exclusive", registry, true, approval, dir, keys, "child", replayStore);
    const first = enforcer.checkCredentialAccess({ credentialName: "DATABASE_URL", caller: "test", capability: signed });
    expect(first.allowed).toBe(false);
    expect(first.reason).toContain("approved");
    approval.approve("p-unapproved", "x", dir, { domain: "database", risk: "write" });
    const second = enforcer.checkCredentialAccess({ credentialName: "DATABASE_URL", caller: "test", capability: signed });
    expect(second.allowed).toBe(true);
  });

  it("storage failure fails closed", async () => {
    const ks = new EphemeralKeyStore();
    const s = makeSigned(ks);
    const keys = new Map([[ks.getPublicKeyId(), ks.publicKey]]);
    const rs = new ReplayStore(dir, { _forceError: true });
    const res = await verifySignedCapabilityAsync(s, keys, "child", rs);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("replay store unavailable");
  });

  it("fsync failure fails closed and leaves claim consumed when possible", () => {
    const ks = new EphemeralKeyStore();
    const s = makeSigned(ks);
    const keys = new Map([[ks.getPublicKeyId(), ks.publicKey]]);
    const rs = new ReplayStore(dir, { _forceFsyncError: true });
    const res = verifySignedCapability(s, keys, "child", rs);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("replay store unavailable");
    const rs2 = new ReplayStore(dir);
    const res2 = verifySignedCapability(s, keys, "child", rs2);
    expect(res2.valid).toBe(false);
  });

  it("expiry behavior: after TTL expired entry not replay but expired", async () => {
    const ks = new EphemeralKeyStore();
    const s = mintSignedCapability({
      resource: "db", operation: "execute", planId: "p1", planDigest: "x",
      riskLevel: "write", issuer: "pi-ship", audience: "child", projectBinding: dir,
      keyId: ks.getPublicKeyId(), ttlMs: 50,
    }, ks.getSigner());
    const keys = new Map([[ks.getPublicKeyId(), ks.publicKey]]);
    const rs = new ReplayStore(dir);
    expect((await verifySignedCapabilityAsync(s, keys, "child", rs)).valid).toBe(true);
    await new Promise(r=>setTimeout(r, 60));
    expect((await verifySignedCapabilityAsync(s, keys, "child", new ReplayStore(dir))).valid).toBe(false);
    // expired bucket should be pruned on next successful consume, but live bucket remains
    const s2 = makeSigned(ks);
    expect((await verifySignedCapabilityAsync(s2, keys, "child", new ReplayStore(dir))).valid).toBe(true);
    const claimFile = join(replayDir(dir), String(new Date(s.expiresAt).getTime()), hashJti(s.jti));
    // expired file's bucket may be pruned, but if prune runs, file gone
    // we check that prune does not delete live
    expect(existsSync(join(replayDir(dir), String(new Date(s2.expiresAt).getTime()), hashJti(s2.jti)))).toBe(true);
  });

  it("hash stored not raw jti, no PII leak", async () => {
    const ks = new EphemeralKeyStore();
    const s = makeSigned(ks);
    const keys = new Map([[ks.getPublicKeyId(), ks.publicKey]]);
    const rs = new ReplayStore(dir);
    await verifySignedCapabilityAsync(s, keys, "child", rs);
    const claimFile = join(replayDir(dir), String(new Date(s.expiresAt).getTime()), hashJti(s.jti));
    const raw = readFileSync(claimFile, "utf8");
    expect(raw).not.toContain(s.jti);
    expect(existsSync(claimFile)).toBe(true);
  });

  it("permissions 0600/0700", async () => {
    const ks = new EphemeralKeyStore();
    const s = makeSigned(ks);
    const keys = new Map([[ks.getPublicKeyId(), ks.publicKey]]);
    await verifySignedCapabilityAsync(s, keys, "child", new ReplayStore(dir));
    const stDir = await stat(replayDir(dir));
    expect(stDir.mode & 0o777).toBe(0o700);
    const stFile = await stat(join(replayDir(dir), String(new Date(s.expiresAt).getTime()), hashJti(s.jti)));
    expect(stFile.mode & 0o777).toBe(0o600);
  });

  it("expired cleanup prunes only expired valid records", async () => {
    const ks = new EphemeralKeyStore();
    const s1 = mintSignedCapability({
      resource: "db", operation: "execute", planId: "p1", planDigest: "x",
      riskLevel: "write", issuer: "pi-ship", audience: "child", projectBinding: dir,
      keyId: ks.getPublicKeyId(), ttlMs: 50,
    }, ks.getSigner());
    const s2 = makeSigned(ks);
    const keys = new Map([[ks.getPublicKeyId(), ks.publicKey]]);
    const rs = new ReplayStore(dir);
    await verifySignedCapabilityAsync(s1, keys, "child", rs);
    await verifySignedCapabilityAsync(s2, keys, "child", rs);
    await new Promise(r=>setTimeout(r, 60));
    const s3 = makeSigned(ks);
    await verifySignedCapabilityAsync(s3, keys, "child", rs);
    expect(existsSync(join(replayDir(dir), String(new Date(s1.expiresAt).getTime()), hashJti(s1.jti)))).toBe(false);
    expect(existsSync(join(replayDir(dir), String(new Date(s2.expiresAt).getTime()), hashJti(s2.jti)))).toBe(true);
  });

  it("empty/invalid claim never parsed as 0", async () => {
    const rs = new ReplayStore(dir);
    const fakeHash = "b".repeat(64);
    const futureExpiry = Date.now() + 60000;
    const bucket = String(futureExpiry);
    const claimPath = join(replayDir(dir), bucket, fakeHash);
    const fsSync = await import("node:fs");
    fsSync.mkdirSync(join(replayDir(dir), bucket), { recursive: true, mode: 0o700 });
    const fd = fsSync.openSync(claimPath, "wx", 0o600);
    fsSync.closeSync(fd);
    // Now attempt to consume with same hash but different expiry - should be replay, not delete empty
    // Need to use hash directly to match fakeHash
    expect(rs.consumeHashSync(fakeHash, futureExpiry)).toBe(false);
    expect(existsSync(claimPath)).toBe(true);
  });
});
