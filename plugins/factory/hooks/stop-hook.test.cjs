const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const hooks = require("../hooks.json");
const [entry] = hooks.hooks.agentStop;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "stop-hook-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "owner.repo-factory.json");
  const pidFile = join(directory, "owner.repo-factory-waiter.pid");
  return {
    directory,
    file,
    async write({ status = "active", waiter = process.pid, tasks = [] } = {}) {
      await writeFile(file, JSON.stringify({ status, tasks }));
      if (waiter !== null) await writeFile(pidFile, `${waiter}\n`);
    },
    run({ input = {}, env = {} } = {}) {
      const result = spawnSync("/bin/bash", ["-c", entry.bash], {
        encoding: "utf8",
        input: JSON.stringify(input),
        env: { PATH: process.env.PATH, PLUGIN_ROOT: join(__dirname, ".."), FACTORY_COORDINATOR: "1", FACTORY_FILE: file, ...env },
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim() === "" ? null : JSON.parse(result.stdout);
    },
  };
}

const task = (extra) => ({
  id: "t", title: "t", state: "implementation", updated_at: "2026-05-01T12:00:00Z", next_action: "Next",
  issue: null, pr: null, head: null, reviewed_head: null, links: [], blocker: null, resolution: null,
  merge: null, workers: {}, worktree: null, history: [], details: null, ...extra,
});

test("hooks.json declares one gated agentStop command with a timeout under the cap", () => {
  assert.equal(hooks.hooks.agentStop.length, 1);
  assert.equal(entry.type, "command");
  assert.ok(entry.bash.includes("FACTORY_COORDINATOR"));
  assert.ok(entry.timeoutSec > 0 && entry.timeoutSec <= 30);
});

test("allows without running node when FACTORY_COORDINATOR is not 1", async (t) => {
  const f = await fixture(t);
  await f.write({ waiter: null });
  assert.equal(f.run({ env: { FACTORY_COORDINATOR: "" } }), null);
  assert.equal(f.run({ env: { FACTORY_COORDINATOR: "0", PATH: "/nonexistent" } }), null);
});

test("blocks a non-finished run without an armed waiter, even after a prior block", async (t) => {
  const f = await fixture(t);
  await f.write({ waiter: null });
  for (const stop_hook_active of [false, true]) {
    const out = f.run({ input: { stop_hook_active } });
    assert.equal(out.decision, "block");
    assert.match(out.reason, /broker\.mjs wait .*owner\.repo-factory\.json --since CURSOR --exclude-source coordinator --due/);
  }
});

test("a dead waiter PID counts as no waiter", async (t) => {
  const f = await fixture(t);
  await f.write({ waiter: 2 ** 22 + 1 });
  assert.equal(f.run().decision, "block");
});

test("allows a finished run without a waiter", async (t) => {
  const f = await fixture(t);
  await f.write({ status: "finished", waiter: null });
  assert.equal(f.run(), null);
});

test("allows when a waiter is armed and reconcile has no findings", async (t) => {
  const f = await fixture(t);
  await f.write();
  assert.equal(f.run(), null);
});

test("blocks once on reconcile findings, then allows after the forced turn", async (t) => {
  const f = await fixture(t);
  await f.write({ tasks: [task({ workers: { implementation: { status: "closed", result: "t-result.json" } } })] });
  await writeFile(join(f.directory, "t-result.json"), JSON.stringify({ outcome: "complete", updated_at: "2026-05-01T13:00:00Z" }));
  const out = f.run({ input: { stop_hook_active: false } });
  assert.equal(out.decision, "block");
  assert.match(out.reason, /unprocessed-result/);
  assert.equal(f.run({ input: { stop_hook_active: true } }), null);
});

test("fails open on a missing, unreadable or malformed factory file", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run(), null);
  await writeFile(f.file, "{not json");
  assert.equal(f.run(), null);
  assert.equal(f.run({ input: "not an object" }), null);
});

test("finds the factory file from the origin remote and the state directory", async (t) => {
  const f = await fixture(t);
  const repo = join(f.directory, "repo");
  const state = join(f.directory, "home", ".local", "state", "copilot-factory");
  await mkdir(state, { recursive: true });
  await mkdir(repo);
  for (const args of [["init", "-q"], ["remote", "add", "origin", "git@github.com:owner/repo.git"]]) {
    assert.equal(spawnSync("git", ["-C", repo, ...args]).status, 0);
  }
  await writeFile(join(state, "owner.repo-factory.json"), JSON.stringify({ status: "active", tasks: [] }));
  const env = { FACTORY_FILE: "", HOME: join(f.directory, "home") };
  const out = f.run({ input: { cwd: repo }, env });
  assert.equal(out.decision, "block");
  assert.match(out.reason, /copilot-factory\/owner\.repo-factory\.json/);
  assert.equal(f.run({ input: { cwd: f.directory }, env }), null);
});
