const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { mkdtemp, readFile, rm, stat, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const script = join(__dirname, "broker.mjs");
const factoryScript = join(__dirname, "factory.mjs");
const result = { task: "t1", data: JSON.stringify({ role: "implementation", outcome: "complete" }) };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "broker-test-"));
  const children = [];
  t.after(async () => {
    for (const { child } of children) child.kill();
    await Promise.all(children.map(({ finished }) => finished));
    await rm(directory, { recursive: true, force: true });
  });
  const factory = join(directory, "owner.repo-factory.json");
  const log = join(directory, "owner.repo-factory-events.jsonl");
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const emit = (type, { source, task = "t1", data = result.data } = {}) => {
    const out = run("emit", factory, type, "--task", task, "--data", data, ...(source ? ["--source", source] : []));
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  };
  // Resolves with a function that returns the parsed output once the waiter is armed and exits.
  async function wait(...args) {
    const child = spawn(process.execPath, [script, "wait", factory, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const finished = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
    children.push({ child, finished });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    await new Promise((resolve, reject) => {
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
  const runs = Array.from({ length: count }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      script, "emit", f.factory, "worker.result", "--task", `t${index}`,
      "--data", JSON.stringify({ role: "implementation", outcome: "working", pad: "x".repeat(2000) }),
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

test("factory.mjs writes emit task.moved, task.updated, and dashboard feedback events", async (t) => {
  const f = await fixture(t);
  const factory = (...args) => {
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

test("--due follows run-status and rule edits made while the waiter is armed", async (t) => {
  const f = await fixture(t);
  const factory = (...args) => {
    const out = spawnSync(process.execPath, [factoryScript, f.factory, ...args], { encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
  };
  const lastRun = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const rules = (every) => JSON.stringify([{ id: "backlog", description: "Find work", enabled: true, kind: "backlog", every, last_run_at: lastRun }]);
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
  const factory = (...args) => {
    const out = spawnSync(process.execPath, [factoryScript, f.factory, ...args], { encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
  };
  const rules = (every, lastRun) => JSON.stringify([{ id: "backlog", description: "Find work", enabled: true, kind: "backlog", every, last_run_at: lastRun }]);
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
