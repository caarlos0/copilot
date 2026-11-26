import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test, type TestContext } from "node:test";
import hooks from "../hooks.json" with { type: "json" };
const [entry] = hooks.hooks.agentStop;

// The waiter check reads the PID's command line, so the PID must belong to a "factory.mjs broker wait" process.
function fakeWaiter(t: TestContext) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "factory.mjs", "broker", "wait"], { stdio: "ignore" });
  t.after(() => child.kill());
  return child.pid;
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "stop-hook-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "owner.repo-factory.json");
  const pidFile = join(directory, "owner.repo-factory-waiter.pid");
  const hashFile = join(directory, "owner.repo-factory-stop-hook.hash");
  const eventsFile = join(directory, "owner.repo-factory-events.jsonl");
  return {
    directory,
    file,
    hashFile,
    eventsFile,
    async write({ status = "active", waiter = fakeWaiter(t), tasks = [], rex_session }: {
      status?: string; waiter?: number | null; tasks?: unknown[]; rex_session?: string;
    } = {}) {
      const data: Record<string, unknown> = { status, tasks };
      if (rex_session !== undefined) data.rex_session = rex_session;
      await writeFile(file, JSON.stringify(data));
      if (waiter !== null) await writeFile(pidFile, `${waiter}\n`);
      else await rm(pidFile, { force: true });
    },
    run({ input = {}, env = {} }: { input?: unknown; env?: Record<string, string> } = {}) {
      const result = spawnSync("/bin/bash", ["-c", entry.bash], {
        encoding: "utf8",
        input: JSON.stringify(input),
        env: { PATH: process.env.PATH, PLUGIN_ROOT: join(import.meta.dirname, ".."), FACTORY_COORDINATOR: "1", FACTORY_FILE: file, ...env },
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim() === "" ? null : JSON.parse(result.stdout);
    },
  };
}

const task = (extra: Record<string, unknown>) => ({
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

test("FACTORY_COORDINATOR=0 allows without running node", async (t) => {
  const f = await fixture(t);
  await f.write({ waiter: null });
  assert.equal(f.run({ env: { FACTORY_COORDINATOR: "0", PATH: "/nonexistent" } }), null);
});

test("without the variable, only the session in the owner lock is blocked", async (t) => {
  const f = await fixture(t);
  await f.write({ waiter: null });
  const env = { FACTORY_COORDINATOR: "" };
  const input = { sessionId: "coordinator-session" };
  assert.equal(f.run({ input, env }), null, "no lock");
  const lock = join(f.directory, "owner.repo-factory.lock");
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ copilot_session: "coordinator-session" }));
  assert.equal(f.run({ input, env }).decision, "block");
  assert.equal(f.run({ input: { session_id: "coordinator-session" }, env }).decision, "block");
  assert.equal(f.run({ input: { sessionId: "other-session" }, env }), null, "lock of another session");
  assert.equal(f.run({ input: {}, env }), null, "payload without a session");
  assert.equal(f.run({ input, env: { FACTORY_COORDINATOR: "0" } }), null, "explicit off");
  assert.equal(f.run({ input: { sessionId: "other-session" } }).decision, "block", "explicit on");
});

test("blocks a non-finished run without an armed waiter, even after a prior block", async (t) => {
  const f = await fixture(t);
  await f.write({ waiter: null });
  for (const stop_hook_active of [false, true]) {
    const out = f.run({ input: { stop_hook_active } });
    assert.equal(out.decision, "block");
    assert.match(out.reason, /factory\.mjs broker wait .*owner\.repo-factory\.json --since CURSOR --exclude-source coordinator --exclude-source attention --exclude-source improve --exclude-source stops --due/);
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
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    assert.equal(spawnSync("git", ["-C", repo, ...args], { env }).status, 0);
  }
  await writeFile(join(state, "owner.repo-factory.json"), JSON.stringify({ status: "active", tasks: [] }));
  const env = { FACTORY_FILE: "", HOME: join(f.directory, "home") };
  const out = f.run({ input: { cwd: repo }, env });
  assert.equal(out.decision, "block");
  assert.match(out.reason, /copilot-factory\/owner\.repo-factory\.json/);
  assert.equal(f.run({ input: { cwd: f.directory }, env }), null);
});

test("deduplicates unchanged actionable findings across turns, re-blocks on change, and clears on clean sweep", async (t) => {
  const f = await fixture(t);
  const waiter = fakeWaiter(t);
  const resultPath = join(f.directory, "t-result.json");
  await f.write({ waiter, tasks: [task({ workers: { implementation: { status: "closed", result: "t-result.json" } } })] });
  await writeFile(resultPath, JSON.stringify({ outcome: "complete", updated_at: "2026-05-01T13:00:00Z", head: "a".repeat(40) }));

  const first = f.run({ input: { stop_hook_active: false } });
  assert.equal(first.decision, "block");
  assert.match(first.reason, /unprocessed-result/);
  const info = await stat(f.hashFile);
  if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o600);

  // Repeated turn ends with stop_hook_active false and identical findings do not block again.
  assert.equal(f.run({ input: { stop_hook_active: false } }), null);
  assert.equal(f.run({ input: { stop_hook_active: false } }), null);

  // A changed finding set blocks once again.
  await writeFile(resultPath, JSON.stringify({ outcome: "complete", updated_at: "2026-05-01T14:00:00Z", head: "b".repeat(40) }));
  assert.equal(f.run({ input: { stop_hook_active: false } }).decision, "block");
  assert.equal(f.run({ input: { stop_hook_active: false } }), null);

  // Reordering tasks produces the same finding set and does not re-block.
  const t1 = task({ id: "t1", workers: { implementation: { status: "closed", result: "t-result.json" } } });
  const t2 = task({ id: "t2", workers: { implementation: { status: "closed", result: "t2-result.json" } } });
  await writeFile(join(f.directory, "t2-result.json"), JSON.stringify({ outcome: "complete", updated_at: "2026-05-01T14:00:00Z", head: "c".repeat(40) }));
  await f.write({ waiter, tasks: [t1, t2] });
  assert.equal(f.run({ input: { stop_hook_active: false } }).decision, "block");
  await f.write({ waiter, tasks: [t2, t1] });
  assert.equal(f.run({ input: { stop_hook_active: false } }), null);

  // Clearing findings removes the hash file, so a later finding blocks again.
  await f.write({ waiter, tasks: [] });
  assert.equal(f.run({ input: { stop_hook_active: false } }), null);
  await assert.rejects(stat(f.hashFile), { code: "ENOENT" });

  await f.write({ waiter, tasks: [t1] });
  assert.equal(f.run({ input: { stop_hook_active: false } }).decision, "block");
});

test("allows forced turns for both stop_hook_active and stopHookActive before any hash exists", async (t) => {
  const f = await fixture(t);
  await f.write({ tasks: [task({ workers: { implementation: { status: "closed", result: "t-result.json" } } })] });
  await writeFile(join(f.directory, "t-result.json"), JSON.stringify({ outcome: "complete", updated_at: "2026-05-01T13:00:00Z" }));

  assert.equal(f.run({ input: { stop_hook_active: true } }), null);
  assert.equal(f.run({ input: { stopHookActive: true } }), null);
  assert.equal(f.run({ input: { stop_hook_active: false } }).decision, "block");
});

test("scopes the findings hash to the coordinator session, clears on finished, and always blocks a missing waiter", async (t) => {
  const f = await fixture(t);
  const waiter = fakeWaiter(t);
  const tasks = [task({ workers: { implementation: { status: "closed", result: "t-result.json" } } })];
  await f.write({ waiter, tasks });
  await writeFile(join(f.directory, "t-result.json"), JSON.stringify({ outcome: "complete", updated_at: "2026-05-01T13:00:00Z" }));

  assert.equal(f.run({ input: { sessionId: "session-a" } }).decision, "block");
  assert.equal(f.run({ input: { sessionId: "session-a" } }), null);
  assert.equal(f.run({ input: { sessionId: "session-b" } }).decision, "block");
  assert.equal(f.run({ input: { session_id: "session-b" } }), null);

  // Missing waiter still blocks even while the findings hash is stored.
  await f.write({ waiter: null, tasks });
  const missing = f.run({ input: { sessionId: "session-b" } });
  assert.equal(missing.decision, "block");
  assert.match(missing.reason, /No broker waiter is armed/);

  // Finished run clears the hash so a resumed run warns again.
  await f.write({ status: "finished", waiter: null, tasks });
  assert.equal(f.run({ input: { sessionId: "session-b" } }), null);
  await assert.rejects(stat(f.hashFile), { code: "ENOENT" });

  await f.write({ status: "active", waiter, tasks });
  assert.equal(f.run({ input: { sessionId: "session-b" } }).decision, "block");
});

test("ignores informational findings when a waiter is armed", async (t) => {
  const f = await fixture(t);
  const waiter = fakeWaiter(t);
  const recent = new Date(Date.now() - 60_000).toISOString();
  const staleAttention = new Date(Date.now() - 60 * 60_000).toISOString();

  // attention-stale and skipped blocked stops (user-decision, approval) do not block.
  await writeFile(f.eventsFile, `${JSON.stringify({
    id: "e1",
    at: staleAttention,
    type: "attention.requested",
    task: null,
    source: "attention",
    data: { session: "sess-1", kind: "permission", text: "Allow command?" },
  })}\n`);
  await f.write({
    waiter,
    tasks: [
      task({ id: "u", state: "blocked", blocker: { reason: "Pick option", since: recent, class: "user-decision", owner: "operator" } }),
      task({ id: "a", state: "blocked", blocker: { reason: "Need approval", since: recent, class: "approval", owner: "operator" } }),
    ],
  });
  assert.equal(f.run(), null);

  // branch-ahead is ignored while an implementation or review worker runs, and blocks once it stops.
  const repo = join(f.directory, "ahead-repo");
  git(f.directory, "init", "-q", "-b", "main", repo);
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  git(repo, "switch", "-q", "-c", "work");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work");
  await rm(f.eventsFile, { force: true });
  await f.write({
    waiter,
    tasks: [task({
      id: "ahead",
      state: "implementation",
      worktree: { path: repo, created_by_run: true },
      workers: { implementation: { status: "running" } },
    })],
  });
  assert.equal(f.run(), null);

  await f.write({
    waiter,
    tasks: [task({
      id: "ahead",
      state: "review",
      worktree: { path: repo, created_by_run: true },
      workers: { review: { status: "running" } },
    })],
  });
  assert.equal(f.run(), null);

  await f.write({
    waiter,
    tasks: [task({
      id: "ahead",
      state: "review",
      worktree: { path: repo, created_by_run: true },
      workers: { review: { status: "closed" } },
    })],
  });
  const aheadBlock = f.run();
  assert.equal(aheadBlock.decision, "block");
  assert.match(aheadBlock.reason, /branch-ahead/);
  assert.equal(f.run(), null);

  // merged-worktree with created_by_run false is ignored; true blocks.
  const mergedRepo = join(f.directory, "merged-repo");
  git(f.directory, "init", "-q", "-b", "main", mergedRepo);
  git(mergedRepo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  await f.write({
    waiter,
    tasks: [task({
      id: "m",
      state: "resolved",
      resolution: { outcome: "merged", at: recent, note: null },
      worktree: { path: mergedRepo, created_by_run: false },
    })],
  });
  assert.equal(f.run(), null);

  await f.write({
    waiter,
    tasks: [task({
      id: "m",
      state: "resolved",
      resolution: { outcome: "merged", at: recent, note: null },
      worktree: { path: mergedRepo, created_by_run: true },
    })],
  });
  const mergedBlock = f.run();
  assert.equal(mergedBlock.decision, "block");
  assert.match(mergedBlock.reason, /merged-worktree/);

  // rex-session-missing is omitted from actionable findings while worker-missing still blocks.
  const bin = join(f.directory, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "rex"), '#!/bin/sh\necho \'{"sessions":[]}\'\n');
  await chmod(join(bin, "rex"), 0o755);
  await f.write({
    waiter,
    rex_session: "session:gone",
    tasks: [task({
      id: "lost",
      state: "implementation",
      workers: { implementation: { status: "running", window: "window:1" } },
    })],
  });
  const rexBlock = f.run({ env: { PATH: `${bin}${delimiter}${process.env.PATH}` } });
  assert.equal(rexBlock.decision, "block");
  assert.match(rexBlock.reason, /worker-missing/);
  assert.doesNotMatch(rexBlock.reason, /rex-session-missing/);
});

test("blocks once for worker-fixable stops and stale blockers, then allows unchanged turns", async (t) => {
  const f = await fixture(t);
  const waiter = fakeWaiter(t);
  await writeFile(f.eventsFile, `${JSON.stringify({
    id: "e1",
    at: "2026-05-01T12:00:00Z",
    type: "stop.recorded",
    task: "t",
    source: "stops",
    data: {
      stop_id: "repeated-permission:t:implementation:deadbeef",
      cause: "repeated-permission",
      role: "implementation",
      class: "worker-fixable",
      detail: "The worker asked for the same permission approval 2 times in one session.",
      count: 2,
    },
  })}\n`);
  await f.write({ waiter, tasks: [] });
  const stopBlock = f.run();
  assert.equal(stopBlock.decision, "block");
  assert.match(stopBlock.reason, /repeated-permission/);
  assert.equal(f.run(), null);

  await rm(f.eventsFile, { force: true });
  const old = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
  await f.write({
    waiter,
    tasks: [task({ id: "b", state: "blocked", blocker: { reason: "Waiting on vendor", since: old, class: "outside-action", owner: "operator" } })],
  });
  const staleBlock = f.run();
  assert.equal(staleBlock.decision, "block");
  assert.match(staleBlock.reason, /stale-blocked/);
  assert.equal(f.run(), null);
});

test("deduplicates worker-quiet across growing idle_minutes and re-blocks after relaunch", async (t) => {
  const f = await fixture(t);
  const waiter = fakeWaiter(t);
  const sessionState = join(f.directory, "session-state");
  const workerSession = "11111111-1111-4111-8111-111111111111";
  await mkdir(join(sessionState, workerSession), { recursive: true });
  const eventsPath = join(sessionState, workerSession, "events.jsonl");
  const writeTurnEnd = (minutesAgo: number) =>
    writeFile(eventsPath, `${JSON.stringify({ type: "assistant.turn_end", timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString() })}\n`);

  await writeTurnEnd(15);
  await f.write({
    waiter,
    tasks: [task({
      id: "q",
      state: "implementation",
      workers: { implementation: { status: "running", session: workerSession, launched_at: "2026-05-01T12:00:00Z" } },
    })],
  });
  const env = { FACTORY_SESSION_STATE: sessionState };
  const first = f.run({ env });
  assert.equal(first.decision, "block");
  assert.match(first.reason, /worker-quiet/);

  // Increasing idle_minutes produces the same hash and does not block again.
  await writeTurnEnd(25);
  assert.equal(f.run({ env }), null);

  // A relaunched worker (new launched_at) blocks once again.
  await f.write({
    waiter,
    tasks: [task({
      id: "q",
      state: "implementation",
      workers: { implementation: { status: "running", session: workerSession, launched_at: "2026-05-01T13:00:00Z" } },
    })],
  });
  const relaunched = f.run({ env });
  assert.equal(relaunched.decision, "block");
  assert.match(relaunched.reason, /worker-quiet/);
  assert.equal(f.run({ env }), null);

  // Changing only the worker session also blocks once again.
  const workerSession2 = "worker-session-2";
  await mkdir(join(sessionState, workerSession2), { recursive: true });
  await writeFile(
    join(sessionState, workerSession2, "events.jsonl"),
    `${JSON.stringify({ type: "assistant.turn_end", timestamp: new Date(Date.now() - 15 * 60_000).toISOString() })}\n`,
  );
  await f.write({
    waiter,
    tasks: [task({
      id: "q",
      state: "implementation",
      workers: { implementation: { status: "running", session: workerSession2, launched_at: "2026-05-01T13:00:00Z" } },
    })],
  });
  const newSession = f.run({ env });
  assert.equal(newSession.decision, "block");
  assert.match(newSession.reason, /worker-quiet/);
  assert.equal(f.run({ env }), null);
});
