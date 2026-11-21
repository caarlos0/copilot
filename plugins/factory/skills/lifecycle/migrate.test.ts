import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";

const script = join(import.meta.dirname, "factory.mjs");
const at = "2026-05-01T10:00:00Z";
const later = "2026-05-01T11:00:00Z";
const pull = (n: number) => `https://github.com/owner/repo/pull/${n}`;
const sha = "a".repeat(40);

const handoff = (role: string, tasks: unknown[]) => ({
  id: `owner.repo-${role}`, project: "owner/repo", role, goal: "Old goal", status: "active", updated_at: at, tasks,
});
const old = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, goal: `Goal of ${id}`, status, updated_at: at, next_action: "Do it", ...extra,
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "factory-migrate-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const save = (name: string, data: unknown) => writeFile(join(directory, name), JSON.stringify(data));
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
    run: (...args: string[]) => spawnSync(process.execPath, [script, "migrate", "--project", "owner/repo", "--directory", directory, ...args], { encoding: "utf8" }),
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
  assert.deepEqual(data.budget, { max_parallel_workers: 10 });
  const byId = Object.fromEntries(data.tasks.map((task: { id: string }) => [task.id, task]));

  assert.deepEqual(Object.keys(byId).sort(),
    ["coordinator-task-a", "fix-login", "issue-2", "issue-3", "issue-4", "task-a"]);
  const joined = byId["fix-login"];
  assert.equal(joined.state, "implementation");
  assert.equal(joined.issue, "https://github.com/owner/repo/issues/1");
  assert.equal(joined.pr, pull(10));
  assert.equal(joined.details.legacy_merged.length, 1);
  assert.deepEqual(joined.details.legacy_merged[0], {
    role: "implementer", file: join(f.directory, "owner.repo-implementer.json"), status: "running", task_id: "issue-1",
  });
  assert.deepEqual(joined.details.legacy, {
    role: "coordinator", file: join(f.directory, "owner.repo-coordinator.json"), status: "running", task_id: "fix-login",
  });
  assert.deepEqual(joined.details.legacy_reviewer, {
    role: "reviewer", file: join(f.directory, "owner.repo-reviewer.json"), status: "running", task_id: "pr-10",
  });
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

test("keeps a reference to the old task, not a copy, and still reads its fields", async (t) => {
  const f = await fixture(t);
  const big = "x".repeat(100_000);
  await writeFile(join(f.directory, "owner.repo-implementer.json"), JSON.stringify(handoff("implementer", [
    old("issue-7", "running", {
      pr: pull(7),
      brief: "b.md",
      result: "r.json",
      details: {
        ref: "owner/repo#7", pane_id: "p7", window_id: "w7", session_id: "s7", session_title: "Title",
        worktree_path: "/w/7", worktree_created_by_run: true, log: big,
      },
    }),
  ])));
  await rm(join(f.directory, "owner.repo-coordinator.json"));
  await rm(join(f.directory, "owner.repo-reviewer.json"));

  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const raw = await readFile(join(f.directory, "owner.repo-factory.json"), "utf8");
  assert.ok(raw.length < 10_000, `factory file is ${raw.length} bytes`);
  const [task] = JSON.parse(raw).tasks;
  assert.deepEqual(Object.keys(task.details.legacy).sort(), ["file", "role", "status", "task_id"]);
  assert.equal(task.issue, "https://github.com/owner/repo/issues/7");
  assert.equal(task.pr, pull(7));
  assert.deepEqual(task.workers.implementation, {
    status: "unknown", mode: "continuous", session: "s7", pane: "p7", window: "w7", name: "Title", brief: "b.md", result: "r.json",
  });
  assert.deepEqual(task.worktree, { path: "/w/7", created_by_run: true });
});

test("joins every matching task when a record bridges an issue and a PR", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "owner.repo-implementer.json"), JSON.stringify(handoff("implementer", [
    old("issue-42", "pending"),
    old("pr-work", "pending", { pr: pull(99), updated_at: "2026-05-01T10:01:00Z" }),
  ])));
  await writeFile(join(f.directory, "owner.repo-coordinator.json"), JSON.stringify(handoff("coordinator", [
    old("linked-work", "pending", {
      pr: pull(99),
      updated_at: "2026-05-01T10:02:00Z",
      links: ["https://github.com/owner/repo/issues/42"],
    }),
  ])));

  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).tasks, 1);

  const [joined] = (await f.read()).tasks;
  assert.equal(joined.id, "linked-work");
  assert.equal(joined.issue, "https://github.com/owner/repo/issues/42");
  assert.equal(joined.pr, pull(99));
  assert.deepEqual(
    [joined.details.legacy, ...joined.details.legacy_merged].map((legacy) => legacy.task_id).sort(),
    ["issue-42", "linked-work", "pr-work"],
  );
});

test("joins twins whose URLs differ only by query or fragment", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "owner.repo-implementer.json"), JSON.stringify(handoff("implementer", [
    old("first", "pending", { pr: pull(5) }),
    old("second", "pending", { pr: `${pull(5)}?x=1`, updated_at: later }),
    old("third", "pending", { pr: `${pull(5)}#issuecomment-1`, updated_at: "2026-05-01T12:00:00Z" }),
  ])));
  await rm(join(f.directory, "owner.repo-coordinator.json"));
  await rm(join(f.directory, "owner.repo-reviewer.json"));

  const result = f.run("--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).tasks, 1);
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

test("--archive checks every destination before writing anything", async (t) => {
  const f = await fixture(t);
  const archive = join(f.directory, "archive", `${new Date().toISOString().slice(0, 10)}-factory-migration`);
  await mkdir(archive, { recursive: true });
  await writeFile(join(archive, "owner.repo-coordinator.json"), "{}");
  const result = f.run("--archive");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already exists; archive by hand/);
  const files = await readdir(f.directory);
  assert.ok(!files.includes("owner.repo-factory.json"));
  assert.ok(files.includes("owner.repo-implementer.json"));
  assert.ok(files.includes("owner.repo-coordinator.json"));
  assert.deepEqual(await readdir(archive), ["owner.repo-coordinator.json"]);
});

test("fails on a missing project argument and on a project without legacy handoffs", async (t) => {
  const f = await fixture(t);
  const usage = spawnSync(process.execPath, [script, "migrate", "--directory", f.directory], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  const none = spawnSync(process.execPath, [script, "migrate", "--project", "other/thing", "--directory", f.directory], { encoding: "utf8" });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /No implementer or coordinator handoff/);
});

test("reads each handoff from the new directory, else the legacy one, and writes to the new one", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "factory-migrate-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const legacy = join(home, ".local/state/copilot-coordinator");
  const current = join(home, ".local/state/copilot-factory");
  await mkdir(legacy, { recursive: true });
  await mkdir(current, { recursive: true });
  await writeFile(join(legacy, "owner.repo-implementer.json"), JSON.stringify(handoff("implementer", [old("old-1", "pending")])));
  await writeFile(join(current, "owner.repo-coordinator.json"), JSON.stringify(handoff("coordinator", [old("new-1", "pending")])));
  const result = spawnSync(process.execPath, [script, "migrate", "--project", "owner/repo"], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).tasks, 2);
  assert.deepEqual(await readdir(legacy), ["owner.repo-implementer.json"]);
  assert.ok((await readdir(current)).includes("owner.repo-factory.json"));
});
