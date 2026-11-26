import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";

const ids = {
  a: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  b: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  c: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  gone: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
};

const event = (minute: number, type: string, data: Record<string, unknown> = {}) =>
  JSON.stringify({ type, timestamp: new Date(Date.UTC(2026, 4, 1, 12, minute)).toISOString(), data });
const record = (model: string, nano: number | null, input: number, output: number) => event(1, "session.usage_record", {
  usage: { model, inputTokens: input, outputTokens: output, ...(nano === null ? {} : { copilotUsage: { totalNanoAiu: nano } }) },
});

async function sessions(t: TestContext, logs: Record<string, string[]>) {
  const directory = await mkdtemp(join(tmpdir(), "factory-usage-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [id, lines] of Object.entries(logs)) {
    await mkdir(join(directory, id));
    await writeFile(join(directory, id, "events.jsonl"), `${lines.join("\n")}\n`);
  }
  return directory;
}

const task = (workers: Record<string, { session?: unknown } | null>, state = "implementation", history = [
  { state: "initial", at: "2026-05-01T10:00:00Z" },
  { state: state, at: "2026-05-01T10:30:00Z" },
]) => ({ id: "issue-1", state, workers, history });

test("sums models, credits, tokens and active time per worker and per task", async (t) => {
  const { taskUsage } = await import("./usage.ts");
  const directory = await sessions(t, {
    [ids.a]: [event(0, "session.start"), record("m1", 1_500_000_000, 100, 10), record("m2", 2_250_000_000, 200, 20), event(5, "assistant.turn_end")],
    [ids.b]: [event(0, "session.start"), record("m2", 500_000_000, 50, 5), event(2, "assistant.turn_end")],
  });
  const usage = await taskUsage(task({
    investigation: { session: ids.a },
    implementation: { session: `session:${ids.b}` },
    review: { session: ids.a },
  }), directory);
  assert.deepEqual(usage.workers.investigation, {
    models: ["m1", "m2"], credits: 3.75, usd: 0.0375, input_tokens: 300, output_tokens: 30, active_minutes: 5,
  });
  assert.equal(usage.workers.implementation!.credits, 0.5);
  assert.deepEqual(usage.workers.review, usage.workers.investigation);
  assert.deepEqual(usage.total, {
    models: ["m1", "m2"], credits: 4.25, usd: 0.0425, input_tokens: 350, output_tokens: 35, active_minutes: 7,
  }, "A session shared by two roles counts once in the total.");
  assert.equal(usage.started_at, "2026-05-01T10:00:00Z");
  assert.equal(usage.ended_at, null, "An open task has no end.");
});

test("falls back to tokens when a log has no credits, and the total follows", async (t) => {
  const { taskUsage } = await import("./usage.ts");
  const directory = await sessions(t, {
    [ids.a]: [event(0, "session.start"), record("m1", 1_000_000_000, 10, 1)],
    [ids.b]: [event(0, "session.start"), record("m1", null, 20, 2)],
  });
  const usage = await taskUsage(task({ investigation: { session: ids.a }, implementation: { session: ids.b } }), directory);
  assert.equal(usage.workers.investigation!.credits, 1);
  assert.equal(usage.workers.implementation!.credits, null);
  assert.equal(usage.workers.implementation!.usd, null);
  assert.equal(usage.total!.credits, null);
  assert.deepEqual([usage.total!.input_tokens, usage.total!.output_tokens], [30, 3]);
});

test("a missing, unnamed, empty or foreign session is n/a, never an error", async (t) => {
  const { taskUsage } = await import("./usage.ts");
  const directory = await sessions(t, { [ids.c]: [""] });
  const usage = await taskUsage(task({
    investigation: { session: ids.gone },
    implementation: { session: null },
    review: { session: ids.c },
    producer: { session: "../../etc/passwd" },
  }, "resolved", [
    { state: "initial", at: "2026-05-01T10:00:00Z" },
    { state: "resolved", at: "2026-05-01T11:15:00Z" },
  ]), directory);
  assert.deepEqual(usage.workers, { investigation: null, implementation: null, review: null, producer: null });
  assert.equal(usage.total, null);
  assert.equal(usage.ended_at, "2026-05-01T11:15:00Z", "A resolved task ends at its last history entry.");
});

test("a log that did not change is not read again", async (t) => {
  const { sessionUsage } = await import("./usage.ts");
  const directory = await sessions(t, { [ids.a]: [event(0, "session.start"), record("m1", 1_000_000_000, 1, 1)] });
  const file = join(directory, ids.a, "events.jsonl");
  const before = await sessionUsage(ids.a, directory);
  const stamp = new Date(Date.now() - 60_000);
  await writeFile(file, `${event(0, "session.start")}\n${record("m9", 9_000_000_000, 9, 9)}\n`);
  await utimes(file, stamp, stamp);
  // The rewrite changes size and time, but a log read moments ago is served from the cache.
  assert.deepEqual(await sessionUsage(ids.a, directory), before);
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const worker = (n: number) => ({ session: uuid(n) });
const history = [{ state: "initial", at: "2026-05-01T10:00:00Z" }, { state: "implementation", at: "2026-05-01T10:30:00Z" }];

test("factoryUsage keeps task order and matches taskUsage for shared and missing sessions", async (t) => {
  const { factoryUsage, taskUsage } = await import("./usage.ts");
  const logs: Record<string, string[]> = {};
  for (let n = 1; n <= 9; n++) logs[uuid(n)] = [event(0, "session.start"), record("m", n * 1_000_000_000, n, 1), event(n, "assistant.turn_end")];
  const directory = await sessions(t, logs);
  const data = { tasks: [
    { id: "t-9", state: "implementation", history, workers: { implementation: worker(9), review: worker(1) } },
    { id: "t-1", state: "implementation", history, workers: { investigation: worker(1), implementation: worker(2), review: worker(3) } },
    { id: "t-x", state: "implementation", history, workers: { implementation: worker(99), review: null } },
    { id: "t-5", state: "implementation", history, workers: { implementation: worker(5), review: worker(4), producer: worker(6) } },
  ] };
  const usage = await factoryUsage(data, directory);
  assert.deepEqual(Object.keys(usage), ["t-9", "t-1", "t-x", "t-5"]);
  for (const item of data.tasks) assert.deepEqual(usage[item.id], await taskUsage(item, directory));
  assert.equal(usage["t-9"].workers.implementation!.credits, 9);
  assert.equal(usage["t-x"].workers.implementation, null);
  assert.equal(usage["t-5"].total!.credits, 15);
});

test("the usage cache is capped and a large run still returns every result", async (t) => {
  const { cacheSize, factoryUsage } = await import("./usage.ts");
  const count = 1100;
  const directory = await sessions(t, {});
  for (let n = 1; n <= count; n++) {
    await mkdir(join(directory, uuid(10_000 + n)));
    await writeFile(join(directory, uuid(10_000 + n), "events.jsonl"), `${event(0, "session.start")}\n${record("m", 1_000_000_000, 1, 1)}\n`);
  }
  const tasks = Array.from({ length: count }, (_, i) => ({
    id: `t-${i}`, state: "implementation", history, workers: { implementation: worker(10_001 + i) },
  }));
  const usage = await factoryUsage({ tasks }, directory);
  assert.equal(Object.keys(usage).length, count, "Eviction never drops a result of the current call.");
  assert.ok(Object.values(usage).every((item) => item.workers.implementation!.credits === 1));
  assert.ok(cacheSize() <= 1024, `cache holds ${cacheSize()} entries`);
});

test("factoryUsage resolves missing sessions read-only with strict identity, time bounds, and pending-dir cache refresh", async (t) => {
  const { factoryUsage } = await import("./usage.ts");
  const { yamlField } = await import("./sessions.ts");
  assert.equal(yamlField("name: 'Investigate #1: don''t panic'\n", "name"), "Investigate #1: don't panic");
  assert.equal(yamlField('name: "Investigate #1: \\"quoted\\""\n', "name"), 'Investigate #1: "quoted"');
  assert.equal(yamlField("name: 'unterminated\n", "name"), undefined);
  assert.equal(yamlField("name: 'bad' quote'\n", "name"), undefined);
  assert.equal(yamlField("name: |\n  block\n", "name"), undefined);

  const directory = await sessions(t, {});
  const worktree = await mkdtemp(join(tmpdir(), "factory-usage-wt-"));
  const regDir = await mkdtemp(join(tmpdir(), "factory-usage-reg-"));
  t.after(() => rm(worktree, { recursive: true, force: true }));
  t.after(() => rm(regDir, { recursive: true, force: true }));

  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const writeSession = async (id: string, meta: { cwd: string; repository?: string; name?: string; created: number }, model: string, nano: number) => {
    await mkdir(join(directory, id), { recursive: true });
    const lines = [
      `id: ${id}`,
      `cwd: ${meta.cwd}`,
      ...(meta.repository ? [`repository: ${meta.repository}`] : []),
      ...(meta.name ? [`name: '${meta.name.replace(/'/g, "''")}'`] : []),
      `created_at: ${iso(meta.created)}`,
    ];
    await writeFile(join(directory, id, "workspace.yaml"), `${lines.join("\n")}\n`);
    await writeFile(join(directory, id, "events.jsonl"), `${event(0, "session.start")}\n${record(model, nano, 100, 10)}\n${event(2, "assistant.turn_end")}\n`);
  };

  // Closed historical investigation matched by name + repository; live implementation matched after workspace.yaml appears in existing dir.
  await writeSession(uuid(501), { cwd: "/some/primary/checkout", repository: "owner/repo", name: "Investigate #1: Bug", created: now - 50_000 }, "claude-opus-5.5", 2_000_000_000);
  // A much later session with the same name must not attach to an older closed worker whose window already ended.
  await writeSession(uuid(502), { cwd: "/some/primary/checkout", repository: "owner/repo", name: "Investigate #99: Old", created: now - 5_000 }, "claude-opus-5.5", 9_000_000_000);
  // Pre-create empty directory for implementation before workspace.yaml exists (tests pending-dir cache invalidation).
  await mkdir(join(directory, uuid(503)));

  const registry = join(regDir, "owner.repo-factory-sessions.jsonl");
  await writeFile(registry, `${JSON.stringify({ id: uuid(504), role: "factory", at: iso(now - 60_000) })}\n`);
  await writeSession(uuid(504), { cwd: worktree, repository: "owner/repo", created: now - 30_000 }, "coordinator-model", 8_000_000_000);

  const data = {
    project: "owner/repo",
    tasks: [
      {
        id: "issue-1",
        state: "implementation",
        updated_at: iso(now - 10_000),
        worktree: { path: worktree },
        history: [
          { state: "initial", at: iso(now - 65_000) },
          { state: "investigation", at: iso(now - 60_000) },
          { state: "implementation", at: iso(now - 40_000) },
        ],
        workers: {
          investigation: { status: "closed", name: "Investigate #1: Bug", launched_at: iso(now - 60_000) },
          implementation: { status: "running", launched_at: iso(now - 40_000) },
        },
      },
      {
        id: "issue-99",
        state: "resolved",
        updated_at: iso(now - 200_000),
        history: [
          { state: "initial", at: iso(now - 300_000) },
          { state: "investigation", at: iso(now - 290_000) },
          { state: "resolved", at: iso(now - 200_000) },
        ],
        workers: {
          investigation: { status: "closed", name: "Investigate #99: Old", launched_at: iso(now - 290_000) },
        },
      },
    ],
  };

  const before = await factoryUsage(data, directory, { registry, scanCacheMs: 60_000 });
  assert.deepEqual(before["issue-1"].workers.investigation?.models, ["claude-opus-5.5"]);
  assert.equal(before["issue-1"].workers.implementation, null, "Coordinator session uuid(504) in registry is excluded.");
  assert.equal(before["issue-99"].workers.investigation, null, "Closed worker upper bound blocks later same-name session.");
  assert.equal("session" in data.tasks[0].workers.investigation, false, "Read-only resolution never mutates factory data.");

  // Now workspace.yaml appears inside the already-existing directory uuid(503) while cacheMs is still active.
  await writeSession(uuid(503), { cwd: worktree, repository: "owner/repo", created: now - 20_000 }, "claude-sonnet-5.5", 3_000_000_000);
  const after = await factoryUsage(data, directory, { registry, scanCacheMs: 60_000 });
  assert.deepEqual(after["issue-1"].workers.implementation?.models, ["claude-sonnet-5.5"]);

  // A corrupt registry disables inferred attribution without breaking explicitly recorded sessions.
  const badRegistry = join(regDir, "corrupt-sessions.jsonl");
  await writeFile(badRegistry, "{not-json\n");
  const explicitTask = {
    id: "issue-explicit",
    state: "implementation",
    history,
    workers: { implementation: { session: uuid(503) } },
  };
  const degraded = await factoryUsage({ project: "owner/repo", tasks: [...data.tasks, explicitTask] }, directory, { registry: badRegistry });
  assert.equal(degraded["issue-1"].workers.investigation, null, "Inferred attribution stops on unreadable registry.");
  assert.deepEqual(degraded["issue-explicit"].workers.implementation?.models, ["claude-sonnet-5.5"], "Explicit sessions still report usage.");

  // Superseded registry session stays excluded in factoryUsage; frozen ambiguous worker protects its candidate;
  // closed worker without closed_at or following history step declines inference even when updated_at advances.
  const wtGuard = join(regDir, "wt-guard");
  await mkdir(wtGuard, { recursive: true });
  await writeSession(uuid(505), { cwd: wtGuard, repository: "owner/repo", created: now - 25_000 }, "claude-sonnet-5.5", 1_000_000_000);
  await writeSession(uuid(506), { cwd: wtGuard, repository: "owner/repo", created: now - 20_000 }, "claude-sonnet-5.5", 1_000_000_000);
  const guardRegistry = join(regDir, "guard-sessions.jsonl");
  await writeFile(guardRegistry, `${JSON.stringify({ id: uuid(505), role: "implementation", task: "relaunch-task", at: new Date(now - 15_000).toISOString() })}\n`);
  const guarded = await factoryUsage({
    project: "owner/repo",
    updated_at: new Date(now + 200_000).toISOString(),
    tasks: [
      {
        id: "relaunch-task",
        state: "implementation",
        updated_at: new Date(now + 200_000).toISOString(),
        worktree: { path: wtGuard },
        history: [{ state: "implementation", at: new Date(now - 30_000).toISOString() }],
        workers: { implementation: { status: "running", launched_at: new Date(now - 30_000).toISOString() } },
      },
      {
        id: "ambiguous-owner",
        state: "implementation",
        updated_at: new Date(now + 200_000).toISOString(),
        worktree: { path: wtGuard },
        history: [{ state: "implementation", at: new Date(now - 30_000).toISOString() }],
        workers: { implementation: { status: "running", launched_at: new Date(now - 30_000).toISOString(), session_scan: "ambiguous" } },
      },
      {
        id: "closed-unbounded",
        state: "implementation",
        updated_at: new Date(now + 200_000).toISOString(),
        worktree: { path: wtGuard },
        history: [{ state: "implementation", at: new Date(now - 30_000).toISOString() }],
        workers: { implementation: { status: "closed", launched_at: new Date(now - 30_000).toISOString() } },
      },
    ],
  }, directory, { registry: guardRegistry });
  assert.equal(guarded["relaunch-task"].workers.implementation, null, "Superseded registry session and contested candidate must not attach.");
  assert.equal(guarded["ambiguous-owner"].workers.implementation, null, "Frozen ambiguous worker stays unset.");
  assert.equal(guarded["closed-unbounded"].workers.implementation, null, "Closed worker without closed_at or next state declines inference.");

  // Independent check: a relaunched worker alone still cannot re-attach its own superseded registry session.
  const wtSolo = join(regDir, "wt-solo");
  await mkdir(wtSolo, { recursive: true });
  await writeSession(uuid(507), { cwd: wtSolo, repository: "owner/repo", created: now - 25_000 }, "claude-sonnet-5.5", 1_000_000_000);
  const soloRegistry = join(regDir, "solo-sessions.jsonl");
  await writeFile(soloRegistry, `${JSON.stringify({ id: uuid(507), role: "implementation", task: "solo-task", at: new Date(now - 15_000).toISOString() })}\n`);
  const solo = await factoryUsage({
    project: "owner/repo",
    tasks: [{
      id: "solo-task",
      state: "implementation",
      worktree: { path: wtSolo },
      history: [{ state: "implementation", at: new Date(now - 30_000).toISOString() }],
      workers: { implementation: { status: "running", launched_at: new Date(now - 30_000).toISOString() } },
    }],
  }, directory, { registry: soloRegistry });
  assert.equal(solo["solo-task"].workers.implementation, null, "Solo relaunched worker cannot re-attach its superseded registry session.");
});
