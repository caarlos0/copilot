const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } = require("node:fs/promises");
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
  assert.deepEqual(await readdir(f.directory), ["owner.repo-factory-events.jsonl", "owner.repo-factory.json"]);
});

test("the shipped example is a valid factory", async () => {
  const { validate } = await import("./factory-data.mjs");
  validate(example);
});

test("a new task needs --issue; null is accepted only on purpose", async (t) => {
  const f = await started(t);
  f.fails(/needs --issue/, "--task", "issue-2", "--title", "x", "--next-action", "y");
  f.ok("--task", "issue-2", "--title", "x", "--next-action", "y", "--issue", "null");
});

test("a task without an issue moves through every state and merges without a pr", async (t) => {
  const f = await started(t);
  f.ok("--task", "favicon", "--title", "Add a favicon", "--issue", "null", "--next-action", "Start");
  f.ok("--task", "favicon", "--state", "investigation");
  f.ok("--task", "favicon", "--state", "implementation");
  f.ok("--task", "favicon", "--state", "review", "--head", sha("a"));
  const merge = {
    authorized_by: "owner", source: "lever", evidence: "may_merge allowed at L4",
    authorized_at: "2026-05-01T12:00:00Z", head: sha("a"),
  };
  f.ok("--task", "favicon", "--merge", JSON.stringify(merge));
  f.ok("--task", "favicon", "--state", "resolved", "--resolution", "merged",
    "--details", JSON.stringify({ merge_commit: sha("b") }));
  const task = (await f.read()).tasks.find((item) => item.id === "favicon");
  assert.deepEqual(task.history.map((item) => item.state),
    ["initial", "investigation", "implementation", "review", "resolved"]);
  assert.equal(task.pr, null);
  assert.equal(task.details.merge_commit, sha("b"));
  f.fails(/needs a pr/, "--task", "issue-1", "--head", sha("c"),
    "--merge", JSON.stringify({ ...merge, head: sha("c") }));
});

test("moves follow the flow and each move adds history", async (t) => {
  const f = await started(t);
  f.fails(/cannot move from initial to review/, "--task", "issue-1", "--state", "review");
  f.fails(/cannot move from initial to review/, "--task", "issue-1", "--state", "review", "--pr", "null");
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

test("byRecency sorts newest first, breaks ties by id, and keeps the input", async () => {
  const { byRecency } = await import("./factory-data.mjs");
  const at = (id, time) => ({ id, history: time ? [{ at: "2020-01-01T00:00:00Z" }, { at: time }] : [] });
  const tasks = [
    at("b", "2026-01-02T00:00:00Z"),
    at("c", "2026-01-03T00:00:00Z"),
    at("a", "2026-01-02T00:00:00Z"),
    at("none", null),
  ];
  assert.deepEqual(byRecency(tasks).map((task) => task.id), ["c", "a", "b", "none"]);
  assert.deepEqual(tasks.map((task) => task.id), ["b", "c", "a", "none"]);
});

test("a task with a PR can skip initial: created in review, or moved from initial", async (t) => {
  const f = await started(t);
  f.fails(/only with --pr/, "--task", "pr-5", "--title", "Review it", "--issue", issue(5),
    "--next-action", "Review", "--state", "review");
  f.fails(/only with --pr/, "--task", "pr-5", "--title", "Review it", "--issue", issue(5),
    "--next-action", "Review", "--state", "review", "--pr", "null");
  f.fails(/starts in the initial state/, "--task", "pr-5", "--title", "Review it", "--issue", issue(5),
    "--next-action", "Review", "--state", "implementation", "--pr", pull(5));
  f.ok("--task", "pr-5", "--title", "Review it", "--issue", issue(5), "--next-action", "Review",
    "--state", "review", "--pr", pull(5), "--head", sha("a"));
  const created = (await f.read()).tasks.find((item) => item.id === "pr-5");
  assert.equal(created.state, "review");
  assert.equal(created.pr, pull(5));
  assert.deepEqual(created.history.map((item) => item.state), ["review"]);

  f.ok("--task", "pr-6", "--title", "Review too", "--issue", "null", "--next-action", "Review", "--pr", pull(6));
  f.ok("--task", "pr-6", "--state", "review", "--note", "User gave the PR for review");
  const moved = (await f.read()).tasks.find((item) => item.id === "pr-6");
  assert.deepEqual(moved.history.map((item) => item.state), ["initial", "review"]);

  f.ok("--task", "pr-7", "--title", "And this", "--issue", issue(7), "--next-action", "Review");
  f.ok("--task", "pr-7", "--state", "review", "--pr", pull(7));
  assert.equal((await f.read()).tasks.find((item) => item.id === "pr-7").state, "review");
  f.ok("--task", "issue-1", "--state", "investigation");
  f.fails(/cannot move from investigation to review/, "--task", "issue-1", "--state", "review",
    "--pr", pull(8));
});

test("a rejected move leaves the file unchanged", async (t) => {
  const f = await started(t);
  const before = await readFile(f.file, "utf8");
  f.fails(/cannot move/, "--task", "issue-1", "--state", "review");
  assert.equal(await readFile(f.file, "utf8"), before);
  assert.deepEqual(await readdir(f.directory), ["owner.repo-factory-events.jsonl", "owner.repo-factory.json"]);
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

test("a blocker may carry validated options; plain text and old blockers stay valid", async (t) => {
  const f = await started(t);
  const options = [{ label: "Use token A", state: "implementation", recommended: true }, { label: "Cancel it" }];
  f.ok("--task", "issue-1", "--state", "blocked", "--blocker", JSON.stringify({ reason: "Pick one", options }));
  let blocker = (await f.read()).tasks[0].blocker;
  assert.deepEqual({ ...blocker, since: undefined }, { from: "initial", reason: "Pick one", since: undefined, options });
  f.ok("--task", "issue-1", "--blocker", "Plain reason now");
  blocker = (await f.read()).tasks[0].blocker;
  assert.equal(blocker.reason, "Plain reason now");
  assert.equal(blocker.options, undefined, "Editing with plain text replaces the options.");
  f.ok("--task", "issue-1", "--blocker", JSON.stringify({ reason: "Again", options }));
  f.ok("--task", "issue-1", "--state", "investigation");
  assert.equal((await f.read()).tasks[0].blocker, null);

  const before = await readFile(f.file, "utf8");
  const bad = (reason, blockerValue) => {
    f.fails(reason, "--task", "issue-1", "--state", "blocked", "--blocker", JSON.stringify(blockerValue));
  };
  bad(/reason must be a non-empty string/, { options });
  bad(/unknown keys/, { reason: "R", extra: 1 });
  bad(/1 to 8 options/, { reason: "R", options: [] });
  bad(/1 to 8 options/, { reason: "R", options: Array.from({ length: 9 }, (_, i) => ({ label: `L${i}` })) });
  bad(/label must be a non-empty string/, { reason: "R", options: [{ label: " " }] });
  bad(/at most 300 characters/, { reason: "R", options: [{ label: "x".repeat(301) }] });
  bad(/state must be one of/, { reason: "R", options: [{ label: "A", state: "blocked" }] });
  bad(/recommended must be a boolean/, { reason: "R", options: [{ label: "A", recommended: "yes" }] });
  bad(/at most one recommended/, { reason: "R", options: [{ label: "A", recommended: true }, { label: "B", recommended: true }] });
  assert.equal(await readFile(f.file, "utf8"), before, "Invalid options must not change the file.");
  f.ok("--task", "issue-1", "--state", "blocked", "--blocker", "{not json");
  assert.equal((await f.read()).tasks[0].blocker.reason, "{not json");
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

test("revisions reject stale writes even when timestamps are identical", async (t) => {
  const f = await started(t);
  const before = (await f.read()).tasks[0];
  f.ok("--task", "issue-1", "--expected-revision", String(before.revision),
    "--task-updated-at", before.updated_at, "--next-action", "New direction");
  const changed = await readFile(f.file, "utf8");
  f.fails(/changed since it was read/, "--task", "issue-1", "--expected-revision", String(before.revision),
    "--next-action", "Stale direction");
  assert.equal(await readFile(f.file, "utf8"), changed);
  f.fails(/non-negative safe integer/, "--task", "issue-1", "--expected-revision=-1");
});

test("--expected-revision on a new task is a usage error, not a conflict", async (t) => {
  const f = await started(t);
  const before = await readFile(f.file, "utf8");
  f.fails(/applies only to existing tasks/, "--task", "issue-2", "--title", "Other", "--issue", issue(2),
    "--next-action", "Start", "--expected-revision", "0");
  assert.equal(await readFile(f.file, "utf8"), before);
});

test("dashboard directions must be acknowledged and old worker generations stay fenced", async (t) => {
  const f = await fixture(t, example);
  const { update } = await import("./factory.mjs");
  const task = async () => (await f.read()).tasks.find((item) => item.id === "issue-7");
  const data = await update(f.file, {
    task: "issue-7", state: "implementation", note: "Check the edge case again", "expected-revision": "0",
  }, { operator: true });
  const first = data.tasks.find((item) => item.id === "issue-7");
  f.fails(/needs --expected-revision/, "--task", first.id, "--state", "review");
  f.fails(/feedback is pending/, "--task", first.id, "--expected-revision", "1",
    "--feedback-id", first.feedback.id, "--state", "review");
  f.fails(/only with --task/, "--task", first.id, "--expected-revision", "1",
    "--ack-feedback", first.feedback.id, "--state", "review");
  f.ok("--task", first.id, "--expected-revision", "1", "--ack-feedback", first.feedback.id);
  f.ok("--task", first.id, "--expected-revision", "2", "--feedback-id", first.feedback.id,
    "--state", "review");
  await update(f.file, {
    task: first.id, state: "initial", note: "Start over with the new context", "expected-revision": "3",
  }, { operator: true });
  const second = await task();
  assert.equal(second.feedback.acknowledged_id, first.feedback.id);
  assert.notEqual(second.feedback.id, first.feedback.id);
  const saved = await readFile(f.file, "utf8");
  f.fails(/feedback changed/, "--task", first.id, "--expected-revision", "4", "--ack-feedback", first.feedback.id);
  assert.equal(await readFile(f.file, "utf8"), saved);
  f.ok("--task", first.id, "--expected-revision", "4", "--ack-feedback", second.feedback.id);
  for (const flags of [[], ["--feedback-id", first.feedback.id]]) {
    f.fails(/feedback ID is stale or missing/, "--task", first.id, "--expected-revision", "5",
      "--state", "investigation", ...flags);
  }
  f.ok("--task", first.id, "--expected-revision", "5", "--feedback-id", second.feedback.id,
    "--state", "investigation");
  const final = await task();
  assert.deepEqual(final.history.filter((item) => item.source === "dashboard").map((item) => item.note),
    ["Check the edge case again", "Start over with the new context"]);
  assert.deepEqual(final.workers, first.workers);
});

test("operator moves do not broaden worker transitions or bypass prerequisites", async () => {
  const { checkTransition, operatorStates } = await import("./factory-data.mjs");
  const review = example.tasks.find((item) => item.state === "review");
  assert.deepEqual(operatorStates(review), ["initial", "investigation", "implementation", "resolved"]);
  assert.throws(() => checkTransition(review, "initial"), /cannot move/);
  checkTransition(review, "initial", true);
  const blocked = example.tasks.find((item) => item.state === "blocked");
  assert.deepEqual(operatorStates(blocked), ["initial", "investigation", "implementation", "resolved"]);
  assert.deepEqual(operatorStates({ ...blocked, issue: null }),
    ["initial", "investigation", "implementation", "review", "resolved"]);
  assert.deepEqual(operatorStates({ ...blocked, pr: pull(99) }),
    ["initial", "investigation", "implementation", "review", "resolved"]);
  assert.deepEqual(operatorStates(example.tasks.find((item) => item.state === "resolved")), []);
});

test("the Unblock popup preselects the blocked-from state and fills option text verbatim", async () => {
  const { unblockState, unblockChoice, validate } = await import("./factory-data.mjs");
  const blocked = example.tasks.find((item) => item.state === "blocked");
  assert.deepEqual(blocked.blocker.options.map((option) => option.label),
    ["Add the docs token to the CI secrets", "Skip the docs build in CI"]);
  assert.equal(unblockState(blocked), "investigation");
  const review = { ...blocked, blocker: { ...blocked.blocker, from: "review" } };
  assert.equal(unblockState(review), "initial", "review needs a PR on an issue task, so fall back to the first state");
  assert.equal(unblockState({ ...review, issue: null }), "review");
  const [recommended, plain] = blocked.blocker.options;
  assert.deepEqual(unblockChoice(blocked, recommended), { state: "implementation", comment: recommended.label });
  assert.deepEqual(unblockChoice(blocked, plain), { state: "investigation", comment: plain.label });
  assert.equal(unblockChoice(review, { label: "Go to review", state: "review" }).state, "initial",
    "a state that the task cannot move to is ignored");
  const old = structuredClone(example);
  delete old.tasks.find((item) => item.state === "blocked").blocker.options;
  validate(old);
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

test("investigation is one-shot and read-only", async (t) => {
  const f = await started(t);
  const worktree = JSON.stringify({ path: "/tmp/wt", created_by_run: true });
  f.ok("--task", "issue-1", "--state", "investigation");
  f.fails(/one-shot and read-only/, "--task", "issue-1", "--workers",
    JSON.stringify({ investigation: { status: "unknown", mode: "continuous" } }));
  f.fails(/one-shot and read-only/, "--task", "issue-1", "--workers",
    JSON.stringify({ investigation: { status: "unknown", worktree: "/tmp/wt" } }));
  f.fails(/no worktree/, "--task", "issue-1", "--worktree", worktree);
  f.ok("--task", "issue-1", "--workers",
    JSON.stringify({ investigation: { status: "unknown", mode: "one-shot" } }));
  f.ok("--task", "issue-1", "--state", "implementation", "--worktree", worktree,
    "--workers", JSON.stringify({ implementation: { status: "unknown", mode: "continuous" } }));
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

test("issue and PR identity ignores query and fragment without changing evidence links", async (t) => {
  const f = await started(t);
  const evidence = `${issue(1)}#issuecomment-123`;
  f.fails(/Duplicate issue URL/, "--task", "issue-2", "--title", "x", "--next-action", "y",
    "--issue", evidence);
  f.ok("--task", "issue-2", "--title", "x", "--next-action", "y", "--issue", issue(2), "--pr", pull(99),
    "--links", JSON.stringify([evidence]));
  f.fails(/Duplicate pr URL/, "--task", "issue-3", "--title", "x", "--next-action", "y",
    "--issue", issue(3), "--pr", `${pull(99)}?diff=split`);
  assert.deepEqual((await f.read()).tasks.find((task) => task.id === "issue-2").links, [evidence]);
});

const archiveFile = (f, day) => join(f.directory, "owner.repo-factory-archive", `${day}.json`);

async function withArchived(t) {
  const f = await started(t);
  const old = "2020-01-01T00:00:00Z";
  f.ok("--task", "old", "--title", "Old", "--issue", issue(7), "--pr", pull(70), "--next-action", "none", "--task-updated-at", old);
  f.ok("--task", "old", "--state", "resolved", "--resolution", "completed", "--task-updated-at", old);
  f.ok("--task", "issue-3", "--title", "New", "--issue", issue(3), "--next-action", "go");
  return f;
}

test("adding a task archives resolved tasks older than seven days by day", async (t) => {
  const f = await withArchived(t);
  assert.deepEqual((await f.read()).tasks.map((task) => task.id), ["issue-1", "issue-3"]);
  const day = JSON.parse(await readFile(archiveFile(f, "2020-01-01"), "utf8"));
  assert.deepEqual([day.format, day.project, day.day], ["factory-archive/v1", "owner/repo", "2020-01-01"]);
  assert.deepEqual(day.tasks.map((task) => task.id), ["old"]);
  assert.equal((await stat(archiveFile(f, "2020-01-01"))).mode & 0o777, 0o600);
});

test("saving an archived task twice keeps one copy", async (t) => {
  const f = await withArchived(t);
  const { archiveDirectory, readArchive, saveArchive } = await import("./archive.mjs");
  const directory = archiveDirectory(f.file);
  const [{ tasks }] = await readArchive(directory, "owner/repo");
  await saveArchive(directory, "owner/repo", tasks);
  const days = await readArchive(directory, "owner/repo");
  assert.deepEqual(days.map((day) => day.tasks.map((task) => task.id)), [["old"]]);
});

test("a new task that matches archived work is refused until the user decides", async (t) => {
  const f = await withArchived(t);
  const before = await readFile(f.file, "utf8");
  const archived = /matches archived work[\s\S]*old "Old" \(completed, archived 2020-01-01, revision \d+\)[\s\S]*--restore/;
  f.fails(archived, "--task", "old", "--title", "Again", "--issue", issue(90), "--next-action", "x");
  f.fails(archived, "--task", "other", "--title", "Same issue", "--issue", issue(7), "--next-action", "x");
  f.fails(archived, "--task", "other", "--title", "Issue variant", "--issue", `${issue(7)}#issuecomment-123`, "--next-action", "x");
  f.fails(archived, "--task", "other", "--title", "Same PR", "--issue", issue(91), "--pr", pull(70), "--next-action", "x");
  f.fails(archived, "--task", "other", "--title", "PR variant", "--issue", issue(91), "--pr", `${pull(70)}?diff=split`, "--next-action", "x");
  assert.equal(await readFile(f.file, "utf8"), before);
  f.ok("--task", "linked", "--title", "Only linked", "--issue", issue(92), "--next-action", "x", "--links", JSON.stringify([issue(7)]));
});

test("restore brings an archived task back to initial and removes its archive copy", async (t) => {
  const f = await withArchived(t);
  f.fails(/needs --task ID, --state initial, and --note WHY/, "--task", "old", "--restore", "--state", "initial");
  f.fails(/not in the archive/, "--task", "nope", "--restore", "--state", "initial", "--note", "x");
  f.fails(/is live/, "--task", "issue-1", "--restore", "--state", "initial", "--note", "x");
  const archived = JSON.parse(await readFile(archiveFile(f, "2020-01-01"), "utf8")).tasks[0];
  f.fails(/changed since it was read/, "--task", "old", "--restore", "--state", "initial", "--note", "x",
    "--expected-revision", String(archived.revision + 1));
  f.ok("--task", "old", "--restore", "--state", "initial", "--note", "User wants it again",
    "--expected-revision", String(archived.revision));
  const task = (await f.read()).tasks.find((item) => item.id === "old");
  assert.equal(task.state, "initial");
  assert.equal(task.resolution, null);
  assert.equal(task.revision, archived.revision + 1);
  assert.equal(task.history.at(-1).note, "User wants it again");
  await assert.rejects(stat(archiveFile(f, "2020-01-01")), { code: "ENOENT" });
});

test("a merged archived task is not restored", async (t) => {
  const f = await fixture(t, {
    ...example,
    tasks: example.tasks.map((task) => task.id === "issue-3" ? { ...task, updated_at: "2020-01-01T00:00:00Z" } : task),
  });
  f.ok("--task", "issue-20", "--title", "Next", "--issue", issue(20), "--next-action", "go");
  f.fails(/cannot be reopened/, "--task", "again", "--title", "Again", "--issue", issue(3), "--next-action", "x");
  f.fails(/was merged/, "--task", "issue-3", "--restore", "--state", "initial", "--note", "x");
  assert.equal(JSON.parse(await readFile(archiveFile(f, "2020-01-01"), "utf8")).tasks[0].id, "issue-3");
  assert.equal((await f.read()).tasks.some((task) => task.id === "issue-3"), false);
});

test("archive write failures never lose a task or half-apply a restore", async (t) => {
  if (process.getuid?.() === 0) return t.skip("File permissions do not block root.");
  const f = await started(t);
  const old = "2020-01-01T00:00:00Z";
  f.ok("--task", "old", "--title", "Old", "--issue", issue(7), "--next-action", "none", "--task-updated-at", old);
  f.ok("--task", "old", "--state", "resolved", "--resolution", "completed", "--task-updated-at", old);
  const directory = join(f.directory, "owner.repo-factory-archive");
  await mkdir(directory, { mode: 0o700 });
  try {
    await chmod(directory, 0o500);
    const before = await readFile(f.file, "utf8");
    f.fails(/EACCES/, "--task", "issue-3", "--title", "New", "--issue", issue(3), "--next-action", "go");
    assert.equal(await readFile(f.file, "utf8"), before);
    assert.deepEqual((await readdir(f.directory)).sort(), ["owner.repo-factory-archive", "owner.repo-factory-events.jsonl", "owner.repo-factory.json"]);

    await chmod(directory, 0o700);
    f.ok("--task", "issue-3", "--title", "New", "--issue", issue(3), "--next-action", "go");
    await chmod(directory, 0o500);
    f.fails(/restored, but its archive copy was not removed/, "--task", "old", "--restore", "--state", "initial", "--note", "again");
    assert.equal((await f.read()).tasks.find((task) => task.id === "old").state, "initial");
  } finally {
    await chmod(directory, 0o700);
  }
});

test("pending dashboard resolution comments survive pruning until acknowledged", async (t) => {
  const f = await started(t);
  const { update } = await import("./factory.mjs");
  const old = "2020-01-01T00:00:00Z";
  const before = (await f.read()).tasks[0];
  await update(f.file, {
    task: before.id, state: "resolved", resolution: "completed", note: "Handled outside the factory.",
    "expected-revision": String(before.revision), "task-updated-at": old,
  }, { operator: true });
  f.ok("--task", "issue-2", "--title", "Next", "--issue", issue(2), "--next-action", "go");
  const pending = (await f.read()).tasks.find((task) => task.id === before.id);
  assert.ok(pending, "An unread operator comment must not be pruned.");
  assert.equal(pending.history.at(-1).note, "Handled outside the factory.");
  f.ok("--task", pending.id, "--expected-revision", String(pending.revision), "--ack-feedback", pending.feedback.id);
  f.ok("--task", pending.id, "--expected-revision", String(pending.revision + 1),
    "--feedback-id", pending.feedback.id, "--task-updated-at", old);
  f.ok("--task", "issue-3", "--title", "More", "--issue", issue(3), "--next-action", "go");
  assert.deepEqual((await f.read()).tasks.map((task) => task.id), ["issue-2", "issue-3"]);
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

const search = { id: "bugs", description: "Open bugs.", kind: "search", query: "is:issue is:open label:bug",
  every: "30m", enabled: true, last_run_at: null };

test("rules need a known kind, a query for search, and a valid interval", async (t) => {
  const f = await started(t);
  const rules = (rule) => ["--rules", JSON.stringify([{ ...search, ...rule }])];
  f.fails(/Rule bugs query/, ...rules({ query: null }));
  f.fails(/Rule bugs kind/, ...rules({ kind: "other" }));
  f.fails(/every must look like/, ...rules({ every: "30 minutes" }));
  f.fails(/every must look like/, ...rules({ every: "0m" }));
  f.fails(/Rule bugs worker\.status/, ...rules({ worker: { status: "gone" } }));
  f.ok("--rules", JSON.stringify([{ id: "old", description: "Legacy.", query: null, enabled: true, last_run_at: null }]));
  f.ok(...rules({ worker: { status: "closed", mode: "one-shot", result: "owner.repo-bugs-result.json" } }));
  assert.equal((await f.read()).rules[0].every, "30m");
});

test("--rule stamps the run time and records or clears the rule worker", async (t) => {
  const f = await started(t);
  f.ok("--rules", JSON.stringify([search, { ...search, id: "other" }]));
  const before = await f.read();
  f.fails(/need --rule ID/, "--ran");
  f.fails(/need --rule ID/, "--rule-worker", "null");
  f.fails(/needs --ran or --rule-worker/, "--rule", "bugs");
  f.fails(/Unknown rule: nope/, "--rule", "nope", "--ran");
  f.fails(/Rule bugs worker\.status/, "--rule", "bugs", "--rule-worker", '{"status":"gone"}');
  assert.deepEqual(await f.read(), before, "A refused write must not change the factory.");

  f.ok("--rule", "bugs", "--ran", "--updated-at", "2026-05-01T12:00:00Z");
  let data = await f.read();
  assert.equal(data.updated_at, "2026-05-01T12:00:00Z");
  assert.deepEqual(data.rules.map((rule) => rule.last_run_at), ["2026-05-01T12:00:00Z", null]);

  const worker = { status: "running", mode: "one-shot", session: "7f4c2a90-1d3e-4b5a-9c8d-2e6f0a1b3c4d" };
  f.ok("--rule", "bugs", "--rule-worker", JSON.stringify(worker));
  data = await f.read();
  assert.deepEqual(data.rules[0].worker, worker);
  assert.equal(data.rules[0].last_run_at, "2026-05-01T12:00:00Z", "A worker update must keep the run time.");
  assert.equal(data.rules[1].worker, undefined);
  f.ok("--rule", "bugs", "--rule-worker", "null");
  assert.equal((await f.read()).rules[0].worker, null);
});

test("--ignored replaces the skipped list and accepts only GitHub links", async (t) => {
  const f = await started(t);
  const entry = { url: issue(7), at: "2026-05-01T12:00:00Z", reason: "The user chose to skip it." };
  f.ok("--ignored", JSON.stringify([entry]));
  assert.deepEqual((await f.read()).ignored, [entry]);
  f.fails(/GitHub issue or pull request URL/, "--ignored", JSON.stringify([{ ...entry, url: "https://example.com/1" }]));
  f.fails(/ignored\.reason/, "--ignored", JSON.stringify([{ ...entry, reason: "" }]));
  f.ok("--ignored", "[]");
  assert.deepEqual((await f.read()).ignored, []);
});

test("schedule helpers say what is due, only for an active factory", async () => {
  const { intervalMs, nextRun, dueRules, nextDue } = await import("./factory-data.mjs");
  assert.deepEqual(["30m", "6h", "1d", "9999m"].map(intervalMs), [1_800_000, 21_600_000, 86_400_000, 599_940_000]);
  for (const bad of ["", "0m", "5", "5s", "10000m", "1.5h", " 5m"]) assert.throws(() => intervalMs(bad), /every must look like/, bad);

  const at = Date.parse("2026-05-01T12:00:00Z");
  const rule = (id, extra) => ({ id, enabled: true, last_run_at: null, ...extra });
  const rules = [
    rule("never", { every: "1h" }),
    rule("ran", { every: "1h", last_run_at: "2026-05-01T11:30:00Z" }),
    rule("overdue", { every: "10m", last_run_at: "2026-05-01T11:00:00Z" }),
    rule("off", { every: "1m", enabled: false }),
    rule("manual", {}),
  ];
  assert.deepEqual(rules.map(nextRun), [0, at + 1_800_000, Date.parse("2026-05-01T11:10:00Z"), null, null]);
  const data = (status) => ({ status, rules });
  assert.deepEqual(dueRules(data("active"), at), ["never", "overdue"]);
  assert.equal(nextDue(data("active")), 0);
  assert.deepEqual(dueRules({ status: "active", rules: rules.slice(1, 2) }, at), []);
  assert.equal(nextDue({ status: "active", rules: rules.slice(1, 2) }), at + 1_800_000);
  assert.equal(nextDue({ status: "active", rules: rules.slice(3) }), null);
  for (const status of ["paused", "blocked", "finished"]) {
    assert.deepEqual(dueRules(data(status), at), [], status);
    assert.equal(nextDue(data(status)), null, status);
  }
});

const uuid = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

test("the sessions registry records each factory and worker session once, privately", async (t) => {
  const f = await started(t);
  const registry = join(f.directory, "owner.repo-factory-sessions.jsonl");
  assert.deepEqual(await readdir(f.directory), ["owner.repo-factory-events.jsonl", "owner.repo-factory.json"], "No session means no registry.");
  const lines = async () => (await readFile(registry, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));

  f.ok("--session", uuid(1), "--updated-at", "2026-05-01T12:00:00Z");
  f.ok("--session", uuid(1));
  f.ok("--rules", JSON.stringify([{ ...search, kind: "improve", query: null, id: "self" }, search]));
  f.ok("--rule", "self", "--rule-worker", JSON.stringify({ status: "running", session: `session:${uuid(2)}` }));
  f.ok("--rule", "bugs", "--rule-worker", JSON.stringify({ status: "running", session: uuid(3) }));
  f.ok("--task", "issue-1", "--state", "investigation", "--note", "Go",
    "--workers", JSON.stringify({ investigation: { status: "running", session: uuid(4), pane: "p1" } }));
  f.ok("--task", "issue-1", "--workers", JSON.stringify({ investigation: { status: "idle", session: uuid(4) } }));
  f.ok("--task", "issue-1", "--workers", JSON.stringify({ investigation: { status: "running", session: "not-a-session" } }));

  assert.deepEqual((await lines()).map(({ at, ...entry }) => entry), [
    { id: uuid(1), role: "factory" },
    { id: uuid(2), role: "improver", rule: "self" },
    { id: uuid(3), role: "producer", rule: "bugs" },
    { id: uuid(4), role: "investigation", task: "issue-1" },
  ]);
  assert.equal((await lines())[0].at, "2026-05-01T12:00:00Z");
  assert.equal((await stat(registry)).mode & 0o777, 0o600);

  f.fails(/Task issue-1 cannot move/, "--task", "issue-1", "--state", "review", "--note", "Skip",
    "--workers", JSON.stringify({ review: { status: "running", session: uuid(5) } }));
  f.fails(/--session must be a Copilot session UUID/, "--session", "pane-1");
  assert.equal((await lines()).length, 4, "A refused write must not record a session.");
});
