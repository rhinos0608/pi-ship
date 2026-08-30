import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync, readdirSync, openSync, closeSync, fsyncSync, chmodSync, rmSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

export function hashJti(jti: string): string {
  return createHash("sha256").update(jti, "utf8").digest("hex");
}

export function replayDir(cwd: string): string {
  return join(cwd, ".pi-ship", "boundary", "replay");
}

// legacy journal-file contract - kept for compatibility, new code uses replayDir
export function replayPath(cwd: string): string {
  return join(cwd, ".pi-ship", "boundary", "replay.jsonl");
}

function bucketForExpiry(expiresAtMs: number): string {
  // ponytail: expiry-bucket namespace avoids same-path TOCTOU; prune only wholly expired buckets. Append-only without prune would also be safe but grows ~32B/hash + 13B/expiry per claim; GC via bucket prune keeps disk ceiling bounded (~TTL/bucket * claims).
  return String(expiresAtMs);
}

function claimPath(cwd: string, expiresAtMs: number, hash: string): string {
  return join(replayDir(cwd), bucketForExpiry(expiresAtMs), hash);
}

export interface ReplayStoreOptions {
  cwd?: string;
  _forceError?: boolean;
  _forceFsyncError?: boolean;
}

export class ReplayStore {
  readonly cwd: string;
  private _forceError = false;
  private _forceFsyncError = false;

  constructor(cwd: string = process.cwd(), opts?: ReplayStoreOptions) {
    this.cwd = cwd;
    if (opts?._forceError) this._forceError = true;
    if (opts?._forceFsyncError) this._forceFsyncError = true;
  }

  setForceError(v: boolean) { this._forceError = v; }
  setForceFsyncError(v: boolean) { this._forceFsyncError = v; }

  private ensureDirSync(bucket: string): void {
    const dir = join(replayDir(this.cwd), bucket);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
      // also ensure parent replayDir is 0700
      chmodSync(replayDir(this.cwd), 0o700);
    } catch (e) {
      throw e;
    }
  }

  private fsyncDirSync(dir: string): void {
    if (this._forceFsyncError) throw new Error("forced fsync failure");
    try {
      const fd = openSync(dir, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      throw e;
    }
  }

  private pruneExpiredBucketsSync(): void {
    const base = replayDir(this.cwd);
    let buckets: string[] = [];
    try {
      buckets = readdirSync(base);
    } catch {
      return;
    }
    const now = Date.now();
    for (const b of buckets) {
      // bucket name is expiry ms as string - must be finite integer
      if (!/^\d+$/.test(b)) continue;
      const bucketExpiry = Number(b);
      if (!Number.isFinite(bucketExpiry)) continue;
      if (bucketExpiry >= now) continue; // not wholly expired
      const bucketPath = join(base, b);
      try {
        // verify bucket contains only valid hash files before deleting? For safety, we check each file is either valid hash and expired (which it is, since bucket < now all files expiry == bucket < now)
        // But to be safe, we just remove the whole bucket directory recursively if it contains only 64-hex files. If unexpected files, skip.
        const entries = readdirSync(bucketPath);
        let safeToPrune = true;
        for (const e of entries) {
          if (!/^[a-f0-9]{64}$/.test(e)) { safeToPrune = false; break; }
        }
        if (!safeToPrune) continue;
        rmSync(bucketPath, { recursive: true, force: true });
        this.fsyncDirSync(base);
      } catch {}
    }
  }

  consumeSync(jti: string, expiresAtMs: number): boolean {
    if (this._forceError) throw new Error("forced storage failure");
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new Error("invalid or already-expired expiresAt");
    }
    const hash = hashJti(jti);
    return this.consumeHashSync(hash, expiresAtMs);
  }

  consumeHashSync(hash: string, expiresAtMs: number): boolean {
    if (this._forceError) throw new Error("forced storage failure");
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new Error("invalid or already-expired expiresAt");
    }
    const bucket = bucketForExpiry(expiresAtMs);
    this.ensureDirSync(bucket);
    const path = claimPath(this.cwd, expiresAtMs, hash);
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        // live claim pathname exists -> replay, never delete/reuse
        return false;
      }
      throw e;
    }
    try {
      writeFileSync(fd, String(expiresAtMs), { encoding: "utf8" });
      if (this._forceFsyncError) throw new Error("forced fsync failure");
      fsyncSync(fd);
    } catch (e) {
      try { closeSync(fd); } catch {}
      // leave claim file (may be empty/invalid) - never parse as 0, treat as consumed. Do not unlink.
      throw e;
    }
    try { closeSync(fd); } catch {}
    try {
      chmodSync(path, 0o600);
    } catch (e) {
      throw e;
    }
    try {
      this.fsyncDirSync(join(replayDir(this.cwd), bucket));
      this.fsyncDirSync(replayDir(this.cwd));
    } catch (e) {
      throw e;
    }
    // opportunistic prune only wholly expired buckets, never live claim pathname
    try { this.pruneExpiredBucketsSync(); } catch {}
    return true;
  }

  async consume(jti: string, expiresAtMs: number): Promise<boolean> {
    return this.consumeSync(jti, expiresAtMs);
  }

  async consumeHash(hash: string, expiresAtMs: number): Promise<boolean> {
    return this.consumeHashSync(hash, expiresAtMs);
  }
}

// test helper - previously used for queue, now no-op
export function _clearQueueForTests() {}
