const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { chmod, mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { delimiter, join } = require("node:path");
const { test } = require("node:test");

const script = join(__dirname, "reconcile.mjs");
const window = "window:01a1ea3c-952d-7bdf-a621-95363a2bc34f";

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function task(id, state, extra = {}) {
  const at = "2026-05-01T12:00:00Z";
  return {
    id, title: id, state, updated_at: at, next_action: "Next", issue: null, pr: null,
    head: null, reviewed_head: null, links: [], blocker: null,
    resolution: state === "resolved" ? { outcome: "merged", at, note: null } : null,
    merge: null, workers: {}, worktree: null, history: [{ state, at, note: null }], details: null,
    ...extra,
  };
}

async function fixture(t, rex) {
  const directory = await mkdtemp(join(tmpdir(), "reconcile-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo");
  git(directory, "init", "-q", "-b", "main", repo);
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  git(repo, "switch", "-q", "-c", "work");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work");

  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "rex"), rex);
  await chmod(join(bin, "rex"), 0o755);

  const file = join(directory, "owner.repo-factory.json");
  return {
    directory, repo, file,
    async run(tasks, { status = "active", waiter = process.pid } = {}) {
      await writeFile(file, JSON.stringify({ rex_session: "work", status, tasks }));
      const pidFile = join(directory, "owner.repo-factory-waiter.pid");
      if (waiter === null) await rm(pidFile, { force: true });
      else await writeFile(pidFile, `${waiter}\n`);
      const result = spawnSync(process.execPath, [script, file], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    },
  };
}

const fakeRex = `#!/bin/sh\necho '{"windows":[{"window_id":"${window}"}]}'\n`;

test("reports a complete result newer than its task, a branch ahead, and a window of a resolved task", async (t) => {
  const f = await fixture(t, fakeRex);
  await writeFile(join(f.directory, "stuck-result.json"), JSON.stringify({
    outcome: "complete", updated_at: "2026-05-01T13:00:00Z", head: "a".repeat(40),
  }));
  await writeFile(join(f.directory, "seen-result.json"), JSON.stringify({
    outcome: "complete", updated_at: "2026-05-01T11:00:00Z",
  }));
  const { findings, errors } = await f.run([
    task("stuck", "investigation", {
      workers: { investigation: { status: "running", result: "stuck-result.json" } },
      worktree: { path: f.repo, created_by_run: true },
    }),
    task("seen", "implementation", { workers: { investigation: { status: "closed", result: "seen-result.json" } } }),
    task("done-short", "resolved", { workers: { implementation: { status: "closed", window: "a621-95363a2bc34f" } } }),
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(findings, [
    { kind: "unprocessed-result", task: "stuck", state: "investigation", role: "investigation",
      result: "stuck-result.json", head: "a".repeat(40) },
    { kind: "branch-ahead", task: "stuck", state: "investigation", branch: "work", ahead: 1 },
    { kind: "open-window", task: "done-short", role: "implementation", window },
  ]);
});

test("flags a branch ahead only for tasks that land by local merge", async (t) => {
  const f = await fixture(t, fakeRex);
  const worktree = { path: f.repo, created_by_run: true };
  const { findings, errors } = await f.run([
    task("with-pr", "review", { issue: { number: 1 }, pr: { number: 2 }, worktree }),
    task("local", "review", { worktree }),
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(findings, [
    { kind: "branch-ahead", task: "local", state: "review", branch: "work", ahead: 1 },
  ]);
});

test("flags a clean worktree of a merged task whose HEAD is in the default branch", async (t) => {
  const f = await fixture(t, fakeRex);
  const clean = join(f.directory, "clean");
  const dirty = join(f.directory, "dirty");
  git(f.repo, "worktree", "add", "-q", "-b", "clean", clean, "main");
  git(f.repo, "worktree", "add", "-q", "-b", "dirty", dirty, "main");
  await writeFile(join(dirty, "scratch.txt"), "x");
  const at = (path) => ({ path, created_by_run: true });
  const { findings, errors } = await f.run([
    task("clean", "resolved", { worktree: at(clean) }),
    task("dirty", "resolved", { worktree: at(dirty) }),
    task("unmerged", "resolved", { worktree: at(f.repo) }),
    task("gone", "resolved", { worktree: at(join(f.directory, "gone")) }),
    task("closed", "resolved", {
      resolution: { outcome: "cancelled", at: "2026-05-01T12:00:00Z", note: null },
      worktree: at(clean),
    }),
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(findings, [
    { kind: "merged-worktree", task: "clean", path: clean, created_by_run: true },
  ]);
});

test("is quiet when everything is reconciled", async (t) => {
  const f = await fixture(t, fakeRex);
  const { findings, errors } = await f.run([
    task("done", "resolved", { workers: { implementation: { status: "closed", window: "window:other-id" } } }),
  ]);
  assert.deepEqual({ findings, errors }, { findings: [], errors: [] });
});

test("reports a Rex failure without failing the sweep", async (t) => {
  const f = await fixture(t, "#!/bin/sh\necho no server >&2\nexit 1\n");
  const { findings, errors } = await f.run([
    task("done", "resolved", { workers: { implementation: { status: "closed", window } } }),
  ]);
  assert.deepEqual(findings, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^rex: /);
});

test("reports no-waiter while the run is active or a task is open, and no waiter is alive", async (t) => {
  const f = await fixture(t, fakeRex);
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  const open = [task("busy", "implementation")];
  const done = [task("done", "resolved")];
  const kinds = async (...args) => (await f.run(...args)).findings.map(({ kind }) => kind);

  assert.deepEqual(await kinds(open, { waiter: null }), ["no-waiter"]);
  assert.deepEqual(await kinds(open, { waiter: dead }), ["no-waiter"]);
  assert.deepEqual(await kinds(done, { status: "active", waiter: null }), ["no-waiter"]);
  assert.deepEqual(await kinds(open, { status: "paused", waiter: null }), ["no-waiter"]);
  assert.deepEqual(await kinds(open), []);
  assert.deepEqual(await kinds(done, { status: "finished", waiter: null }), []);
});
