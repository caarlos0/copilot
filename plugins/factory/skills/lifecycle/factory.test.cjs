const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { mkdtemp, readFile, readdir, rm, stat, writeFile } = require("node:fs/promises");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");

const script = join(__dirname, "factory.mjs");
const example = JSON.parse(readFileSync(join(__dirname, "factory.example.json"), "utf8"));
const issue = (n) => `https://github.com/owner/repo/issues/${n}`;
const pull = (n) => `https://github.com/owner/repo/pull/${n}`;
const sha = (char) => char.repeat(40);

async function fixture(t, data) {
  const directory = await mkdtemp(join(tmpdir(), "factory-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "owner.repo-factory.json");
  if (data) await writeFile(file, JSON.stringify(data));
  return {
    directory,
    file,
    read: async () => JSON.parse(await readFile(file, "utf8")),
    run: (...args) => spawnSync(process.execPath, [script, file, ...args], { encoding: "utf8" }),
    ok(...args) {
      const result = this.run(...args);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    },
    fails(message, ...args) {
      const result = this.run(...args);
      assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
      assert.match(result.stderr, message);
    },
  };
}

async function started(t) {
  const f = await fixture(t);
  f.ok("--project", "owner/repo", "--run-goal", "Run it", "--rex-session", "work");
  f.ok("--task", "issue-1", "--title", "Fix it", "--issue", issue(1), "--next-action", "Start");
  return f;
}

test("creates a private factory with defaults and a new task in initial", async (t) => {
  const f = await started(t);
  const data = await f.read();
  assert.equal(data.format, "factory/v1");
  assert.equal(data.id, "owner.repo-factory");
  assert.equal(data.rex_session, "work");
  assert.deepEqual(data.limits, { investigation: 3, implementation: 3 });
  assert.equal(data.tasks[0].state, "initial");
  assert.deepEqual(data.tasks[0].history.map((item) => item.state), ["initial"]);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(f.directory), ["owner.repo-factory.json"]);
});

test("the shipped example is a valid factory", async () => {
  const { validate } = await import("./factory-data.mjs");
  validate(example);
});

test("a new task needs an issue; null is accepted only on purpose", async (t) => {
  const f = await started(t);
  f.fails(/needs --issue/, "--task", "issue-2", "--title", "x", "--next-action", "y");
  f.ok("--task", "issue-2", "--title", "x", "--next-action", "y", "--issue", "null");
  f.fails(/needs a GitHub issue/, "--task", "issue-2", "--state", "investigation");
});

test("moves follow the flow and each move adds history", async (t) => {
  const f = await started(t);
  f.fails(/cannot move from initial to review/, "--task", "issue-1", "--state", "review");
  f.ok("--task", "issue-1", "--state", "investigation", "--note", "go");
  f.ok("--task", "issue-1", "--state", "implementation");
  f.fails(/needs a pr/, "--task", "issue-1", "--state", "review");
  f.ok("--task", "issue-1", "--state", "review", "--pr", pull(2), "--head", sha("a"));
  f.ok("--task", "issue-1", "--state", "implementation", "--note", "findings");
  f.ok("--task", "issue-1", "--state", "review");
  const task = (await f.read()).tasks[0];
  assert.deepEqual(task.history.map((item) => item.state),
    ["initial", "investigation", "implementation", "review", "implementation", "review"]);
  assert.equal(task.history[1].note, "go");
  const { cyclesOf, entered } = await import("./factory-data.mjs");
  assert.equal(cyclesOf(task), 1);
  assert.equal(entered(task), task.history.at(-1).at);
});

test("a rejected move leaves the file unchanged", async (t) => {
  const f = await started(t);
  const before = await readFile(f.file, "utf8");
  f.fails(/cannot move/, "--task", "issue-1", "--state", "review");
  assert.equal(await readFile(f.file, "utf8"), before);
  assert.deepEqual(await readdir(f.directory), ["owner.repo-factory.json"]);
});

test("blocked needs a reason that is cleared on leaving; resolved needs an outcome", async (t) => {
  const f = await started(t);
  f.fails(/needs --blocker/, "--task", "issue-1", "--state", "blocked");
  f.ok("--task", "issue-1", "--state", "blocked", "--blocker", "Need a decision");
  const blocked = (await f.read()).tasks[0];
  assert.equal(blocked.blocker.from, "initial");
  assert.equal(blocked.blocker.reason, "Need a decision");
  f.ok("--task", "issue-1", "--state", "investigation");
  assert.equal((await f.read()).tasks[0].blocker, null);
  f.fails(/needs --resolution/, "--task", "issue-1", "--state", "resolved");
  f.ok("--task", "issue-1", "--state", "resolved", "--resolution", "duplicate", "--note", "Same as 9");
  const resolved = (await f.read()).tasks[0];
  assert.equal(resolved.resolution.outcome, "duplicate");
  assert.equal(resolved.resolution.note, "Same as 9");
});

test("a task can be reopened unless it was merged", async (t) => {
  const f = await started(t);
  f.ok("--task", "issue-1", "--state", "resolved", "--resolution", "completed");
  f.ok("--task", "issue-1", "--state", "initial");
  const reopened = (await f.read()).tasks[0];
  assert.equal(reopened.resolution, null);
  f.ok("--task", "issue-1", "--state", "resolved", "--resolution", "merged");
  f.fails(/was merged/, "--task", "issue-1", "--state", "initial");
});

test("a new head clears the merge authorization and a stale one is rejected", async (t) => {
  const f = await started(t);
  f.ok("--task", "issue-1", "--state", "investigation");
  f.ok("--task", "issue-1", "--state", "implementation");
  f.ok("--task", "issue-1", "--state", "review", "--pr", pull(2), "--head", sha("a"));
  const merge = {
    authorized_by: "owner", source: "comment", evidence: `${pull(2)}#issuecomment-1`,
    authorized_at: "2026-05-01T12:00:00Z", head: sha("a"),
  };
  f.fails(/not the current head/, "--task", "issue-1", "--merge", JSON.stringify({ ...merge, head: sha("b") }));
  f.ok("--task", "issue-1", "--merge", JSON.stringify(merge));
  assert.equal((await f.read()).tasks[0].merge.head, sha("a"));
  f.ok("--task", "issue-1", "--head", sha("b"));
  assert.equal((await f.read()).tasks[0].merge, null);
  f.fails(/merge.source/, "--task", "issue-1", "--merge", JSON.stringify({ ...merge, head: sha("b"), source: "worker-session" }));
});

test("workers merge by role and a null role clears it", async (t) => {
  const f = await started(t);
  f.ok("--task", "issue-1", "--workers", JSON.stringify({ investigation: { status: "running", pane: "p1" } }));
  f.ok("--task", "issue-1", "--workers", JSON.stringify({ investigation: { status: "closed" }, implementation: { status: "running" } }));
  const { workers } = (await f.read()).tasks[0];
  assert.equal(workers.investigation.status, "closed");
  assert.equal(workers.investigation.pane, "p1");
  f.ok("--task", "issue-1", "--workers", JSON.stringify({ investigation: null }));
  assert.equal((await f.read()).tasks[0].workers.investigation, null);
  f.fails(/status must be one of/, "--task", "issue-1", "--workers", JSON.stringify({ review: { status: "sleeping" } }));
});

test("Lever merge decisions are head-bound while standing grants survive a new head", async (t) => {
  const f = await started(t);
  const lever = {
    effective_level: "L4",
    grants: [{
      grant: "Merge this project's PRs when green.",
      who: "owner", source: "operator", scope: "owner/repo", level: "L4",
      granted_at: "2026-05-01T12:00:00Z", expires: "end of run",
    }],
  };
  const merge = {
    authorized_by: "owner", source: "lever", evidence: "details.lever.grants[0]; may_merge allowed at L4",
    authorized_at: "2026-05-01T12:00:00Z", head: sha("a"),
  };
  f.ok("--task", "issue-1", "--pr", pull(2), "--head", sha("a"),
    "--details", JSON.stringify({ lever }), "--merge", JSON.stringify(merge));
  assert.deepEqual((await f.read()).tasks[0].merge, merge);
  f.ok("--task", "issue-1", "--head", sha("b"));
  const task = (await f.read()).tasks[0];
  assert.equal(task.merge, null);
  assert.deepEqual(task.details.lever, lever);
  f.fails(/not the current head/, "--task", "issue-1", "--merge", JSON.stringify(merge));
  assert.deepEqual((await f.read()).tasks[0], task);
});

test("one issue or PR belongs to one task", async (t) => {
  const f = await started(t);
  f.fails(/Duplicate issue URL/, "--task", "issue-2", "--title", "x", "--next-action", "y", "--issue", issue(1));
});

test("adding a task removes resolved tasks older than seven days", async (t) => {
  const f = await started(t);
  const old = "2020-01-01T00:00:00Z";
  f.ok("--task", "old", "--title", "Old", "--issue", issue(7), "--next-action", "none", "--task-updated-at", old);
  f.ok("--task", "old", "--state", "resolved", "--resolution", "completed", "--task-updated-at", old);
  f.ok("--task", "issue-3", "--title", "New", "--issue", issue(3), "--next-action", "go");
  assert.deepEqual((await f.read()).tasks.map((task) => task.id), ["issue-1", "issue-3"]);
});

test("usage errors exit 2 and malformed JSON flags exit 1", async (t) => {
  const f = await started(t);
  assert.equal(f.run("--title", "x").status, 2);
  assert.equal(f.run().status, 2);
  f.fails(/Unexpected token|JSON/, "--task", "issue-1", "--links", "{");
});

test("hopsSince lists history moves after a time, oldest first, with null for creation", async () => {
  const { hopsSince, countByState } = await import("./factory-data.mjs");
  const tasks = example.tasks;
  const hops = hopsSince(tasks, "2026-05-01T11:00:00Z");
  assert.deepEqual(hops.map((hop) => [hop.id, hop.from, hop.to]), [
    ["issue-12", null, "initial"],
    ["issue-7", "implementation", "review"],
    ["issue-9", "investigation", "implementation"],
  ]);
  assert.deepEqual(countByState(tasks), {
    initial: 1, investigation: 0, implementation: 1, review: 1, blocked: 1, resolved: 1,
  });
});
