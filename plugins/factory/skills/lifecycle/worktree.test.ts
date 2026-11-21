import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test, type TestContext } from "node:test";

const script = join(import.meta.dirname, "factory.mjs");

async function fixture(t: TestContext, { template = "{repoPath}/../wts/{repo}/{branch}" }: { template?: string | null } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "worktree-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const repo = join(root, "proj");
  await mkdir(join(home, ".copilot"), { recursive: true });
  if (template !== null) {
    await writeFile(join(home, ".copilot", "settings.json"), JSON.stringify({ worktreePathTemplate: template }));
  }
  const env = {
    ...process.env,
    HOME: home,
    COPILOT_HOME: join(home, ".copilot"),
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(root, "init", "-q", "-b", "main", repo);
  git(repo, "commit", "-q", "--allow-empty", "-m", "base");
  const helper = (cwd: string, ...args: string[]) => {
    const result = spawnSync(process.execPath, [script, "worktree", ...args], { cwd, encoding: "utf8", env });
    let json = null;
    try {
      json = JSON.parse(result.stdout);
    } catch {}
    return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
  };
  return { root, home, repo, env, git, helper };
}

test("create branches from local HEAD and expands the template", async (t) => {
  const f = await fixture(t);
  f.git(f.repo, "commit", "-q", "--allow-empty", "-m", "unpushed");
  const result = f.helper(f.repo, "create", "fix-login");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.json, {
    path: join(f.root, "wts", "proj", "fix-login"), branch: "fix-login", created_by_run: true, base: "HEAD",
  });
  assert.equal(f.git(result.json.path, "rev-parse", "HEAD"), f.git(f.repo, "rev-parse", "main"));
  assert.equal(f.git(result.json.path, "branch", "--show-current"), "fix-login");
});

test("template fields, slash nesting and a leading ~", async (t) => {
  const f = await fixture(t, { template: "~/w/{repo}/{branchSlug}" });
  const slug = f.helper(f.repo, "path", "feat/x");
  assert.equal(slug.json.path, join(f.home, "w", "proj", "feat-x"));
  assert.equal(slug.json.exists, false);

  await writeFile(join(f.home, ".copilot", "settings.json"),
    JSON.stringify({ worktreePathTemplate: "{repoPath}.wt/{branch}" }));
  const nested = f.helper(f.repo, "create", "feat/x");
  assert.equal(nested.status, 0, nested.stderr);
  assert.equal(nested.json.path, join(f.repo + ".wt", "feat", "x"));
});

test("an unset template falls back to ~/Developer/worktrees/{repo}/{branch}", async (t) => {
  const f = await fixture(t, { template: null });
  const result = f.helper(f.repo, "create", "task-1");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.path, join(f.home, "Developer", "worktrees", "proj", "task-1"));
});

test("an unreadable settings file fails instead of using the fallback", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, ".copilot", "settings.json"), "{ nope");
  const result = f.helper(f.repo, "create", "task-1");
  assert.equal(result.status, 1);
  assert.match(result.json.message, /settings\.json/);
});

test("create reuses a worktree and attaches an existing branch", async (t) => {
  const f = await fixture(t);
  const first = f.helper(f.repo, "create", "one");
  const second = f.helper(f.repo, "create", "one");
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(second.json, { path: first.json.path, branch: "one", created_by_run: false });

  f.git(f.repo, "branch", "two");
  const attached = f.helper(f.repo, "create", "two");
  assert.equal(attached.status, 0, attached.stderr);
  assert.equal(attached.json.created_by_run, true);
  assert.equal(f.git(attached.json.path, "branch", "--show-current"), "two");
});

test("create refuses a path that exists and is not the worktree", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "wts", "proj", "taken"), { recursive: true });
  const result = f.helper(f.repo, "create", "taken");
  assert.equal(result.status, 2);
  assert.equal(result.json.error, "refused");
});

test("create runs CMD in the worktree and returns its exit code", async (t) => {
  const f = await fixture(t);
  const result = f.helper(f.repo, "create", "run", "--", process.execPath, "-e", "console.log(process.cwd()); process.exit(7)");
  assert.equal(result.status, 7);
  assert.equal(result.stdout.trim(), join(f.root, "wts", "proj", "run"));
  assert.equal(JSON.parse(result.stderr.split("\n")[0]).created_by_run, true);
});

test("delete removes a worktree merged into the local default branch", async (t) => {
  const f = await fixture(t);
  const { path } = f.helper(f.repo, "create", "merged").json;
  f.git(path, "commit", "-q", "--allow-empty", "-m", "work");
  f.git(f.repo, "merge", "-q", "--ff-only", "merged");
  const result = f.helper(f.repo, "delete", "merged");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.json, { path, branch: "merged", removed: true, branch_deleted: true });
  assert.equal(existsSync(path), false);
  assert.equal(f.git(f.repo, "branch", "--list", "merged"), "");
});

test("delete refuses an unmerged commit", async (t) => {
  const f = await fixture(t);
  const { path } = f.helper(f.repo, "create", "open").json;
  f.git(path, "commit", "-q", "--allow-empty", "-m", "work");
  const result = f.helper(f.repo, "delete", "open");
  assert.equal(result.status, 2);
  assert.equal(result.json.removed, false);
  assert.equal(result.json.reason, "unmerged");
  assert.equal(existsSync(path), true);
});

test("delete refuses a dirty tree even when merged", async (t) => {
  const f = await fixture(t);
  const { path } = f.helper(f.repo, "create", "dirty").json;
  await writeFile(join(path, "new.txt"), "x");
  const result = f.helper(f.repo, "delete", "dirty");
  assert.equal(result.status, 2);
  assert.equal(result.json.reason, "dirty");
  assert.equal(existsSync(path), true);
});

test("delete accepts a tip contained in a remote branch", async (t) => {
  const f = await fixture(t);
  const bare = join(f.root, "origin.git");
  f.git(f.root, "init", "-q", "--bare", bare);
  f.git(f.repo, "remote", "add", "origin", bare);
  const { path } = f.helper(f.repo, "create", "pushed").json;
  f.git(path, "commit", "-q", "--allow-empty", "-m", "work");
  f.git(path, "push", "-q", "origin", "pushed");
  const result = f.helper(f.repo, "delete", "pushed");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.removed, true);
  assert.equal(existsSync(path), false);
});

test("delete --force removes an unmerged dirty worktree", async (t) => {
  const f = await fixture(t);
  const { path } = f.helper(f.repo, "create", "forced").json;
  f.git(path, "commit", "-q", "--allow-empty", "-m", "work");
  await writeFile(join(path, "new.txt"), "x");
  const result = f.helper(f.repo, "delete", "forced", "--force");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.branch_deleted, false);
  assert.equal(existsSync(path), false);
});

test("delete refuses the main checkout and the current worktree", async (t) => {
  const f = await fixture(t);
  const { path } = f.helper(f.repo, "create", "here").json;
  assert.equal(f.helper(f.repo, "delete", "main").status, 2);
  assert.equal(f.helper(path, "delete", "here").status, 2);
  assert.equal(existsSync(path), true);
});

test("unknown worktree exits 3; bad input exits 1", async (t) => {
  const f = await fixture(t);
  assert.equal(f.helper(f.repo, "delete", "ghost").status, 3);
  assert.equal(f.helper(f.repo, "create", "bad name").status, 1);
  assert.equal(f.helper(f.repo, "create", "--", "x").status, 1);
  assert.equal(f.helper(f.repo).status, 1);
  assert.equal(f.helper(f.repo, "frobnicate", "x").status, 1);
});

test("run from a linked worktree, {repoPath} is the main checkout", async (t) => {
  const f = await fixture(t);
  const { path } = f.helper(f.repo, "create", "first").json;
  const second = f.helper(path, "create", "second");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.json.path, join(f.root, "wts", "proj", "second"));
});

async function stubGh(f: Awaited<ReturnType<typeof fixture>>, url: string) {
  const bin = join(f.root, "bin");
  const calls = join(f.root, "gh-calls.txt");
  await mkdir(bin);
  await writeFile(join(bin, "gh"), `#!/bin/sh
if [ "$1 $2" = "pr view" ]; then echo '{"url":"${url}"}'; exit 0; fi
echo "$PWD $*" >> "${calls}"
git checkout -q -b "$5"
`);
  await chmod(join(bin, "gh"), 0o755);
  return { env: { ...f.env, PATH: `${bin}${delimiter}${process.env.PATH}` }, calls };
}

test("--pr checks the PR out in a new worktree through gh", async (t) => {
  const f = await fixture(t);
  f.git(f.repo, "remote", "add", "origin", "git@github.com:acme/proj.git");
  const gh = await stubGh(f, "https://github.com/acme/proj/pull/12");
  const result = spawnSync(process.execPath, [script, "worktree", "create", "pr-12", "--pr", "12"], { cwd: f.repo, encoding: "utf8", env: gh.env });
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.path, join(f.root, "wts", "proj", "pr-12"));
  assert.equal(json.created_by_run, true);
  assert.equal(await readFile(gh.calls, "utf8"), `${json.path} pr checkout 12 --branch pr-12 --force\n`);
});

test("--pr refuses a PR from another repository", async (t) => {
  const f = await fixture(t);
  f.git(f.repo, "remote", "add", "origin", "https://github.com/acme/proj.git");
  const gh = await stubGh(f, "https://github.com/other/thing/pull/12");
  const result = spawnSync(process.execPath, [script, "worktree", "create", "pr-12", "--pr", "12"], { cwd: f.repo, encoding: "utf8", env: gh.env });
  assert.equal(result.status, 2);
  assert.equal(existsSync(join(f.root, "wts", "proj", "pr-12")), false);
});

async function squashed(t: TestContext, { sha = (tip: string) => tip, merged = true } = {}) {
  const f = await fixture(t);
  f.git(f.repo, "remote", "add", "origin", "git@github.com:acme/proj.git");
  const { path } = f.helper(f.repo, "create", "squashed").json;
  f.git(path, "commit", "-q", "--allow-empty", "-m", "work");
  f.git(f.repo, "commit", "-q", "--allow-empty", "-m", "squash of work");
  const tip = f.git(path, "rev-parse", "HEAD");
  const bin = join(f.root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "gh"), `#!/bin/sh
[ "$1 $2" = "api repos/acme/proj/pulls/7" ] || exit 1
echo '{"merged":${merged},"head":{"sha":"${sha(tip)}"}}'
`);
  await chmod(join(bin, "gh"), 0o755);
  const env = { ...f.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
  const del = (...args: string[]) => {
    const result = spawnSync(process.execPath, [script, "worktree", "delete", "squashed", ...args], { cwd: f.repo, encoding: "utf8", env });
    return { status: result.status, json: JSON.parse(result.stdout) };
  };
  return { f, path, del };
}

test("delete --merged-pr removes a squash-merged branch", async (t) => {
  const { f, path, del } = await squashed(t);
  assert.equal(del().json.reason, "unmerged");
  const result = del("--merged-pr", "https://github.com/acme/proj/pull/7");
  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.deepEqual(result.json, { path, branch: "squashed", removed: true, branch_deleted: true });
  assert.equal(existsSync(path), false);
  assert.equal(f.git(f.repo, "branch", "--list", "squashed"), "");
});

test("delete --merged-pr refuses a PR whose head is not in the worktree", async (t) => {
  const { path, del } = await squashed(t, { sha: () => "f".repeat(40) });
  const result = del("--merged-pr", "7");
  assert.equal(result.status, 2);
  assert.equal(result.json.reason, "pr-not-merged");
  assert.equal(existsSync(path), true);
});

test("delete --merged-pr refuses an open PR", async (t) => {
  const { path, del } = await squashed(t, { merged: false });
  assert.equal(del("--merged-pr", "7").status, 2);
  assert.equal(existsSync(path), true);
});

test("delete --merged-pr refuses a dirty tree and a PR of another repository", async (t) => {
  const { path, del } = await squashed(t);
  assert.equal(del("--merged-pr", "https://github.com/other/thing/pull/7").status, 1);
  await writeFile(join(path, "new.txt"), "x");
  const result = del("--merged-pr", "7");
  assert.equal(result.status, 2);
  assert.equal(result.json.reason, "dirty");
  assert.equal(existsSync(path), true);
});
