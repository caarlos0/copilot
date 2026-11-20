import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

type BrokerEvent = { id: string; type: string; task: string | null; source: string; data: any };
type WaitOutput = { events: BrokerEvent[]; cursor: string; timeout?: boolean };

const script = join(import.meta.dirname, "broker.mjs");
const factoryScript = join(import.meta.dirname, "factory.mjs");
const result = { task: "t1", data: JSON.stringify({ role: "implementation", outcome: "complete" }) };

function withResult(directory: string, task: string, data: Record<string, unknown>) {
  const name = `${task}-result.json`;
  writeFileSync(join(directory, name), JSON.stringify({ task, role: data.role, outcome: data.outcome }));
  return { ...data, result: name };
}

// A plain writeFile truncates first, so a waiter can read an empty file; factory.mjs renames too.
async function writeAtomic(path: string, content: string) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temp, content);
  await rename(temp, path);
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "broker-test-"));
  const children: { child: ChildProcess; finished: Promise<unknown> }[] = [];
  t.after(async () => {
    for (const { child } of children) child.kill();
    await Promise.all(children.map(({ finished }) => finished));
    await rm(directory, { recursive: true, force: true });
  });
  const factory = join(directory, "owner.repo-factory.json");
  const log = join(directory, "owner.repo-factory-events.jsonl");
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  // A worker.result needs the saved file it names, so the helper writes a matching one.
  const emit = (type: string, { source, task = "t1", data = result.data }: { source?: string; task?: string; data?: string } = {}): BrokerEvent => {
    if (type === "worker.result") data = JSON.stringify(withResult(directory, task, JSON.parse(data)));
    const out = run("emit", factory, type, "--task", task, "--data", data, ...(source ? ["--source", source] : []));
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  };
  // Resolves with a function that returns the parsed output once the waiter is armed and exits.
  async function wait(...args: string[]): Promise<() => Promise<WaitOutput>> {
    const child = spawn(process.execPath, [script, "wait", factory, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const finished = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
    children.push({ child, finished });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    await new Promise<void>((resolve, reject) => {
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (stderr.includes("Watching events.\n")) resolve();
      });
      child.once("close", () => reject(new Error(`Waiter exited early: ${stderr}`)));
    });
    return async () => {
      const done = await finished;
      assert.equal(done.code, 0, done.stderr);
      return JSON.parse(done.stdout);
    };
  }
  return { directory, factory, log, run, emit, wait };
}

test("wait wakes on an emit and prints the event with a cursor", async (t) => {
  const f = await fixture(t);
  const done = await f.wait();
  const event = f.emit("worker.result");
  const out = await done();
  assert.deepEqual(out.events, [event]);
  assert.equal(event.type, "worker.result");
  assert.equal(event.task, "t1");
  assert.equal(event.source, "worker");
  assert.equal(out.cursor, String((await stat(f.log)).size));
  assert.equal((await stat(f.log)).mode & 0o777, 0o600);
});

test("a cursor never loses events between wait calls", async (t) => {
  const f = await fixture(t);
  const first = f.emit("worker.result");
  const second = f.emit("worker.blocked", { data: JSON.stringify({ role: "review", reason: "stuck" }) });
  let out = await (await f.wait("--since", "0"))();
  assert.deepEqual(out.events.map(({ id }) => id), [first.id, second.id]);

  // Emitted while nobody waits; the next wait returns it at once.
  const third = f.emit("worker.result");
  out = await (await f.wait("--since", out.cursor))();
  assert.deepEqual(out.events.map(({ id }) => id), [third.id]);

  const end = f.run("cursor", f.factory);
  assert.deepEqual(JSON.parse(end.stdout), { cursor: out.cursor });
  const done = await f.wait("--since", out.cursor);
  const fourth = f.emit("worker.result");
  out = await done();
  assert.deepEqual(out.events.map(({ id }) => id), [fourth.id]);
});

test("without --since a wait starts at the end of the log", async (t) => {
  const f = await fixture(t);
  f.emit("worker.result");
  const done = await f.wait();
  const next = f.emit("worker.result");
  assert.deepEqual((await done()).events.map(({ id }) => id), [next.id]);
});

test("--exclude-source skips those events and still advances the cursor", async (t) => {
  const f = await fixture(t);
  const done = await f.wait("--exclude-source", "coordinator");
  f.emit("task.moved", { source: "coordinator", data: JSON.stringify({ to: "review" }) });
  f.emit("task.moved", { source: "coordinator", data: JSON.stringify({ to: "resolved" }) });
  const mine = f.emit("worker.result", { source: "worker" });
  const out = await done();
  assert.deepEqual(out.events.map(({ id }) => id), [mine.id]);
  assert.equal(out.cursor, String((await stat(f.log)).size));

  f.emit("task.moved", { source: "coordinator", data: JSON.stringify({ to: "review" }) });
  const quiet = await f.wait("--since", out.cursor, "--exclude-source", "coordinator", "--timeout", "0.3");
  assert.deepEqual(await quiet(), { events: [], cursor: String((await stat(f.log)).size), timeout: true });
});

test("--timeout exits 0 with no events and the unchanged cursor", async (t) => {
  const f = await fixture(t);
  const out = await (await f.wait("--timeout", "0.2"))();
  assert.deepEqual(out, { events: [], cursor: "0", timeout: true });
});

test("concurrent emitters never interleave or drop lines", async (t) => {
  const f = await fixture(t);
  const count = 24;
  const runs = Array.from({ length: count }, (_, index) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [
      script, "emit", f.factory, "worker.result", "--task", `t${index}`,
      "--data", JSON.stringify(withResult(f.directory, `t${index}`, { role: "implementation", outcome: "working", pad: "x".repeat(2000) })),
    ], { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`emit exited ${code}`))));
  }));
  await Promise.all(runs);
  const events = (await readFile(f.log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(events.map(({ task }) => task).sort(), Array.from({ length: count }, (_, i) => `t${i}`).sort());
  assert.equal(new Set(events.map(({ id }) => id)).size, count);
});

test("emit rejects unknown types and missing data", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run("emit", f.factory, "worker.done", "--task", "t1").status, 2);
  assert.equal(f.run("emit", f.factory, "worker.result", "--data", result.data).status, 2);
  assert.equal(f.run("emit", f.factory, "worker.result", "--task", "t1", "--data", "{}").status, 2);
  const outcome = f.run("emit", f.factory, "worker.result", "--task", "t1", "--data", JSON.stringify({ role: "review", outcome: "done" }));
  assert.equal(outcome.status, 2);
  assert.match(outcome.stderr, /outcome must be one of/);
  assert.equal(f.run("wait", f.factory, "--since", "abc").status, 2);
  assert.equal(f.run("wait", f.factory, "--since", "99", "--timeout", "1").status, 1);
});

test("worker.result is refused unless its result file exists and matches the event", async (t) => {
  const f = await fixture(t);
  const data = { role: "implementation", outcome: "complete", result: "t1-result.json" };
  const refuse = (event: unknown, pattern: RegExp) => {
    const out = f.run("emit", f.factory, "worker.result", "--task", "t1", "--data", JSON.stringify(event));
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stderr, pattern);
  };
  refuse({ role: "implementation", outcome: "complete" }, /must name a result file/);
  refuse({ ...data, result: "../t1-result.json" }, /must name a result file/);
  refuse(data, /not readable JSON/);
  writeFileSync(join(f.directory, "t1-result.json"), "{");
  refuse(data, /not readable JSON/);
  for (const [saved, pattern] of [
    [{ task: "t2", role: "implementation", outcome: "complete" }, /task "t2"/],
    [{ task: "t1", role: "review", outcome: "complete" }, /role "review"/],
    [{ task: "t1", role: "implementation", outcome: "working" }, /outcome "working"/],
  ] as [object, RegExp][]) {
    writeFileSync(join(f.directory, "t1-result.json"), JSON.stringify(saved));
    refuse(data, pattern);
  }
  await assert.rejects(stat(f.log), { code: "ENOENT" });
  writeFileSync(join(f.directory, "t1-result.json"), JSON.stringify({ task: "t1", role: "implementation", outcome: "complete" }));
  const out = f.run("emit", f.factory, "worker.result", "--task", "t1", "--data", JSON.stringify(data));
  assert.equal(out.status, 0, out.stderr);
});

test("worker.blocked checks a named result for outcome blocked, and pr.merged needs a full SHA", async (t) => {
  const f = await fixture(t);
  const blocked = { role: "implementation", reason: "needs a decision" };
  const emitBlocked = (data: unknown) => f.run("emit", f.factory, "worker.blocked", "--task", "t1", "--data", JSON.stringify(data));
  assert.equal(emitBlocked(blocked).status, 0);
  writeFileSync(join(f.directory, "t1-result.json"), JSON.stringify({ task: "t1", role: "implementation", outcome: "complete" }));
  const wrong = emitBlocked({ ...blocked, result: "t1-result.json" });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /outcome "complete"/);
  writeFileSync(join(f.directory, "t1-result.json"), JSON.stringify({ task: "t1", role: "implementation", outcome: "blocked" }));
  assert.equal(emitBlocked({ ...blocked, result: "t1-result.json" }).status, 0);

  const merged = { role: "implementation", pr: "url", merge_commit: "abc123" };
  const short = f.run("emit", f.factory, "pr.merged", "--task", "t1", "--data", JSON.stringify(merged));
  assert.equal(short.status, 1);
  assert.match(short.stderr, /full 40-character SHA/);
});

test("a complete implementation result must report the worktree head, rebased on main unless the task has a PR", async (t) => {
  const f = await fixture(t);
  const git = (cwd: string, ...args: string[]) => {
    const out = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  const repo = join(f.directory, "repo");
  const tree = join(f.directory, "tree");
  const identity = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];
  const commit = (cwd: string, message: string) => git(cwd, ...identity, "commit", "--allow-empty", "-m", message);
  git(f.directory, "init", "-b", "main", repo);
  commit(repo, "base");
  git(repo, "worktree", "add", "-b", "task", tree);
  commit(tree, "work");
  const head = git(tree, "rev-parse", "HEAD");
  const tasks = (worktree: object | null, pr: string | null) => writeFileSync(f.factory, JSON.stringify({ tasks: [{ id: "t1", pr, worktree }] }));
  const data = (head: string) => JSON.stringify(withResult(f.directory, "t1", { role: "implementation", outcome: "complete", head }));
  const emit = (head: string) => f.run("emit", f.factory, "worker.result", "--task", "t1", "--data", data(head));

  tasks({ path: tree, created_by_run: true }, null);
  assert.equal(emit(head).status, 0);
  const stale = emit("0".repeat(40));
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /is at .*, not at head/);

  commit(repo, "main moves");
  const behind = emit(head);
  assert.equal(behind.status, 1);
  assert.match(behind.stderr, /does not descend from main/);

  tasks({ path: tree, created_by_run: true }, "https://github.com/owner/repo/pull/1");
  assert.equal(emit(head).status, 0);
  const wrong = emit("0".repeat(40));
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /is at .*, not at head/);

  tasks({ path: tree, created_by_run: true }, null);
  git(tree, ...identity, "rebase", "main");
  assert.equal(emit(git(tree, "rev-parse", "HEAD")).status, 0);

  tasks(null, null);
  assert.equal(emit("0".repeat(40)).status, 0);
});

test("the head check uses the repository default branch when it is master", async (t) => {
  const f = await fixture(t);
  const git = (cwd: string, ...args: string[]) => {
    const out = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  const repo = join(f.directory, "repo");
  const tree = join(f.directory, "tree");
  git(f.directory, "init", "-b", "master", repo);
  git(repo, "commit", "--allow-empty", "-m", "base");
  git(repo, "worktree", "add", "-b", "task", tree);
  git(tree, "commit", "--allow-empty", "-m", "work");
  const head = git(tree, "rev-parse", "HEAD");
  writeFileSync(f.factory, JSON.stringify({ tasks: [{ id: "t1", pr: null, worktree: { path: tree, created_by_run: true } }] }));
  const data = JSON.stringify(withResult(f.directory, "t1", { role: "implementation", outcome: "complete", head }));
  const emit = () => f.run("emit", f.factory, "worker.result", "--task", "t1", "--data", data);
  assert.equal(emit().status, 0);

  git(repo, "commit", "--allow-empty", "-m", "master moves");
  const behind = emit();
  assert.equal(behind.status, 1);
  assert.match(behind.stderr, /does not descend from master/);
});

test("a complete implementation result is refused while the worktree has uncommitted changes", async (t) => {
  const f = await fixture(t);
  const git = (cwd: string, ...args: string[]) => {
    const out = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  const repo = join(f.directory, "repo");
  git(f.directory, "init", "-b", "main", repo);
  git(repo, "commit", "--allow-empty", "-m", "base");
  const head = git(repo, "rev-parse", "HEAD");
  writeFileSync(f.factory, JSON.stringify({ tasks: [{ id: "t1", pr: null, worktree: { path: repo, created_by_run: true } }] }));
  const data = JSON.stringify(withResult(f.directory, "t1", { role: "implementation", outcome: "complete", head }));
  const emit = () => f.run("emit", f.factory, "worker.result", "--task", "t1", "--data", data);

  writeFileSync(join(repo, "work.txt"), "x");
  const dirty = emit();
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /uncommitted changes\. Commit them\. Then emit the event again/);

  git(repo, "add", "work.txt");
  git(repo, "commit", "-m", "work");
  const committed = JSON.stringify(withResult(f.directory, "t1", { role: "implementation", outcome: "complete", head: git(repo, "rev-parse", "HEAD") }));
  assert.equal(f.run("emit", f.factory, "worker.result", "--task", "t1", "--data", committed).status, 0);
});

test("pr.merged needs a task, pr, and merge_commit", async (t) => {
  const f = await fixture(t);
  const merged = { role: "implementation", pr: "https://github.com/owner/repo/pull/1", merge_commit: "a".repeat(40), head: "b".repeat(40) };
  assert.equal(f.run("emit", f.factory, "pr.merged", "--data", JSON.stringify(merged)).status, 2);
  assert.equal(f.run("emit", f.factory, "pr.merged", "--task", "t1", "--data", JSON.stringify({ ...merged, pr: undefined })).status, 2);
  const missing = f.run("emit", f.factory, "pr.merged", "--task", "t1", "--data", JSON.stringify({ ...merged, merge_commit: undefined }));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /needs "merge_commit"/);
  assert.equal(f.run("cursor", f.factory).stdout.trim(), JSON.stringify({ cursor: "0" }));
  assert.equal(f.emit("pr.merged", { data: JSON.stringify(merged) }).data.merge_commit, merged.merge_commit);
});

test("wait returns pr.merged like any other event", async (t) => {
  const f = await fixture(t);
  const data = { role: "implementation", pr: "https://github.com/owner/repo/pull/1", merge_commit: "a".repeat(40), head: "b".repeat(40) };
  const done = await f.wait("--exclude-source", "coordinator");
  const event = f.emit("pr.merged", { data: JSON.stringify(data) });
  const out = await done();
  assert.deepEqual(out.events, [event]);
  assert.equal(event.type, "pr.merged");
  assert.equal(event.task, "t1");
  assert.equal(event.source, "worker");
  assert.deepEqual(event.data, data);
  assert.equal(out.cursor, String((await stat(f.log)).size));
});

test("factory.mjs writes emit task.moved, task.updated, and dashboard feedback events", async (t) => {
  const f = await fixture(t);
  const factory = (...args: string[]) => {
    const out = spawnSync(process.execPath, [factoryScript, f.factory, ...args], { encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
  };
  factory("--project", "owner/repo", "--run-goal", "Run it");
  factory("--task", "issue-1", "--title", "Fix it", "--issue", "https://github.com/owner/repo/issues/1", "--next-action", "Start");
  factory("--task", "issue-1", "--state", "investigation", "--note", "Worker started");
  factory("--task", "issue-1", "--head", "a".repeat(40));

  const { update } = await import("./factory.mjs");
  await update(f.factory, {
    task: "issue-1", state: "initial", note: "Look again", "expected-revision": "3",
  }, { operator: true });

  const out = await (await f.wait("--since", "0", "--exclude-source", "coordinator"))();
  assert.deepEqual(out.events.map(({ type, source }) => [type, source]), [
    ["task.moved", "dashboard"], ["feedback.pending", "dashboard"],
  ]);
  assert.deepEqual(out.events[0].data, { from: "investigation", to: "initial", revision: 4 });

  const all = await (await f.wait("--since", "0"))();
  assert.deepEqual(all.events.map(({ type, task, source, data }) => [type, task, source, data.from ?? null, data.to ?? null]), [
    ["task.moved", "issue-1", "coordinator", null, "initial"],
    ["task.moved", "issue-1", "coordinator", "initial", "investigation"],
    ["task.updated", "issue-1", "coordinator", null, null],
    ["task.moved", "issue-1", "dashboard", "investigation", "initial"],
    ["feedback.pending", "issue-1", "dashboard", null, null],
  ]);
});

test("budget.updated emits without a task, needs its data key, and wakes a waiter that skips the coordinator", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run("emit", f.factory, "budget.updated", "--source", "dashboard").status, 2);
  const done = await f.wait("--exclude-source", "coordinator");
  const out = f.run("emit", f.factory, "budget.updated", "--source", "dashboard", "--data", '{"max_parallel_workers":4}');
  assert.equal(out.status, 0, out.stderr);
  const woken = await done();
  assert.deepEqual(woken.events.map(({ type, task, source, data }) => [type, task, source, data]),
    [["budget.updated", null, "dashboard", { max_parallel_workers: 4 }]]);
});

test("attention events need no task and validate their data", async (t) => {
  const f = await fixture(t);
  const data = { session: "s1", kind: "permission", text: "Run rm -rf build?" };
  const emit = (type: string, body: unknown, ...args: string[]) => f.run("emit", f.factory, type, "--source", "attention", "--data", JSON.stringify(body), ...args);

  const requested = emit("attention.requested", { ...data, role: "implementation", pane: "block:1", options: ["Allow", "Deny"] });
  assert.equal(requested.status, 0, requested.stderr);
  assert.deepEqual(JSON.parse(requested.stdout).task, null);
  assert.equal(emit("attention.requested", data, "--task", "t1").status, 0);
  for (const kind of ["sandbox-bypass", "ask-user", "other"]) assert.equal(emit("attention.requested", { ...data, kind }).status, 0, kind);
  assert.equal(emit("attention.requested", { ...data, text: "x".repeat(2000) }).status, 0);
  assert.equal(emit("attention.resolved", { session: "s1" }).status, 0);

  for (const bad of [
    { ...data, session: undefined }, { ...data, session: "" }, { ...data, session: 7 },
    { ...data, kind: undefined }, { ...data, kind: "approval" },
    { ...data, text: undefined }, { ...data, text: 7 }, { ...data, text: "x".repeat(2001) },
    { ...data, role: 1 }, { ...data, pane: 1 },
    { ...data, options: "Allow" }, { ...data, options: ["Allow", 1] },
  ]) assert.equal(emit("attention.requested", bad).status, 2, JSON.stringify(bad));
  assert.equal(emit("attention.resolved", {}).status, 2);
  assert.equal(emit("attention.resolved", { session: 1 }).status, 2);
  assert.equal((await readFile(f.log, "utf8")).trim().split("\n").length, 7);
});

test("attention events never wake a waiter that skips their source, and other readers ignore them", async (t) => {
  const f = await fixture(t);
  const attention = (type: string, data: unknown) => {
    const out = f.run("emit", f.factory, type, "--source", "attention", "--data", JSON.stringify(data));
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  };
  const done = await f.wait("--exclude-source", "attention");
  attention("attention.requested", { session: "s1", kind: "ask-user", text: "Pick one" });
  attention("attention.resolved", { session: "s1" });
  const mine = f.emit("worker.result");
  const out = await done();
  assert.deepEqual(out.events.map(({ id }) => id), [mine.id]);
  assert.equal(out.cursor, String((await stat(f.log)).size));

  const woken = await f.wait("--since", "0");
  assert.deepEqual((await woken()).events.map(({ type, task }) => [type, task]),
    [["attention.requested", null], ["attention.resolved", null], ["worker.result", "t1"]]);

  // reconcile.mjs and the sweep around the log must not trip over a task-less event.
  await writeFile(f.factory, JSON.stringify({ status: "finished", tasks: [] }));
  const swept = spawnSync(process.execPath, [join(import.meta.dirname, "reconcile.mjs"), f.factory], { encoding: "utf8" });
  assert.equal(swept.status, 0, swept.stderr);
  assert.deepEqual(JSON.parse(swept.stdout), { findings: [], errors: [] });
});

test("--due follows run-status and rule edits made while the waiter is armed", async (t) => {
  const f = await fixture(t);
  const factory = (...args: string[]) => {
    const out = spawnSync(process.execPath, [factoryScript, f.factory, ...args], { encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
  };
  const lastRun = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const rules = (every: string) => JSON.stringify([{ id: "backlog", description: "Find work", enabled: true, kind: "backlog", every, last_run_at: lastRun }]);
  factory("--project", "owner/repo", "--run-goal", "Run it", "--run-status", "paused", "--rules", rules("1m"));

  let done = await f.wait("--due", "--exclude-source", "coordinator", "--timeout", "10");
  factory("--run-status", "active");
  let out = await done();
  assert.equal(out.timeout, undefined);
  assert.deepEqual(out.events.map(({ type, data }) => [type, data]), [["rule.due", { rules: ["backlog"] }]]);

  factory("--rules", rules("1d"));
  done = await f.wait("--due", "--exclude-source", "coordinator", "--timeout", "10");
  factory("--rules", rules("1m"));
  out = await done();
  assert.equal(out.timeout, undefined);
  assert.deepEqual(out.events.map(({ type, data }) => [type, data]), [["rule.due", { rules: ["backlog"] }]]);
});

test("--due re-arms its timer when a rule edit moves the due time", async (t) => {
  const f = await fixture(t);
  const factory = (...args: string[]) => {
    const out = spawnSync(process.execPath, [factoryScript, f.factory, ...args], { encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
  };
  const rules = (every: string, lastRun: string) => JSON.stringify([{ id: "backlog", description: "Find work", enabled: true, kind: "backlog", every, last_run_at: lastRun }]);
  factory("--project", "owner/repo", "--run-goal", "Run it", "--rules", rules("1d", new Date().toISOString()));

  const done = await f.wait("--due", "--exclude-source", "coordinator", "--timeout", "10");
  // Due in about 2 seconds: only the re-armed timer can wake the waiter.
  factory("--rules", rules("1m", new Date(Date.now() - 58 * 1000).toISOString()));
  const out = await done();
  assert.equal(out.timeout, undefined);
  assert.deepEqual(out.events.map(({ type }) => type), ["rule.due"]);
});

test("--due returns a synthetic rule.due event for a due rule", async (t) => {
  const f = await fixture(t);
  await writeFile(f.factory, JSON.stringify({
    status: "active",
    rules: [
      { id: "backlog", enabled: true, kind: "backlog", every: "1h", last_run_at: "2020-01-01T00:00:00Z" },
      { id: "later", enabled: false, kind: "backlog", every: "1h" },
    ],
  }));
  const out = await (await f.wait("--due", "--timeout", "5"))();
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].type, "rule.due");
  assert.deepEqual(out.events[0].data, { rules: ["backlog"] });
  assert.equal(out.cursor, "0");
});

test("armed reports a live waiter and the waiter file goes away when it exits", async (t) => {
  const f = await fixture(t);
  const pidFile = join(f.directory, "owner.repo-factory-waiter.pid");
  const idle = f.run("armed", f.factory);
  assert.equal(idle.status, 1);
  assert.deepEqual(JSON.parse(idle.stdout), { armed: false });

  const done = await f.wait();
  const armed = f.run("armed", f.factory);
  assert.equal(armed.status, 0);
  const { pid } = JSON.parse(armed.stdout);
  assert.equal(Number((await readFile(pidFile, "utf8")).trim()), pid);
  assert.equal((await stat(pidFile)).mode & 0o777, 0o600);

  f.emit("worker.result");
  await done();
  assert.equal(f.run("armed", f.factory).status, 1);
  await assert.rejects(stat(pidFile), { code: "ENOENT" });
});

test("a second wait for the same factory is refused, then allowed once the first exits", async (t) => {
  const f = await fixture(t);
  const done = await f.wait();
  const second = f.run("wait", f.factory, "--timeout", "1");
  assert.equal(second.status, 1);
  assert.match(second.stderr, /already armed/);
  assert.equal(f.run("armed", f.factory).status, 0);

  f.emit("worker.result");
  await done();
  const again = await f.wait("--timeout", "0.1");
  assert.deepEqual((await again()).timeout, true);
});

test("a stale waiter file counts as no waiter and is replaced by the next wait", async (t) => {
  const f = await fixture(t);
  const pidFile = join(f.directory, "owner.repo-factory-waiter.pid");
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  await writeFile(pidFile, `${dead}\n`);
  assert.equal(f.run("armed", f.factory).status, 1);

  const done = await f.wait();
  const armed = f.run("armed", f.factory);
  assert.equal(armed.status, 0);
  assert.notEqual(JSON.parse(armed.stdout).pid, dead);
  f.emit("worker.result");
  await done();

  await writeFile(pidFile, "garbage\n");
  assert.equal(f.run("armed", f.factory).status, 1);
});

test("a recycled PID in the waiter file counts as no waiter, and a waiter-looking process still counts", async (t) => {
  const psWorks = spawnSync("ps", ["-o", "command=", "-p", String(process.pid)]).status === 0;
  if (!psWorks) return t.skip("ps is not usable here");
  const f = await fixture(t);
  const pidFile = join(f.directory, "owner.repo-factory-waiter.pid");
  const idle = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => idle.kill());
  for (const pid of [1, idle.pid]) {
    await writeFile(pidFile, `${pid}\n`);
    const armed = f.run("armed", f.factory);
    assert.equal(armed.status, 1, `pid ${pid}`);
    assert.deepEqual(JSON.parse(armed.stdout), { armed: false });
  }

  // wait replaces the recycled PID.
  const done = await f.wait();
  assert.notEqual(JSON.parse(f.run("armed", f.factory).stdout).pid, idle.pid);
  f.emit("worker.result");
  await done();

  // The old bare-PID format is armed only when the command line is a broker waiter.
  const lookalike = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", script, "wait", f.factory], { stdio: "ignore" });
  t.after(() => lookalike.kill());
  await writeFile(pidFile, `${lookalike.pid}\n`);
  assert.deepEqual(JSON.parse(f.run("armed", f.factory).stdout), { armed: true, pid: lookalike.pid });
});

test("a waiter whose parent is gone (ppid 1) counts as no waiter", async (t) => {
  const f = await fixture(t);
  const bin = join(f.directory, "bin");
  await mkdir(bin);
  // A fake ps reports the parent PID from $FAKE_PPID, so the test needs no real ps or orphan.
  await writeFile(join(bin, "ps"), `#!/bin/sh\necho "  $FAKE_PPID node broker.mjs wait /f.json"\n`, { mode: 0o755 });
  const armed = (ppid: number) => spawnSync(process.execPath, [script, "armed", f.factory], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_PPID: String(ppid) },
  });
  const idle = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => idle.kill());
  await writeFile(join(f.directory, "owner.repo-factory-waiter.pid"), `${idle.pid}\n`);

  const orphan = armed(1);
  assert.equal(orphan.status, 1);
  assert.deepEqual(JSON.parse(orphan.stdout), { armed: false });
  const owned = armed(process.pid);
  assert.equal(owned.status, 0);
  assert.deepEqual(JSON.parse(owned.stdout), { armed: true, pid: idle.pid });
});

test("wait refuses to start when stdout goes to a file or /dev/null", async (t) => {
  const f = await fixture(t);
  const file = join(f.directory, "out.txt");
  const fd = openSync(file, "w");
  t.after(() => closeSync(fd));
  for (const stdout of ["ignore", fd] as const) {
    const out = spawnSync(process.execPath, [script, "wait", f.factory, "--timeout", "1"], { encoding: "utf8", stdio: ["ignore", stdout, "pipe"] });
    assert.equal(out.status, 2, `stdout ${stdout}`);
    assert.match(String(out.stderr), /Never run it in the background/);
  }
  assert.equal(f.run("armed", f.factory).status, 1);
});

test("--due returns reconcile.due after the injected interval while the run is active", async (t) => {
  const f = await fixture(t);
  await writeFile(f.factory, JSON.stringify({ status: "active", rules: [] }));
  const { waitForEvents } = await import(script);
  const started = Date.now();
  const out = await waitForEvents(f.factory, { due: true, reconcile: 150, timeout: 10 });
  assert.ok(Date.now() - started >= 140, "the tick must wait for its window");
  assert.deepEqual(out.events.map(({ id, type, task, source, data }: BrokerEvent) => [id, type, task, source, data]),
    [[null, "reconcile.due", null, "broker", { every: "5m" }]]);
  assert.equal(await stat(f.log).catch(() => null), null, "the tick is never stored");

  // A new waiter starts a fresh window instead of firing at once.
  const second = Date.now();
  await waitForEvents(f.factory, { due: true, reconcile: 150, timeout: 10 });
  assert.ok(Date.now() - second >= 140);
});

test("reconcile.due does not fire while paused or without --due, and resumes when active", async (t) => {
  const f = await fixture(t);
  await writeAtomic(f.factory, JSON.stringify({ status: "paused", rules: [] }));
  const { waitForEvents } = await import(script);
  let out = await waitForEvents(f.factory, { due: true, reconcile: 50, timeout: 0.4 });
  assert.equal(out.timeout, true);
  assert.deepEqual(out.events, []);

  await writeAtomic(f.factory, JSON.stringify({ status: "active", rules: [] }));
  out = await waitForEvents(f.factory, { due: false, reconcile: 50, timeout: 0.4 });
  assert.equal(out.timeout, true);

  const pending = waitForEvents(f.factory, { due: true, reconcile: 100, timeout: 10 });
  await writeAtomic(f.factory, JSON.stringify({ status: "paused", rules: [] }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  await writeAtomic(f.factory, JSON.stringify({ status: "active", rules: [] }));
  out = await pending;
  assert.deepEqual(out.events.map(({ type }: BrokerEvent) => type), ["reconcile.due"]);
});

test("improve events need no task, validate their data, and a waiter that skips improve still wakes for the decision", async (t) => {
  const f = await fixture(t);
  const proposed = { rule: "self-improve", change: "limit", title: "Lower the cap", evidence: "idle", recommended: "accept", proposal_id: "p1", result: "r.json" };
  const emit = (type: string, body: unknown, source: string) => f.run("emit", f.factory, type, "--source", source, "--data", JSON.stringify(body));
  const done = await f.wait("--exclude-source", "improve");
  assert.equal(emit("improve.proposed", proposed, "improve").status, 0);
  assert.equal(emit("improve.decided", { proposal_id: "p1", decision: "accepted", note: "ok" }, "dashboard").status, 0);
  assert.deepEqual((await done()).events.map(({ type, source }) => [type, source]), [["improve.decided", "dashboard"]]);

  for (const bad of [
    { ...proposed, change: "plugin" }, { ...proposed, recommended: "maybe" }, { ...proposed, proposal_id: "" },
    { ...proposed, evidence: 3 }, { ...proposed, result: "../r.json" }, { ...proposed, title: undefined },
  ]) assert.equal(emit("improve.proposed", bad, "improve").status, 2, JSON.stringify(bad));
  for (const bad of [{ proposal_id: "p1", decision: "applied" }, { proposal_id: "p1" }, { decision: "accepted" }]) {
    assert.equal(emit("improve.decided", bad, "dashboard").status, 2, JSON.stringify(bad));
  }
});
