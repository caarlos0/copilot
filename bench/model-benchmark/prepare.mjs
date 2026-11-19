import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildBrief, resultName } from "./brief.mjs";
import { exportTree, factoryTaskId } from "./score.mjs";

export function scratchPaths(scratch, task, toolsPath) {
  const state = join(scratch, "state");
  return {
    scratch,
    work: join(scratch, "work"),
    tools: join(scratch, "tools", toolsPath),
    state,
    factory: join(state, "bench-factory.json"),
    events: join(state, "bench-factory-events.jsonl"),
    resultName: resultName(task),
    result: join(state, resultName(task)),
    brief: join(scratch, "brief.md"),
    branch: `bench/${task.id.toLowerCase()}`,
  };
}

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// One commit with no history, so the fix cannot be read with git log or git show.
function initRepo(task, { work, branch }) {
  git(work, "init", "-q", "-b", "main");
  for (const [key, value] of [["user.name", "bench"], ["user.email", "bench@example.invalid"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"]]) {
    git(work, "config", key, value);
  }
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  git(work, "tag", "bench-base");
  if (task.role === "implementation") git(work, "checkout", "-q", "-b", branch);
}

// Read-only: IMPL-3 edits broker.mjs in the worktree, and the brief's emit command must not follow it.
function lockFiles(dir) {
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) chmodSync(join(entry.parentPath, entry.name), 0o444);
  }
}

function createFactory(task, paths) {
  const factory = (...args) => execFileSync(process.execPath, [join(paths.tools, "factory.mjs"), paths.factory, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const id = factoryTaskId(task);
  factory("--project", `bench/${task.id.toLowerCase()}`, "--run-goal", `Benchmark ${task.id}`);
  factory("--task", id, "--title", task.title, "--issue", "null", "--next-action", "Start");
  factory("--task", id, "--state", "investigation", "--note", "benchmark");
  if (task.role === "implementation") {
    factory("--task", id, "--state", "implementation", "--note", "benchmark",
      "--worktree", JSON.stringify({ path: paths.work, created_by_run: true }));
  }
}

// The scratch directory holds everything the worker may touch: the exported tree, a pinned
// copy of the factory tools, a state directory with a factory file, and the brief.
export function prepare(task, { repo, toolsRef, toolsPath, paths }) {
  mkdirSync(paths.state, { recursive: true });
  exportTree(repo, task.base ?? task.export_at, paths.work);
  initRepo(task, paths);
  exportTree(repo, toolsRef, join(paths.scratch, "tools"), [toolsPath]);
  lockFiles(join(paths.scratch, "tools"));
  createFactory(task, paths);
  writeFileSync(paths.brief, buildBrief(task, paths));
}
