import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function gatherGit(cwd: string): Promise<{ gitCommit: string; gitDirty: boolean; worktreeHash: string }> {
  let gitCommit = "unknown";
  let gitDirty = false;
  let worktreeHash = "";
  try {
    const { stdout: commit } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
    gitCommit = commit.trim();
  } catch {
    // not a git repo
  }
  try {
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd });
    gitDirty = status.trim().length > 0;
  } catch {
    gitDirty = false;
  }
  try {
    const { stdout: diff } = await execFileAsync("git", ["diff", "HEAD"], { cwd });
    const { stdout: untracked } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd });
    const hash = createHash("sha256").update(diff);
    for (const file of untracked.split("\0").filter(Boolean).sort()) {
      hash.update(file);
      hash.update(await readFile(`${cwd}/${file}`));
    }
    worktreeHash = hash.digest("hex");
  } catch {
    worktreeHash = "";
  }
  return { gitCommit, gitDirty, worktreeHash };
}
