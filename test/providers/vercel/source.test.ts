import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  enumerateSource,
  uploadSourceFiles,
  verifySourceFreshness,
  type SourceFile,
  type SourceSnapshot,
  type SourceUploader,
} from "../../../src/providers/vercel/source.js";

const execFileAsync = promisify(execFile);

function sha1Hex(data: string | Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// enumerateSource – validation & enumeration
// ---------------------------------------------------------------------------

describe("enumerateSource", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-ship-vsrc-"));
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.email", "t@t.local"], { cwd });
    await execFileAsync("git", ["config", "user.name", "T"], { cwd });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function initCommit(...files: string[]): Promise<void> {
    if (files.length === 0) {
      await execFileAsync("git", ["commit", "--allow-empty", "-m", "init"], { cwd });
      return;
    }
    for (const f of files) {
      const fp = join(cwd, f);
      await mkdir(dirname(fp), { recursive: true });
      await writeFile(fp, f);
    }
    await execFileAsync("git", ["add", "."], { cwd });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd });
  }

  async function writeUntracked(...files: string[]): Promise<void> {
    for (const f of files) {
      const fp = join(cwd, f);
      await mkdir(dirname(fp), { recursive: true });
      await writeFile(fp, f);
    }
  }

  // --- rootDirectory string validation ---
  it("rejects absolute rootDirectory", async () => {
    await expect(
      enumerateSource(cwd, "/etc", { maxFiles: 10, maxFileSize: 1000, maxTotalBytes: 10000 }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rejects rootDirectory with backslash", async () => {
    await expect(
      enumerateSource(cwd, "app\\src", { maxFiles: 10, maxFileSize: 1000, maxTotalBytes: 10000 }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rejects rootDirectory with double separator", async () => {
    await expect(
      enumerateSource(cwd, "app//src", { maxFiles: 10, maxFileSize: 1000, maxTotalBytes: 10000 }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rejects empty rootDirectory", async () => {
    await expect(
      enumerateSource(cwd, "", { maxFiles: 10, maxFileSize: 1000, maxTotalBytes: 10000 }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  // --- containment via path.relative, not startsWith ---
  it("rejects sibling-prefix root escape", async () => {
    // cwd is /tmp/pi-ship-vsrc-xxx
    // Create a sibling dir that has cwd as a prefix
    const sibling = cwd + "2";
    await mkdir(sibling, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: sibling });
    // rootDirectory relative to cwd that resolves into sibling
    await expect(
      enumerateSource(cwd, `../${cwd.slice(cwd.lastIndexOf("/") + 1)}2`, {
        maxFiles: 10,
        maxFileSize: 1000,
        maxTotalBytes: 10000,
      }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rejects rootDirectory when path.relative indicates escape", async () => {
    // `..` root should be rejected
    await expect(
      enumerateSource(cwd, "..", { maxFiles: 10, maxFileSize: 1000, maxTotalBytes: 10000 }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  // --- tracked and untracked files ---
  it("includes tracked and untracked files, excludes ignored", async () => {
    await initCommit("index.js", "lib/core.js");
    await writeUntracked("untracked.txt");
    await writeFile(join(cwd, ".gitignore"), "*.log\n");
    await execFileAsync("git", ["add", ".gitignore"], { cwd });
    await execFileAsync("git", ["commit", "-m", "gitignore"], { cwd });
    await writeFile(join(cwd, "ignored.log"), "should be ignored");

    const snap = await enumerateSource(cwd, ".", {
      maxFiles: 100,
      maxFileSize: 1_000_000,
      maxTotalBytes: 10_000_000,
    });
    expect(snap.fileCount).toBe(4);
    const paths = snap.files.map((f) => f.path).sort();
    expect(paths).toEqual([".gitignore", "index.js", "lib/core.js", "untracked.txt"]);
  });

  // --- rootDirectory ---
  it("respects rootDirectory and returns relative POSIX paths", async () => {
    await mkdir(join(cwd, "app"), { recursive: true });
    await writeFile(join(cwd, "app", "index.js"), "content");
    await writeFile(join(cwd, "app", "util.js"), "util");
    await execFileAsync("git", ["add", "."], { cwd });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd });

    const snap = await enumerateSource(cwd, "app", {
      maxFiles: 100,
      maxFileSize: 1_000_000,
      maxTotalBytes: 10_000_000,
    });
    expect(snap.rootDirectory).toBe("app");
    expect(snap.files.length).toBeGreaterThan(0);
    for (const f of snap.files) {
      expect(f.path).not.toContain("\\");
      expect(f.path).not.toMatch(/^app\//);
      expect(f.path).not.toMatch(/^\.\./);
    }
    const paths = snap.files.map((f) => f.path).sort();
    expect(paths).toEqual(["index.js", "util.js"]);
  });

  // --- deterministic sort and fingerprint ---
  it("returns stable bytewise-sorted paths and deterministic fingerprint", async () => {
    await initCommit("b.js", "a.js", "c.js");
    const snap1 = await enumerateSource(cwd, ".", {
      maxFiles: 100,
      maxFileSize: 1_000_000,
      maxTotalBytes: 10_000_000,
    });
    const snap2 = await enumerateSource(cwd, ".", {
      maxFiles: 100,
      maxFileSize: 1_000_000,
      maxTotalBytes: 10_000_000,
    });
    expect(snap1.files.map((f) => f.path)).toEqual(["a.js", "b.js", "c.js"]);
    expect(snap1.fingerprint).toBe(snap2.fingerprint);
  });

  // --- rejects .env ---
  it("rejects .env and .env.* files anywhere", async () => {
    await initCommit("index.js");
    await writeUntracked(".env");
    await expect(
      enumerateSource(cwd, ".", {
        maxFiles: 100,
        maxFileSize: 1_000_000,
        maxTotalBytes: 10_000_000,
      }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });

    await rm(cwd, { recursive: true, force: true });
    cwd = await mkdtemp(join(tmpdir(), "pi-ship-vsrc-"));
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.email", "t@t.local"], { cwd });
    await execFileAsync("git", ["config", "user.name", "T"], { cwd });
    await initCommit("index.js");
    await writeUntracked("config/.env.local");
    await expect(
      enumerateSource(cwd, ".", {
        maxFiles: 100,
        maxFileSize: 1_000_000,
        maxTotalBytes: 10_000_000,
      }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  // --- rejects symlinks ---
  it("rejects symlinks", async () => {
    await initCommit("real.js");
    await symlink("real.js", join(cwd, "link.js"));
    await expect(
      enumerateSource(cwd, ".", {
        maxFiles: 100,
        maxFileSize: 1_000_000,
        maxTotalBytes: 10_000_000,
      }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  // --- rejects path escape ---
  it("rejects path escape with ..", async () => {
    await initCommit("index.js");
    await expect(
      enumerateSource(cwd, "../outside", {
        maxFiles: 100,
        maxFileSize: 1_000_000,
        maxTotalBytes: 10_000_000,
      }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  // --- rejects empty source ---
  it("rejects empty source (no files)", async () => {
    await initCommit();
    await expect(
      enumerateSource(cwd, ".", {
        maxFiles: 100,
        maxFileSize: 1_000_000,
        maxTotalBytes: 10_000_000,
      }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  // --- rejects .git / .pi-ship paths ---
  it("rejects .git and .pi-ship paths", async () => {
    await initCommit("index.js");
    await mkdir(join(cwd, ".pi-ship"), { recursive: true });
    await writeFile(join(cwd, ".pi-ship", "state.json"), "{}");
    await expect(
      enumerateSource(cwd, ".", {
        maxFiles: 100,
        maxFileSize: 1_000_000,
        maxTotalBytes: 10_000_000,
      }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  // --- limits via injectable options ---
  it("respects injectable maxFiles limit", async () => {
    await initCommit("a.js", "b.js", "c.js");
    await expect(
      enumerateSource(cwd, ".", { maxFiles: 2, maxFileSize: 1_000_000, maxTotalBytes: 10_000_000 }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("respects injectable maxFileSize limit", async () => {
    await initCommit("big.js");
    await writeFile(join(cwd, "big.js"), "x".repeat(100));
    await execFileAsync("git", ["add", "."], { cwd });
    await execFileAsync("git", ["commit", "-m", "big"], { cwd });
    await expect(
      enumerateSource(cwd, ".", { maxFiles: 100, maxFileSize: 50, maxTotalBytes: 10_000_000 }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("respects injectable maxTotalBytes limit", async () => {
    await initCommit("a.js", "b.js");
    await writeFile(join(cwd, "a.js"), "x".repeat(200));
    await writeFile(join(cwd, "b.js"), "y".repeat(200));
    await execFileAsync("git", ["add", "."], { cwd });
    await execFileAsync("git", ["commit", "-m", "big2"], { cwd });
    await expect(
      enumerateSource(cwd, ".", { maxFiles: 100, maxFileSize: 1_000_000, maxTotalBytes: 300 }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  // --- invalid limit values ---
  it("rejects non-positive limit values", async () => {
    await initCommit("a.js");
    await expect(
      enumerateSource(cwd, ".", { maxFiles: 0, maxFileSize: 1000, maxTotalBytes: 10000 }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    await expect(
      enumerateSource(cwd, ".", { maxFiles: -1, maxFileSize: 1000, maxTotalBytes: 10000 }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    await expect(
      enumerateSource(cwd, ".", { maxFiles: 10, maxFileSize: 0, maxTotalBytes: 10000 }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    await expect(
      enumerateSource(cwd, ".", { maxFiles: 10, maxFileSize: 1000, maxTotalBytes: 0 }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rejects non-integer limit values", async () => {
    await initCommit("a.js");
    await expect(
      enumerateSource(cwd, ".", { maxFiles: 1.5, maxFileSize: 1000, maxTotalBytes: 10000 }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    await expect(
      enumerateSource(cwd, ".", { maxFiles: 10, maxFileSize: Infinity, maxTotalBytes: 10000 }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });
});

// ---------------------------------------------------------------------------
// uploadSourceFiles
// ---------------------------------------------------------------------------

describe("uploadSourceFiles", () => {
  let cwd: string;
  let uploads: Map<string, Buffer>;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-ship-vup-"));
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.email", "t@t.local"], { cwd });
    await execFileAsync("git", ["config", "user.name", "T"], { cwd });
    uploads = new Map();
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function makeUploader(delay = 0): SourceUploader {
    return {
      async uploadFile(sha1: string, content: Uint8Array) {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        uploads.set(sha1, Buffer.from(content));
      },
    };
  }

  function fileFromContent(relPath: string, content: string): SourceFile {
    return { path: relPath, sha1: sha1Hex(content), size: Buffer.byteLength(content) };
  }

  // --- basic upload success ---
  it("uploads files via uploader interface", async () => {
    const data = "hello";
    const f = fileFromContent("a.js", data);
    await writeFile(join(cwd, "a.js"), data);
    await uploadSourceFiles([f], cwd, ".", makeUploader(), { concurrency: 1 });
    expect(uploads.size).toBe(1);
    expect(uploads.has(f.sha1)).toBe(true);
  });

  // --- SHA mismatch ---
  it("throws if file content SHA does not match planned SHA", async () => {
    const f = fileFromContent("a.js", "original");
    await writeFile(join(cwd, "a.js"), "modified");
    await expect(
      uploadSourceFiles([f], cwd, ".", makeUploader(), { concurrency: 1 }),
    ).rejects.toMatchObject({ code: "E_PLAN_STALE" });
  });

  // --- size mismatch ---
  it("throws if file size does not match planned size", async () => {
    const f = fileFromContent("a.js", "original");
    await writeFile(join(cwd, "a.js"), "original-but-longer");
    await expect(
      uploadSourceFiles([f], cwd, ".", makeUploader(), { concurrency: 1 }),
    ).rejects.toMatchObject({ code: "E_PLAN_STALE" });
  });

  // --- concurrency ---
  it("respects concurrency limit (max 4)", async () => {
    const files: SourceFile[] = [];
    for (let i = 0; i < 8; i++) {
      const content = `file-${i}`;
      files.push(fileFromContent(`f${i}.js`, content));
      await writeFile(join(cwd, `f${i}.js`), content);
    }
    const uploader = makeUploader(20);
    const start = Date.now();
    await uploadSourceFiles(files, cwd, ".", uploader, { concurrency: 2 });
    const elapsed = Date.now() - start;
    // 8 files × 20ms / 2 concurrency ≈ 80ms
    expect(elapsed).toBeGreaterThanOrEqual(60);
  });

  // --- abort ---
  it("honors AbortSignal before starting", async () => {
    const files: SourceFile[] = [];
    for (let i = 0; i < 10; i++) {
      const content = `file-${i}`;
      files.push(fileFromContent(`f${i}.js`, content));
      await writeFile(join(cwd, `f${i}.js`), content);
    }
    const ac = new AbortController();
    ac.abort();
    await expect(
      uploadSourceFiles(files, cwd, ".", makeUploader(30), { concurrency: 4, signal: ac.signal }),
    ).rejects.toMatchObject({ code: "E_CANCELLED" });
    expect(uploads.size).toBe(0);
  });

  // --- preserves first failure ---
  it("preserves first failure and aborts remaining", async () => {
    const f1 = fileFromContent("ok.js", "ok");
    const f2 = fileFromContent("bad.js", "original");
    const f3 = fileFromContent("good.js", "good");
    await writeFile(join(cwd, "ok.js"), "ok");
    await writeFile(join(cwd, "bad.js"), "mutated");
    await writeFile(join(cwd, "good.js"), "good");
    await expect(
      uploadSourceFiles([f1, f2, f3], cwd, ".", makeUploader(), { concurrency: 2 }),
    ).rejects.toMatchObject({ code: "E_PLAN_STALE" });
  });

  // --- mutation detection (size change) ---
  it("detects file mutation between enumeration and upload (size change)", async () => {
    const f = fileFromContent("mutate.js", "original100bytes");
    await writeFile(join(cwd, "mutate.js"), "completely different content longer");
    await expect(
      uploadSourceFiles([f], cwd, ".", makeUploader(), { concurrency: 1 }),
    ).rejects.toMatchObject({ code: "E_PLAN_STALE" });
  });

  // --- rejects malicious SourceFile.path ---
  it("rejects SourceFile with ../ escape", async () => {
    const f: SourceFile = { path: "../../etc/passwd", sha1: "x", size: 0 };
    await expect(
      uploadSourceFiles([f], cwd, ".", makeUploader(), { concurrency: 1 }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rejects SourceFile with excluded segment", async () => {
    const f: SourceFile = { path: "good/.env", sha1: "x", size: 0 };
    await expect(
      uploadSourceFiles([f], cwd, ".", makeUploader(), { concurrency: 1 }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  it("rejects SourceFile with absolute path", async () => {
    const f: SourceFile = { path: "/etc/hosts", sha1: "x", size: 0 };
    await expect(
      uploadSourceFiles([f], cwd, ".", makeUploader(), { concurrency: 1 }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  // --- symlink swap detection ---
  it("rejects symlink on disk at upload time", async () => {
    const data = "real content";
    const f = fileFromContent("target.js", data);
    // Write a symlink where the file should be
    await symlink(join(cwd, "real.js"), join(cwd, "target.js"));
    await writeFile(join(cwd, "real.js"), "real");
    await expect(
      uploadSourceFiles([f], cwd, ".", makeUploader(), { concurrency: 1 }),
    ).rejects.toMatchObject({ code: "E_PLAN_STALE" });
  });

  // --- invalid concurrency ---
  it("rejects invalid concurrency values", async () => {
    const f = fileFromContent("a.js", "ok");
    await writeFile(join(cwd, "a.js"), "ok");
    await expect(
      uploadSourceFiles([f], cwd, ".", makeUploader(), { concurrency: 0 }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    await expect(
      uploadSourceFiles([f], cwd, ".", makeUploader(), { concurrency: -1 }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    await expect(
      uploadSourceFiles([f], cwd, ".", makeUploader(), { concurrency: 5 }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    await expect(
      uploadSourceFiles([f], cwd, ".", makeUploader(), { concurrency: Infinity }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
    await expect(
      uploadSourceFiles([f], cwd, ".", makeUploader(), { concurrency: 1.5 }),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  });

  // --- lstat before/after in upload path ---
  it("rejects non-regular file at upload time", async () => {
    const f = fileFromContent("mydir", "should-be-file");
    await mkdir(join(cwd, "mydir"), { recursive: true });
    await expect(
      uploadSourceFiles([f], cwd, ".", makeUploader(), { concurrency: 1 }),
    ).rejects.toMatchObject({ code: "E_PLAN_STALE" });
  });
});

// ---------------------------------------------------------------------------
// verifySourceFreshness
// ---------------------------------------------------------------------------

describe("verifySourceFreshness", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-ship-vfrsh-"));
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.email", "t@t.local"], { cwd });
    await execFileAsync("git", ["config", "user.name", "T"], { cwd });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("passes when source is unchanged", async () => {
    await writeFile(join(cwd, "a.js"), "ok");
    await execFileAsync("git", ["add", "."], { cwd });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd });
    const snap = await enumerateSource(cwd, ".", {
      maxFiles: 100,
      maxFileSize: 1_000_000,
      maxTotalBytes: 10_000_000,
    });
    await expect(verifySourceFreshness(snap, cwd, ".")).resolves.toBeUndefined();
  });

  it("throws E_PLAN_STALE on file content change", async () => {
    await writeFile(join(cwd, "a.js"), "ok");
    await execFileAsync("git", ["add", "."], { cwd });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd });
    const snap = await enumerateSource(cwd, ".", {
      maxFiles: 100,
      maxFileSize: 1_000_000,
      maxTotalBytes: 10_000_000,
    });
    await writeFile(join(cwd, "a.js"), "changed");
    await expect(verifySourceFreshness(snap, cwd, ".")).rejects.toMatchObject({
      code: "E_PLAN_STALE",
    });
  });

  it("throws E_PLAN_STALE on file add", async () => {
    await writeFile(join(cwd, "a.js"), "ok");
    await execFileAsync("git", ["add", "."], { cwd });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd });
    const snap = await enumerateSource(cwd, ".", {
      maxFiles: 100,
      maxFileSize: 1_000_000,
      maxTotalBytes: 10_000_000,
    });
    await writeFile(join(cwd, "b.js"), "new");
    await expect(verifySourceFreshness(snap, cwd, ".")).rejects.toMatchObject({
      code: "E_PLAN_STALE",
    });
  });
});
