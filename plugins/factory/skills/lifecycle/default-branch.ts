import { execFileSync } from "node:child_process";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

// The override, else origin/HEAD, else a local main or master; null when none exists.
export function defaultBranch(cwd: string, override?: string): string | null {
  if (override) return override;
  let head = "";
  try {
    head = git(cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, "");
  } catch {}
  return [head, "main", "master"].find((branch) => {
    if (!branch) return false;
    try {
      git(cwd, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
      return true;
    } catch {
      return false;
    }
  }) ?? null;
}
