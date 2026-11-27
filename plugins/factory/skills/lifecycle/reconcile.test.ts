import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test, type TestContext } from "node:test";

const script = join(import.meta.dirname, "factory.mjs");
const window = "window:01a1ea3c-952d-7bdf-a621-95363a2bc34f";

// The waiter check reads the PID's command line, so the PID must belong to a "factory.mjs broker wait" process.
function fakeWaiter(t: TestContext) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "factory.mjs", "broker", "wait"], { stdio: "ignore" });
  t.after(() => child.kill());
  return child.pid;
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(result.status, 0, result.stderr);
}

function task(id: string, state: string, extra: Record<string, unknown> = {}) {
  const at = "2026-05-01T12:00:00Z";
  return {
    id, title: id, state, updated_at: at, next_action: "Next", issue: null, pr: null,
    head: null, reviewed_head: null, links: [], blocker: null,
    resolution: state === "resolved" ? { outcome: "merged", at, note: null } : null,
    merge: null, workers: {}, worktree: null, history: [{ state, at, note: null }], details: null,
    ...extra,
  };
}

async function fixture(t: TestContext, rex: string, branch = "main") {
  const directory = await mkdtemp(join(tmpdir(), "reconcile-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo");
  git(directory, "init", "-q", "-b", branch, repo);
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  git(repo, "switch", "-q", "-c", "work");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work");

  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "rex"), rex);
  await chmod(join(bin, "rex"), 0o755);
  // A sweep never reaches GitHub; a test that needs gh replaces this one.
  await writeFile(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  await chmod(join(bin, "gh"), 0o755);

  const file = join(directory, "owner.repo-factory.json");
  return {
    directory, repo, file, bin,
    async run(
      tasks: object[],
      { status = "active", waiter = fakeWaiter(t), rules, env, args = [] }: {
        status?: string; waiter?: number | null; rules?: unknown[]; env?: Record<string, string>; args?: string[];
      } = {},
    ): Promise<{ findings: any[]; errors: any[] }> {
      await writeFile(file, JSON.stringify({ rex_session: "session:work", status, tasks, rules }));
      const pidFile = join(directory, "owner.repo-factory-waiter.pid");
      if (waiter === null) await rm(pidFile, { force: true });
      else await writeFile(pidFile, `${waiter}\n`);
      const result = spawnSync(process.execPath, [script, "reconcile", file, ...args], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, ...env },
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    },
  };
}

const session = "session:01a1e7a3-fa38-7cc9-b339-f6c5afbd626c";
const rexScript = (sessions: string[]) => `#!/bin/sh
[ "$1" = "--autostart=false" ] && shift
case "$1" in
  ls) echo '{"sessions":[${sessions.map((id) => `{"session_id":"${id}"}`)}]}' ;;
  *) echo '{"windows":[{"window_id":"${window}"}]}' ;;
esac
`;
const fakeRex = rexScript(["session:work"]);

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

test("finds the default branch when it is master", async (t) => {
  const f = await fixture(t, fakeRex, "master");
  const { findings, errors } = await f.run([
    task("local", "review", { worktree: { path: f.repo, created_by_run: true } }),
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
  const at = (path: string) => ({ path, created_by_run: true });
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

test("flags a finished rule worker whose window is open or whose status is still running", async (t) => {
  const f = await fixture(t, fakeRex);
  const before = "2026-05-01T10:00:00Z";
  const after = "2026-05-01T13:00:00Z";
  const stamp = (name: string, updated_at: string, outcome = "complete") =>
    writeFile(join(f.directory, name), JSON.stringify({ outcome, updated_at }));
  await stamp("scan-result.json", after);
  await stamp("open-result.json", after);
  await stamp("closed-result.json", after);
  await stamp("fresh-result.json", before);
  await stamp("working-result.json", after, "working");
  const rule = (id: string, worker: object | null, last_run_at: string | null = "2026-05-01T12:00:00Z") =>
    ({ id, description: id, kind: "backlog", enabled: true, last_run_at, worker });
  const rules = [
    rule("scan", { status: "running", result: "scan-result.json" }),
    rule("open", { status: "closed", window: "a621-95363a2bc34f", result: "open-result.json" }),
    rule("closed", { status: "closed", window: "window:other-id", result: "closed-result.json" }),
    rule("fresh", { status: "running", window, result: "fresh-result.json" }),
    rule("working", { status: "running", window, result: "working-result.json" }),
    rule("working-first", { status: "running", window, result: "working-result.json" }, null),
    rule("missing", { status: "running", window, result: "none-result.json" }),
    rule("cleared", null),
  ];
  const { findings, errors } = await f.run([], { rules });
  assert.deepEqual(errors, []);
  assert.deepEqual(findings, [
    { kind: "rule-worker-done", rule: "scan", window: null, result: "scan-result.json" },
    { kind: "rule-worker-done", rule: "open", window, result: "open-result.json" },
  ]);
});

test("flags a task blocked longer than the threshold, with its class and owner", async (t) => {
  const f = await fixture(t, fakeRex);
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const blocker = (since: string, extra: Record<string, unknown> = {}) => ({ from: "implementation", reason: "Need a token", since, ...extra });
  const tasks = [
    task("old-classed", "blocked", { blocker: blocker(hoursAgo(30), { class: "outside-action", owner: "alice" }) }),
    task("old-plain", "blocked", { blocker: blocker(hoursAgo(25)) }),
    task("fresh", "blocked", { blocker: blocker(hoursAgo(2), { class: "user-decision", owner: "operator" }) }),
    task("working", "implementation"),
  ];
  const stale = (findings: any[]) => findings.filter((finding) => finding.kind === "stale-blocked")
    .map(({ task, class: kind, owner, reason }) => ({ task, class: kind, owner, reason }));
  let { findings } = await f.run(tasks);
  assert.deepEqual(stale(findings), [
    { task: "old-classed", class: "outside-action", owner: "alice", reason: "Need a token" },
    { task: "old-plain", class: null, owner: null, reason: "Need a token" },
  ]);
  ({ findings } = await f.run(tasks, { args: ["--blocked-after", "1h"] }));
  assert.deepEqual(stale(findings).map((finding) => finding.task), ["old-classed", "old-plain", "fresh"]);
  ({ findings } = await f.run(tasks, { args: ["--blocked-after", "3d"] }));
  assert.deepEqual(stale(findings), []);
});

test("is quiet when everything is reconciled", async (t) => {
  const f = await fixture(t, fakeRex);
  const { findings, errors } = await f.run([
    task("done", "resolved", { workers: { implementation: { status: "closed", window: "window:other-id" } } }),
  ]);
  assert.deepEqual({ findings, errors }, { findings: [], errors: [] });
});

test("reads Rex with --autostart=false", async (t) => {
  const log = join(tmpdir(), `reconcile-rex-args-${process.pid}`);
  t.after(() => rm(log, { force: true }));
  const f = await fixture(t, `#!/bin/sh\necho "$@" >> "${log}"\ncase "$2" in ls) echo '{"sessions":[{"session_id":"session:work"}]}' ;; *) echo '{"windows":[]}' ;; esac\n`);
  await f.run([task("done", "resolved", { workers: { implementation: { status: "closed", window } } })]);
  const calls = (await readFile(log, "utf8")).trim().split("\n");
  assert.deepEqual(calls, ["--autostart=false ls --json", "--autostart=false window ls -s session:work --json"]);
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
  const kinds = async (...args: Parameters<typeof f.run>) => (await f.run(...args)).findings.map(({ kind }) => kind);

  assert.deepEqual(await kinds(open, { waiter: null }), ["no-waiter"]);
  assert.deepEqual(await kinds(open, { waiter: dead }), ["no-waiter"]);
  assert.deepEqual(await kinds(done, { status: "active", waiter: null }), ["no-waiter"]);
  assert.deepEqual(await kinds(open, { status: "paused", waiter: null }), ["no-waiter"]);
  assert.deepEqual(await kinds(open), []);
  assert.deepEqual(await kinds(done, { status: "finished", waiter: null }), []);
});

test("reports hooks-inactive when the owner lock would not activate the hooks for this session", async (t) => {
  const f = await fixture(t, fakeRex);
  const open = [task("busy", "implementation")];
  const inactive = async (env: Record<string, string>) => (await f.run(open, { env })).findings.filter(({ kind }) => kind === "hooks-inactive");
  const mine = { COPILOT_AGENT_SESSION_ID: "mine", FACTORY_COORDINATOR: "" };

  assert.deepEqual(await inactive(mine), [], "no lock");
  const lock = join(f.directory, "owner.repo-factory.lock");
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ copilot_session: "mine" }));
  assert.deepEqual(await inactive(mine), []);
  assert.deepEqual(await inactive({ ...mine, FACTORY_COORDINATOR: "1" }), []);
  assert.match((await inactive({ ...mine, COPILOT_AGENT_SESSION_ID: "other" }))[0].reason, /records session mine, not this session other/);
  assert.match((await inactive({ ...mine, FACTORY_COORDINATOR: "0" }))[0].reason, /turns the hooks off/);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ rex_session: "session:x" }));
  assert.match((await inactive(mine))[0].reason, /records no Copilot session/);
});

test("flags a running worker whose window is gone, for tasks and rules", async (t) => {
  const f = await fixture(t, fakeRex);
  const worker = (extra: Record<string, unknown>) => ({
    status: "running", pane: "block:p1", brief: "b.md", result: "none.json", window: "window:gone", ...extra,
  });
  await writeFile(join(f.directory, "r.json"), JSON.stringify({ outcome: "complete", updated_at: "2026-05-01T13:00:00Z" }));
  const worktree = { path: join(f.directory, "wt"), created_by_run: true };
  const { findings, errors } = await f.run([
    task("lost", "implementation", { workers: { implementation: worker({ result: "lost.json" }) }, worktree }),
    task("alive", "implementation", { workers: { implementation: worker({ window }) } }),
    task("unplaced", "investigation", { workers: { investigation: worker({ window: null, pane: null, result: "none.json" }) } }),
    task("finished", "investigation", { workers: { investigation: worker({ result: "r.json" }) } }),
    task("closed", "implementation", { workers: { implementation: worker({ status: "closed" }) } }),
  ], { rules: [{ id: "scan", description: "scan", kind: "backlog", enabled: true, last_run_at: null, worker: worker({ result: "scan.json" }) }] });
  assert.deepEqual(errors.filter((e) => !/worktree/.test(e)), []);
  assert.deepEqual(findings.filter(({ kind }) => kind !== "unprocessed-result"), [
    { kind: "worker-missing", task: "lost", role: "implementation", worktree: worktree.path,
      window: "window:gone", pane: "block:p1", brief: "b.md", result: "lost.json" },
    { kind: "worker-missing", task: "unplaced", role: "investigation", worktree: null,
      window: null, pane: null, brief: "b.md", result: "none.json" },
    { kind: "worker-missing", rule: "scan", role: "rule", worktree: null,
      window: "window:gone", pane: "block:p1", brief: "b.md", result: "scan.json" },
  ]);
  assert.deepEqual(findings.filter(({ kind }) => kind === "unprocessed-result").map((x) => x.task), ["finished"]);
});

test("reports a gone Rex session once, with every running worker missing", async (t) => {
  const f = await fixture(t, rexScript(["session:other"]));
  const running = { status: "running", window, pane: "block:p1", brief: "b.md", result: "r.json" };
  const { findings, errors } = await f.run([
    task("a", "implementation", { workers: { implementation: running } }),
    task("b", "investigation", { workers: { investigation: running } }),
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(findings.map(({ kind, task, workers }) => ({ kind, task, workers })), [
    { kind: "rex-session-missing", task: undefined, workers: 2 },
    { kind: "worker-missing", task: "a", workers: undefined },
    { kind: "worker-missing", task: "b", workers: undefined },
  ]);
});

test("a merged task with a PR gets the delete command with --merged-pr, even when its HEAD is not in the default branch", async (t) => {
  const f = await fixture(t, fakeRex);
  const dirty = join(f.directory, "dirty");
  git(f.repo, "worktree", "add", "-q", "-b", "dirty", dirty, "work");
  await writeFile(join(dirty, "scratch.txt"), "x");
  const pr = "https://github.com/acme/proj/pull/7";
  const { findings, errors } = await f.run([
    task("squashed", "resolved", { pr, worktree: { path: f.repo, created_by_run: true } }),
    task("dirty", "resolved", { pr, worktree: { path: dirty, created_by_run: true } }),
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(findings, [{
    kind: "merged-worktree", task: "squashed", path: f.repo, created_by_run: true,
    command: `node ${join(import.meta.dirname, "factory.mjs")} worktree delete work --merged-pr ${pr}`,
  }]);
});

test("reports a running worker of a resolved task with the fix command", async (t) => {
  const f = await fixture(t, fakeRex);
  const { findings, errors } = await f.run([
    task("done", "resolved", { workers: {
      implementation: { status: "running", window: "window:gone" },
      investigation: { status: "closed" },
    } }),
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(findings.map(({ fix, ...rest }) => rest), [
    { kind: "stale-running", task: "done", role: "implementation", window: "window:gone" },
  ]);
  assert.equal(findings[0].fix, `node ${join(import.meta.dirname, "factory.mjs")} write ${f.file} --task done --workers '{"implementation":{"status":"closed"}}'`);
});

test("reports an attention item open longer than --attention-after, and records the ones the session log closed", async (t) => {
  const rex = `#!/bin/sh
[ "$1" = "--autostart=false" ] && shift
case "$1" in
  ls)
    case "$*" in *-q*) echo session:work ;; *) echo '{"sessions":[{"session_id":"session:work"}]}' ;; esac ;;
  block) echo block:live ;;
  *) echo '{"windows":[]}' ;;
esac
`;
  const f = await fixture(t, rex);
  const state = join(f.directory, "session-state");
  await mkdir(join(state, "answered"), { recursive: true });
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const lines: object[] = [];
  const request = (id: string, session: string, minutes: number, extra: Record<string, unknown> = {}) => lines.push({
    id, at: minutesAgo(minutes), type: "attention.requested", task: "busy", source: "attention",
    data: { session, kind: "sandbox-bypass", text: `text ${id}`, role: "implementation", pane: "block:live", ...extra },
  });
  request("old", "s-old", 45);
  request("fresh", "s-fresh", 5);
  request("gone", "s-gone", 45, { pane: "block:dead" });
  request("answered", "answered", 45);
  await writeFile(join(f.directory, "owner.repo-factory-events.jsonl"), lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  await writeFile(join(state, "answered", "events.jsonl"), `${JSON.stringify({ type: "permission.completed", data: {}, timestamp: minutesAgo(40) })}\n`);

  const env = { FACTORY_SESSION_STATE: state };
  const run = () => f.run([task("busy", "implementation", { title: "Busy task" })], { env });
  const attention = ({ findings }: { findings: any[] }) => findings.filter(({ kind }) => kind === "attention-stale");
  let result = await run();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(attention(result).map(({ since, ...rest }) => rest), [{
    kind: "attention-stale", task: "busy", title: "Busy task", role: "implementation",
    attention: "sandbox-bypass", text: "text old", pane: "block:live",
  }]);
  assert.deepEqual(attention(await f.run([task("busy", "implementation")], { env, args: ["--attention-after", "10m"] })).map(({ text }) => text), ["text old"]);
  assert.equal(attention(await f.run([task("busy", "implementation")], { env, args: ["--attention-after", "1m"] })).length, 2);

  const log = (await readFile(join(f.directory, "owner.repo-factory-events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const resolved = log.filter(({ type }) => type === "attention.resolved");
  assert.deepEqual(resolved.map(({ source, data }) => [source, data.session, data.reason]).sort(), [
    ["reconcile", "answered", "answered"],
    ["reconcile", "s-gone", "pane-gone"],
  ]);
  assert.equal(resolved.length, 2, "recorded once, not on every sweep");
});

test("records each stop once, reports it until a cause task holds its stop_id, and keeps other findings", async (t) => {
  const f = await fixture(t, fakeRex);
  const now = Date.now();
  const prompt = (id: string, offsetMs: number) => ({
    id, at: new Date(now + offsetMs).toISOString(), type: "attention.requested", task: null, source: "attention",
    data: { session: "s-work", kind: "permission", text: "Run ls.", role: "implementation" },
  });
  const eventsPath = join(f.directory, "owner.repo-factory-events.jsonl");
  await writeFile(eventsPath, [prompt("p1", -10_000), prompt("p2", 0)].map((line) => `${JSON.stringify(line)}\n`).join(""));
  const stopped = (blocker: object) => task("stuck", "blocked", { blocker: { from: "implementation", reason: "Needs a decision.", since: "2026-05-01T10:00:00Z", ...blocker } });
  const work = task("busy", "implementation", { workers: { implementation: { status: "closed", session: "s-work" } } });
  const stops = (result: { findings: any[] }) => result.findings.filter(({ kind }) => kind === "stop");
  const recorded = async () => (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter(({ type }) => type === "stop.recorded");

  let result = await f.run([work, stopped({ class: "user-decision" })]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(stops(result).map(({ command, ...rest }) => rest), [
    { kind: "stop", stop_id: "blocked:stuck:-:2026-05-01T10:00:00Z", cause: "blocked", class: "user-decision", task: "stuck", role: null,
      detail: "The task is blocked. Reason: Needs a decision." },
    { kind: "stop", stop_id: stops(result)[1].stop_id, cause: "repeated-permission", class: "worker-fixable", task: "busy", role: "implementation",
      detail: "The worker asked for the same permission approval 2 times in one session." },
  ]);
  assert.ok(result.findings.some(({ kind }) => kind === "stale-blocked"));
  const [first] = stops(result);
  const causeId = /--task (cause-[0-9a-f]{8})/.exec(first.command)![1];
  assert.equal(first.command, `node ${join(import.meta.dirname, "factory.mjs")} write ${f.file} --task ${causeId} --title 'Cause: blocked in stuck' --issue null --next-action 'Find the root cause. Then propose a prevention, not only a retry.' --details '{"stop_id":"${first.stop_id}","cause_of":"stuck"}'`);

  await f.run([work, stopped({ class: "user-decision" })]);
  assert.equal((await recorded()).length, 2, "each stop is recorded once");
  assert.ok((await recorded()).every(({ source }) => source === "stops"));

  const cause = task(causeId, "initial", { details: { stop_id: first.stop_id, cause_of: "stuck" } });
  result = await f.run([work, stopped({ class: "user-decision" }), cause]);
  assert.deepEqual(stops(result).map(({ cause }) => cause), ["repeated-permission"]);

  const dismissedId = stops(result)[0].stop_id;
  await writeFile(eventsPath, `${await readFile(eventsPath, "utf8")}${JSON.stringify({
    id: "d1", at: new Date().toISOString(), type: "stop.dismissed", task: null, source: "stops", data: { stop_id: dismissedId },
  })}\n`);
  result = await f.run([work, stopped({ class: "user-decision" }), cause]);
  assert.deepEqual(stops(result), [], "A dismissed stop produces no stop finding.");
  assert.equal((await recorded()).length, 2, "A dismissed stop is not recorded again.");

  // Unblocking the task clears its blocked stop without a cause task or dismissal.
  result = await f.run([work, task("stuck", "implementation")]);
  assert.deepEqual(stops(result), [], "An unblocked task clears its blocked stop.");
});

test("reconcile hides an emit-refused stop fixed by a later worker.result and keeps an unfixed one", async (t) => {
  const f = await fixture(t, fakeRex);
  const eventsPath = join(f.directory, "owner.repo-factory-events.jsonl");
  const lines = [
    {
      id: "s1", at: "2026-05-01T12:00:00Z", type: "stop.recorded", task: "fixed", source: "stops",
      data: { stop_id: "emit-refused:fixed:implementation:bad-result", cause: "emit-refused", role: "implementation", class: "worker-fixable", detail: 'Result file fixed-result.json is missing the "task" key.', count: 1 },
    },
    {
      id: "r1", at: "2026-05-01T12:00:08Z", type: "worker.result", task: "fixed", source: "worker",
      data: { role: "implementation", outcome: "complete" },
    },
    {
      id: "s2", at: "2026-05-01T12:01:00Z", type: "stop.recorded", task: "stuck", source: "stops",
      data: { stop_id: "emit-refused:stuck:implementation:bad-result", cause: "emit-refused", role: "implementation", class: "worker-fixable", detail: 'Result file stuck-result.json is missing the "task" key.', count: 1 },
    },
  ];
  await writeFile(eventsPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  const { findings, errors } = await f.run([task("fixed", "implementation"), task("stuck", "implementation")]);
  assert.deepEqual(errors, []);
  const stops = findings.filter(({ kind }) => kind === "stop");
  assert.equal(stops.length, 1);
  assert.equal(stops[0].stop_id, "emit-refused:stuck:implementation:bad-result");
  assert.equal(stops[0].detail, 'Result file stuck-result.json is missing the "task" key.');
});

test("reports a running worker that ended its turn over 10 minutes ago and saved no new result", async (t) => {
  const f = await fixture(t, fakeRex);
  const state = join(f.directory, "session-state");
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const log = async (name: string, ...events: [string, number][]) => {
    await mkdir(join(state, name), { recursive: true });
    await writeFile(join(state, name, "events.jsonl"), events.map(([type, minutes]) => `${JSON.stringify({ type, data: {}, timestamp: minutesAgo(minutes) })}\n`).join(""));
  };
  await log("quiet", ["assistant.message", 25], ["assistant.turn_end", 20]);
  await log("fresh", ["assistant.turn_end", 5]);
  await log("working", ["assistant.turn_end", 30], ["assistant.turn_start", 20]);
  await log("saved", ["assistant.turn_end", 20]);
  await log("parked", ["assistant.turn_end", 20]);
  await writeFile(join(f.directory, "saved-result.json"), "{}");

  const worker = (name: string, extra = {}) => ({ status: "running", session: name, window, launched_at: minutesAgo(60), ...extra });
  const { findings, errors } = await f.run([
    task("busy", "implementation", { workers: { implementation: worker("quiet") } }),
    task("fresh", "implementation", { workers: { implementation: worker("fresh") } }),
    task("working", "implementation", { workers: { implementation: worker("working") } }),
    task("saved", "implementation", { workers: { implementation: worker("saved", { result: "saved-result.json", launched_at: minutesAgo(120) }) } }),
    task("parked", "implementation", { workers: { implementation: worker("parked", { status: "idle" }) } }),
    task("done", "resolved", { workers: { implementation: worker("quiet", { status: "closed" }) } }),
  ], { env: { FACTORY_SESSION_STATE: state } });
  assert.deepEqual(errors, []);
  assert.deepEqual(findings.filter(({ kind }) => kind === "worker-quiet"), [
    { kind: "worker-quiet", task: "busy", role: "implementation", idle_minutes: 20 },
  ]);
});

test("--attention-after must be a duration", async (t) => {
  const f = await fixture(t, fakeRex);
  await writeFile(f.file, JSON.stringify({ status: "active", tasks: [] }));
  const result = spawnSync(process.execPath, [script, "reconcile", f.file, "--attention-after", "soon"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--attention-after must look like/);
});

test("an old undecided proposal is not stuck work, but a decision missing from the result file is", async (t) => {
  const f = await fixture(t, fakeRex);
  const days = (n: number) => new Date(Date.now() - n * 24 * 3_600_000).toISOString();
  const proposed = (id: string, result: string, at: string) => ({
    id: `p-${id}`, at, type: "improve.proposed", task: null, source: "improve",
    data: { rule: "self-improve", change: "limit", title: `Title ${id}`, evidence: "e", recommended: "accept", proposal_id: id, result },
  });
  const decided = (id: string, decision: string, at: string) => ({
    id: `d-${id}`, at, type: "improve.decided", task: null, source: "dashboard", data: { proposal_id: id, decision },
  });
  await writeFile(join(f.directory, "owner.repo-factory-events.jsonl"), [
    proposed("old-open", "open-result.json", days(3)),
    proposed("lost", "lost-result.json", days(2)),
    decided("lost", "accepted", days(1)),
    proposed("applied", "applied-result.json", days(2)),
    decided("applied", "declined", days(1)),
    proposed("replaced", "new-result.json", days(3)),
    decided("replaced", "accepted", days(2)),
    proposed("newer", "new-result.json", days(1)),
  ].map((event) => `${JSON.stringify(event)}\n`).join(""));
  const change = { kind: "limit", summary: "s" };
  await writeFile(join(f.directory, "open-result.json"), JSON.stringify({ change }));
  await writeFile(join(f.directory, "lost-result.json"), JSON.stringify({ change }));
  await writeFile(join(f.directory, "applied-result.json"), JSON.stringify({ change, decision: { status: "declined" } }));
  await writeFile(join(f.directory, "new-result.json"), JSON.stringify({ change }));

  const { findings, errors } = await f.run([]);
  assert.deepEqual(errors, []);
  assert.deepEqual(findings.map(({ decided_at, ...rest }) => rest), [{
    kind: "improve-decided-unapplied", rule: "self-improve", proposal_id: "lost", change: "limit",
    title: "Title lost", decision: "accepted", result: "lost-result.json",
  }]);
});

const issue = (n: number) => `https://github.com/owner/repo/issues/${n}`;
const pull = (n: number) => `https://github.com/owner/repo/pull/${n}`;

test("reports tasks that share an issue or PR through links, and keeps the furthest-along one", async (t) => {
  const f = await fixture(t, fakeRex);
  const { findings } = await f.run([
    task("issue-1", "initial", { issue: issue(1) }),
    task("pr-5", "review", { pr: pull(5), links: [issue(1)] }),
    task("issue-2", "initial", { issue: issue(2) }),
    task("old-pr", "resolved", { pr: pull(9), resolution: { outcome: "merged", at: "2026-05-01T12:00:00Z", note: null } }),
    task("issue-9", "initial", { issue: issue(9), links: [pull(9)] }),
    task("gone", "resolved", { links: [issue(2)], details: { merged_into: "issue-2" }, resolution: { outcome: "duplicate", at: "2026-05-01T12:00:00Z", note: null } }),
  ], { waiter: null });
  const duplicates = findings.filter(({ kind }) => kind === "duplicate-task");
  assert.equal(duplicates.length, 1);
  assert.deepEqual({ keep: duplicates[0].keep, merge: duplicates[0].merge }, { keep: "pr-5", merge: ["issue-1"] });
  assert.match(duplicates[0].command, /factory\.mjs write .*owner\.repo-factory\.json --merge-task pr-5 --from issue-1$/);
});

test("asks GitHub which issues an open PR task closes, and skips it when gh fails", async (t) => {
  const f = await fixture(t, fakeRex);
  const tasks = [
    task("issue-2", "implementation", { issue: issue(2) }),
    task("pr-6", "implementation", { pr: pull(6) }),
    task("issue-3", "initial", { issue: issue(3) }),
    task("pr-7", "review", { pr: pull(7) }),
    task("pr-8", "review", { pr: pull(8) }),
  ];
  const found = async () => (await f.run(tasks, { waiter: null })).findings.filter(({ kind }) => kind === "duplicate-task");
  assert.deepEqual(await found(), []);

  await writeFile(join(f.bin, "gh"), `#!/bin/sh
case "$3" in
  ${pull(6)}) echo '{"closingIssuesReferences":[{"url":"${issue(2)}"}],"body":""}' ;;
  ${pull(7)}) echo '{"closingIssuesReferences":[],"body":"Fixes #3"}' ;;
  *) echo '{"closingIssuesReferences":[],"body":"Fixes #99"}' ;;
esac
`);
  const duplicates = await found();
  assert.deepEqual(duplicates.map(({ keep, merge }) => ({ keep, merge })), [
    { keep: "pr-6", merge: ["issue-2"] },
    { keep: "pr-7", merge: ["issue-3"] },
  ]);
});
