const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");

const script = join(__dirname, "migrate.mjs");
const at = "2026-05-01T10:00:00Z";
const later = "2026-05-01T11:00:00Z";
const pull = (n) => `https://github.com/owner/repo/pull/${n}`;
const sha = "a".repeat(40);

const handoff = (role, tasks) => ({
  id: `owner.repo-${role}`, project: "owner/repo", role, goal: "Old goal", status: "active", updated_at: at, tasks,
});
const old = (id, status, extra = {}) => ({
  id, goal: `Goal of ${id}`, status, updated_at: at, next_action: "Do it", ...extra,
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "factory-migrate-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const save = (name, data) => writeFile(join(directory, name), JSON.stringify(data));
  await save("owner.repo-implementer.json", handoff("implementer", [
    old("issue-1", "running", { pr: pull(10), details: { pane_id: "p1", session_id: "s1", worktree_path: "/w/1" } }),
    old("issue-2", "pending"),
    old("issue-3", "done", { pr: pull(30) }),
    old("issue-4", "blocked", { blocker: "Needs a token" }),
    old("task-a", "pending"),
  ]));
  await save("owner.repo-coordinator.json", handoff("coordinator", [
    old("fix-login", "running", { updated_at: later, pr: pull(10), links: ["https://github.com/owner/repo/issues/1"] }),
    old("task-a", "pending", { goal: "A different job" }),
  ]));
  await save("owner.repo-reviewer.json", handoff("reviewer", [
    old("pr-10", "running", { pr: pull(10), lastReviewedHead: sha, brief: "review-10-brief.md", result: "review-10-result.json" }),
    old("pr-99", "done", { pr: pull(99) }),
  ]));
  return {
    directory,
    run: (...args) => spawnSync(process.execPath, [script, "--project", "owner/repo", "--directory", directory, ...args], { encoding: "utf8" }),
    read: async () => JSON.parse(await readFile(join(directory, "owner.repo-factory.json"), "utf8")),
  };
}

test("maps, joins, renames, and attaches reviews from the legacy handoffs", async (t) => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.tasks, 6);
  assert.deepEqual(summary.by_state, { initial: 3, investigation: 0, implementation: 1, review: 0, blocked: 1, resolved: 1 });
  assert.equal(summary.reviewer_attached, 1);
  assert.equal(summary.reviewer_skipped, 1);

  const data = await f.read();
  const { validate } = await import("./factory-data.mjs");
  validate(data);
  assert.equal(data.id, "owner.repo-factory");
  const byId = Object.fromEntries(data.tasks.map((task) => [task.id, task]));

  assert.deepEqual(Object.keys(byId).sort(),
    ["coordinator-task-a", "fix-login", "issue-2", "issue-3", "issue-4", "task-a"]);
  const joined = byId["fix-login"];
  assert.equal(joined.state, "implementation");
  assert.equal(joined.issue, "https://github.com/owner/repo/issues/1");
  assert.equal(joined.pr, pull(10));
  assert.equal(joined.details.legacy_merged.length, 1);
  assert.equal(joined.details.legacy_merged[0].task.id, "issue-1");
  assert.equal(joined.reviewed_head, sha);
  assert.equal(joined.workers.review.result, "review-10-result.json");
  assert.equal(joined.workers.implementation.pane, "p1");
  assert.equal(joined.workers.implementation.session, "s1");
  assert.equal(joined.workers.implementation.status, "unknown");
  assert.equal(joined.worktree.path, "/w/1");
  assert.equal(joined.worktree.created_by_run, false);

  assert.equal(byId["issue-2"].state, "initial");
  assert.equal(byId["issue-2"].issue, "https://github.com/owner/repo/issues/2");
  assert.equal(byId["issue-3"].state, "resolved");
  assert.equal(byId["issue-3"].resolution.outcome, "completed");
  assert.equal(byId["issue-4"].state, "blocked");
  assert.equal(byId["issue-4"].blocker.reason, "Needs a token");
  assert.equal(byId["task-a"].title, "Goal of task-a");
  assert.equal(byId["coordinator-task-a"].title, "A different job");
  assert.deepEqual(summary.renamed, [{ from: "task-a", to: "coordinator-task-a", role: "coordinator" }]);
});

test("dry run writes nothing; a live legacy lock stops a real run", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.directory, "owner.repo-implementer.lock"));
  const dry = f.run("--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(JSON.parse(dry.stdout).warnings[0], /Legacy owner lock exists/);
  assert.ok(!(await readdir(f.directory)).includes("owner.repo-factory.json"));

  const blocked = f.run();
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Legacy owner lock exists/);
  assert.ok(!(await readdir(f.directory)).includes("owner.repo-factory.json"));

  assert.equal(f.run("--ignore-locks").status, 0);
  assert.ok((await readdir(f.directory)).includes("owner.repo-factory.json"));
});

test("never overwrites a factory file", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run().status, 0);
  const before = await readFile(join(f.directory, "owner.repo-factory.json"), "utf8");
  const again = f.run();
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
  assert.equal(await readFile(join(f.directory, "owner.repo-factory.json"), "utf8"), before);
});

test("--archive moves only the implementer and coordinator sources", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run("--archive").status, 0);
  const files = await readdir(f.directory);
  assert.ok(files.includes("owner.repo-reviewer.json"));
  assert.ok(files.includes("owner.repo-factory.json"));
  assert.ok(!files.includes("owner.repo-implementer.json"));
  assert.ok(!files.includes("owner.repo-coordinator.json"));
  const archived = await readdir(join(f.directory, "archive", `${new Date().toISOString().slice(0, 10)}-factory-migration`));
  assert.deepEqual(archived.sort(), ["owner.repo-coordinator.json", "owner.repo-implementer.json"]);
});

test("fails on a missing project argument and on a project without legacy handoffs", async (t) => {
  const f = await fixture(t);
  const usage = spawnSync(process.execPath, [script, "--directory", f.directory], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  const none = spawnSync(process.execPath, [script, "--project", "other/thing", "--directory", f.directory], { encoding: "utf8" });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /No implementer or coordinator handoff/);
});
