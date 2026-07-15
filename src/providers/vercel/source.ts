import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { err } from "../../core/errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Single validated source file ready for upload. */
export interface SourceFile {
  /** POSIX relative path from rootDirectory. */
  path: string;
  /** Lowercase hex SHA-1 of file content. */
  sha1: string;
  /** File size in bytes. */
  size: number;
}

/** Immutable snapshot of local source for Vercel deploy. */
export interface SourceSnapshot {
  rootDirectory: string;
  files: SourceFile[];
  fileCount: number;
  totalBytes: number;
  /** SHA-256 hex fingerprint over canonical sorted {path,sha1,size}. */
  fingerprint: string;
}

/** Structural interface for upload client — no import needed. */
export interface SourceUploader {
  uploadFile(sha1: string, content: Uint8Array, signal?: AbortSignal): Promise<void>;
}

// ---------------------------------------------------------------------------
// Options & defaults
// ---------------------------------------------------------------------------

export interface EnumerateOptions {
  maxFiles?: number;
  maxFileSize?: number;
  maxTotalBytes?: number;
}

const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MiB
const DEFAULT_MAX_TOTAL_BYTES = 250 * 1024 * 1024; // 250 MiB

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

/** Segments unconditionally excluded regardless of depth. */
const EXCLUDED_SEGMENTS = new Set([".git", ".pi-ship"]);

function isEnv(seg: string): boolean {
  return seg === ".env" || seg.startsWith(".env.");
}

function hasExcludedPath(segments: string[]): boolean {
  for (const seg of segments) {
    if (EXCLUDED_SEGMENTS.has(seg) || isEnv(seg)) return true;
  }
  return false;
}

/**
 * Assert `value` is a finite positive integer.
 * Throws E_CONFIG_INVALID otherwise.
 */
function assertPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw err("E_CONFIG_INVALID", `${name} must be a finite positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Assert `value` is a finite positive integer in [min, max].
 */
function assertRange(value: unknown, name: string, min: number, max: number): number {
  const n = assertPositiveInteger(value, name);
  if (n < min || n > max) {
    throw err("E_CONFIG_INVALID", `${name} must be between ${min} and ${max}, got ${n}`);
  }
  return n;
}

/**
 * Validate a POSIX relative path string for use as rootDirectory or file path.
 * - non-empty string
 * - no backslash, NUL byte
 * - not absolute
 * - no .. escape segments or bare ..
 * - no double separators
 */
function validateRelativePath(value: string, label: string): void {
  if (typeof value !== "string" || value === "") {
    throw err("E_CONFIG_INVALID", `${label} must be a non-empty string`);
  }
  if (value.includes("\\")) {
    throw err("E_CONFIG_INVALID", `${label} contains backslash`);
  }
  if (value.includes("\0")) {
    throw err("E_CONFIG_INVALID", `${label} contains null byte`);
  }
  if (value.startsWith("/")) {
    throw err("E_CONFIG_INVALID", `${label} is absolute`);
  }
  if (value === ".." || value.startsWith("../") || value.endsWith("/..") || value.includes("/../")) {
    throw err("E_CONFIG_INVALID", `${label} contains parent-directory escape`);
  }
  if (value.includes("//")) {
    throw err("E_CONFIG_INVALID", `${label} contains double separator`);
  }
}

/**
 * Resolve `root` relative to `cwd` and verify it is strictly contained
 * inside `cwd` (not the same path and not a sibling).
 * Uses `path.relative` to avoid `/tmp/app2` false containment.
 */
function resolveAndCheckContainment(cwd: string, rootDirectory: string): string {
  const absCwd = resolve(cwd);
  const absRoot = resolve(join(cwd, rootDirectory));
  const rel = relative(absCwd, absRoot);
  // rel === "" would mean root resolves to cwd itself — only valid for "."
  if (rel === "" && rootDirectory !== ".") {
    throw err("E_CONFIG_INVALID", `rootDirectory "${rootDirectory}" resolves to cwd itself`);
  }
  if (rel.startsWith("..")) {
    throw err("E_CONFIG_INVALID", `rootDirectory "${rootDirectory}" escapes cwd`);
  }
  return absRoot;
}

/**
 * Validate a SourceFile path that will be read from disk:
 * relative, POSIX-normalized, no escape/excluded/env segments,
 * and resolved containment within rootDirectory/cwd.
 */
function validateSourceFilePath(filePath: string, absRoot: string, absCwd: string): void {
  validateRelativePath(filePath, `SourceFile.path "${filePath}"`);

  const segments = filePath.split("/");
  if (hasExcludedPath(segments)) {
    throw err("E_CONFIG_INVALID", `SourceFile.path "${filePath}" contains excluded path segment`);
  }

  // Verify resolved path stays inside rootDirectory
  const absFile = resolve(join(absRoot, filePath));
  const relToRoot = relative(absRoot, absFile);
  if (relToRoot.startsWith("..")) {
    throw err("E_CONFIG_INVALID", `SourceFile.path "${filePath}" escapes rootDirectory`);
  }
  // Also verify it stays inside cwd (belt-and-suspenders)
  const relToCwd = relative(absCwd, absFile);
  if (relToCwd.startsWith("..")) {
    throw err("E_CONFIG_INVALID", `SourceFile.path "${filePath}" escapes cwd`);
  }
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

/** Compute lowercase SHA-1 hex digest. */
function sha1Of(data: Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

/** Compute SHA-256 hex fingerprint over canonical JSON of sorted files. */
function fingerprintOf(files: SourceFile[]): string {
  const canonical = JSON.stringify(
    files.map((f) => ({ path: f.path, sha1: f.sha1, size: f.size })),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// enumerateSource
// ---------------------------------------------------------------------------

/**
 * Enumerate local source files using `git ls-files`.
 *
 * Returns tracked + untracked (respecting .gitignore) files under
 * `rootDirectory`, validated and sorted, with SHA-1 hashes and a
 * deterministic SHA-256 fingerprint.
 */
export async function enumerateSource(
  cwd: string,
  rootDirectory = ".",
  options: EnumerateOptions = {},
): Promise<SourceSnapshot> {
  // --- Validate options ---
  let maxFiles: number;
  let maxFileSize: number;
  let maxTotalBytes: number;

  if (options.maxFiles !== undefined) {
    maxFiles = assertPositiveInteger(options.maxFiles, "maxFiles");
  } else {
    maxFiles = DEFAULT_MAX_FILES;
  }

  if (options.maxFileSize !== undefined) {
    maxFileSize = assertPositiveInteger(options.maxFileSize, "maxFileSize");
  } else {
    maxFileSize = DEFAULT_MAX_FILE_SIZE;
  }

  if (options.maxTotalBytes !== undefined) {
    maxTotalBytes = assertPositiveInteger(options.maxTotalBytes, "maxTotalBytes");
  } else {
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES;
  }

  // --- Validate rootDirectory ---
  validateRelativePath(rootDirectory, "rootDirectory");
  const absRoot = resolveAndCheckContainment(cwd, rootDirectory);
  const absCwd = resolve(cwd);

  // --- Pathspec prefix to strip from git output ---
  // git ls-files paths are relative to cwd. When rootDirectory is not ".",
  // git prepends it (e.g. "app/index.js"). We strip it to get paths
  // relative to rootDirectory.
  const prefix =
    rootDirectory === "." ? "" : rootDirectory.replace(/\/+$/, "") + "/";

  // --- Run git ls-files ---
  let stdout: string;
  try {
    const result = await execFileAsync(
      "git",
      [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        rootDirectory,
      ],
      { cwd, maxBuffer: 50 * 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw err("E_CONFIG_INVALID", `git ls-files failed: ${msg}`);
  }

  // --- Parse null-separated output ---
  const rawPaths = stdout ? stdout.split("\0").filter((p) => p.length > 0) : [];

  const sourceFiles: SourceFile[] = [];
  let totalBytes = 0;

  for (const rawPath of rawPaths) {
    // --- Path-level validation ---
    // rawPath from git should never contain NUL, but double-check
    if (rawPath.includes("\0")) {
      throw err("E_CONFIG_INVALID", `git path contains null byte: ${rawPath}`);
    }

    if (rawPath.startsWith("/")) {
      throw err("E_CONFIG_INVALID", `absolute path from git: ${rawPath}`);
    }

    if (rawPath.includes("\\")) {
      throw err("E_CONFIG_INVALID", `path from git contains backslash: ${rawPath}`);
    }

    if (
      rawPath === ".." ||
      rawPath.startsWith("../") ||
      rawPath.includes("/../")
    ) {
      throw err("E_CONFIG_INVALID", `git path escape via "..": ${rawPath}`);
    }

    // --- Strip rootDirectory prefix; fail if unexpected path ---
    if (prefix !== "" && !rawPath.startsWith(prefix)) {
      throw err(
        "E_CONFIG_INVALID",
        `git path "${rawPath}" is not under rootDirectory "${rootDirectory}"`,
      );
    }
    const relPath = prefix === "" ? rawPath : rawPath.slice(prefix.length);

    // Quick sanity: relPath should not be empty
    if (relPath === "") {
      throw err(
        "E_CONFIG_INVALID",
        `empty relative path from "${rawPath}" under root "${rootDirectory}"`,
      );
    }

    // --- Segment-level rejection ---
    const segments = relPath.split("/");
    if (hasExcludedPath(segments)) {
      throw err("E_CONFIG_INVALID", `excluded path segment in: ${rawPath}`);
    }

    // --- stat before read ---
    const absPath = join(absRoot, relPath);
    let stat;
    try {
      stat = await lstat(absPath);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw err("E_CONFIG_INVALID", `cannot stat ${relPath}: ${msg}`);
    }

    if (stat.isSymbolicLink()) {
      throw err("E_CONFIG_INVALID", `symlink not allowed: ${relPath}`);
    }
    if (!stat.isFile()) {
      throw err("E_CONFIG_INVALID", `non-regular file: ${relPath}`);
    }
    if (stat.size > maxFileSize) {
      throw err(
        "E_CONFIG_INVALID",
        `file too large (${stat.size} bytes): ${relPath}`,
      );
    }

    // --- Read bytes ---
    let content: Buffer;
    try {
      content = await readFile(absPath);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw err("E_CONFIG_INVALID", `cannot read ${relPath}: ${msg}`);
    }

    // --- TOCTOU: re-stat after read (check inode, type, size) ---
    let statAfter: import("node:fs").Stats;
    try {
      statAfter = await lstat(absPath);
    } catch {
      throw err("E_PLAN_STALE", `file disappeared after read: ${relPath}`);
    }
    if (
      statAfter.ino !== stat.ino ||
      statAfter.size !== stat.size ||
      statAfter.isFile() !== stat.isFile()
    ) {
      throw err(
        "E_PLAN_STALE",
        `file changed during enumeration: ${relPath}`,
      );
    }

    // --- Hash & accumulate ---
    const sha1 = sha1Of(content);
    sourceFiles.push({ path: relPath, sha1, size: content.length });
    totalBytes += content.length;

    if (sourceFiles.length > maxFiles) {
      throw err(
        "E_CONFIG_INVALID",
        `too many files (exceeds ${maxFiles})`,
      );
    }
    if (totalBytes > maxTotalBytes) {
      throw err(
        "E_CONFIG_INVALID",
        `total source size ${totalBytes} exceeds ${maxTotalBytes}`,
      );
    }
  }

  if (sourceFiles.length === 0) {
    throw err("E_CONFIG_INVALID", "empty source: no files to upload");
  }

  // --- Stable bytewise sort ---
  sourceFiles.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  return {
    rootDirectory,
    files: sourceFiles,
    fileCount: sourceFiles.length,
    totalBytes,
    fingerprint: fingerprintOf(sourceFiles),
  };
}

// ---------------------------------------------------------------------------
// uploadSourceFiles
// ---------------------------------------------------------------------------

/**
 * Upload validated source files through the given uploader.
 *
 * Re-validates each file on disk (lstat → readFile → lstat, SHA/size check)
 * before upload. Bounded concurrency (1-4), preserves first failure,
 * honors AbortSignal.
 */
export async function uploadSourceFiles(
  files: SourceFile[],
  cwd: string,
  rootDirectory: string,
  uploader: SourceUploader,
  options: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<void> {
  // --- Validate parameters ---
  const concurrency = assertRange(
    options.concurrency ?? 4,
    "concurrency",
    1,
    4,
  );
  const signal = options.signal;

  // Validate cwd and rootDirectory
  if (typeof cwd !== "string" || cwd === "") {
    throw err("E_CONFIG_INVALID", "cwd must be a non-empty string");
  }
  validateRelativePath(rootDirectory, "rootDirectory");
  const absCwd = resolve(cwd);
  const absRoot = resolveAndCheckContainment(cwd, rootDirectory);

  // --- Upfront validation of all SourceFile paths ---
  for (const file of files) {
    validateSourceFilePath(file.path, absRoot, absCwd);
  }

  if (signal?.aborted) {
    throw err("E_CANCELLED", "upload cancelled before start");
  }

  let firstError: Error | null = null;

  const tasks = files.map(
    (file) => async (): Promise<void> => {
      if (firstError) return;
      if (signal?.aborted) {
        firstError ??= err("E_CANCELLED", "upload cancelled");
        throw firstError;
      }

      const absPath = join(absRoot, file.path);

      // --- stat before read ---
      let statBefore: import("node:fs").Stats;
      try {
        statBefore = await lstat(absPath);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        firstError ??= err("E_PLAN_STALE", `cannot stat ${file.path}: ${msg}`);
        throw firstError;
      }

      if (statBefore.isSymbolicLink()) {
        firstError ??= err("E_PLAN_STALE", `symlink not allowed: ${file.path}`);
        throw firstError;
      }
      if (!statBefore.isFile()) {
        firstError ??= err("E_PLAN_STALE", `non-regular file: ${file.path}`);
        throw firstError;
      }

      // --- Read bytes ---
      let content: Buffer;
      try {
        content = await readFile(absPath);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        firstError ??= err("E_PLAN_STALE", `cannot read ${file.path}: ${msg}`);
        throw firstError;
      }

      // --- stat after read (TOCTOU: inode, type, size) ---
      let statAfter: import("node:fs").Stats;
      try {
        statAfter = await lstat(absPath);
      } catch {
        firstError ??= err(
          "E_PLAN_STALE",
          `file disappeared after read: ${file.path}`,
        );
        throw firstError;
      }
      if (
        statAfter.ino !== statBefore.ino ||
        statAfter.size !== statBefore.size ||
        statAfter.isFile() !== statBefore.isFile()
      ) {
        firstError ??= err(
          "E_PLAN_STALE",
          `file changed during upload read: ${file.path}`,
        );
        throw firstError;
      }

      // --- Verify size & SHA-1 match planned ---
      if (content.length !== file.size) {
        firstError ??= err(
          "E_PLAN_STALE",
          `size mismatch for ${file.path}`,
        );
        throw firstError;
      }
      const actualSha1 = sha1Of(content);
      if (actualSha1 !== file.sha1) {
        firstError ??= err(
          "E_PLAN_STALE",
          `SHA-1 mismatch for ${file.path}`,
        );
        throw firstError;
      }

      if (signal?.aborted) {
        firstError ??= err("E_CANCELLED", "upload cancelled");
        throw firstError;
      }

      // --- Upload ---
      try {
        await uploader.uploadFile(file.sha1, content, signal);
      } catch (e: unknown) {
        const upErr = e instanceof Error ? e : new Error(String(e));
        firstError ??= upErr;
        throw upErr;
      }
    },
  );

  // --- Bounded concurrency runner ---
  const queue = [...tasks];
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < queue.length) {
      if (firstError) return;
      if (signal?.aborted) {
        firstError ??= err("E_CANCELLED", "upload cancelled");
        return;
      }
      const task = queue[idx++];
      try {
        await task();
      } catch {
        // firstError already captured inside task
        return;
      }
    }
  }

  const workers: Promise<void>[] = [];
  const poolSize = Math.min(concurrency, queue.length);
  for (let i = 0; i < poolSize; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  if (firstError) throw firstError;
}

// ---------------------------------------------------------------------------
// verifySourceFreshness
// ---------------------------------------------------------------------------

/**
 * Re-enumerate source and verify it still matches the planned snapshot.
 * Throws E_PLAN_STALE on any mismatch.
 */
export async function verifySourceFreshness(
  snapshot: SourceSnapshot,
  cwd: string,
  rootDirectory?: string,
): Promise<void> {
  const current = await enumerateSource(
    cwd,
    rootDirectory ?? snapshot.rootDirectory,
  );

  if (current.fileCount !== snapshot.fileCount) {
    throw err(
      "E_PLAN_STALE",
      `file count mismatch: ${current.fileCount} !== ${snapshot.fileCount}`,
    );
  }
  if (current.totalBytes !== snapshot.totalBytes) {
    throw err(
      "E_PLAN_STALE",
      `total bytes mismatch: ${current.totalBytes} !== ${snapshot.totalBytes}`,
    );
  }
  if (current.fingerprint !== snapshot.fingerprint) {
    throw err(
      "E_PLAN_STALE",
      `fingerprint mismatch: ${current.fingerprint} !== ${snapshot.fingerprint}`,
    );
  }

  // Deep file-by-file check
  for (let i = 0; i < snapshot.fileCount; i++) {
    const planned = snapshot.files[i];
    const actual = current.files[i];
    if (
      planned.path !== actual.path ||
      planned.sha1 !== actual.sha1 ||
      planned.size !== actual.size
    ) {
      throw err(
        "E_PLAN_STALE",
        `file mismatch at index ${i}: ${planned.path} !== ${actual.path}`,
      );
    }
  }
}
