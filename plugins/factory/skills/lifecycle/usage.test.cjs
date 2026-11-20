const assert = require("node:assert/strict");
const { mkdir, mkdtemp, rm, utimes, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");

const ids = {
  a: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  b: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  c: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  gone: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
};

const event = (minute, type, data = {}) =>
  JSON.stringify({ type, timestamp: new Date(Date.UTC(2026, 4, 1, 12, minute)).toISOString(), data });
const record = (model, nano, input, output) => event(1, "session.usage_record", {
  usage: { model, inputTokens: input, outputTokens: output, ...(nano === null ? {} : { copilotUsage: { totalNanoAiu: nano } }) },
});

async function sessions(t, logs) {
  const directory = await mkdtemp(join(tmpdir(), "factory-usage-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [id, lines] of Object.entries(logs)) {
    await mkdir(join(directory, id));
    await writeFile(join(directory, id, "events.jsonl"), `${lines.join("\n")}\n`);
  }
  return directory;
}

const task = (workers, state = "implementation", history = [
  { state: "initial", at: "2026-05-01T10:00:00Z" },
  { state: state, at: "2026-05-01T10:30:00Z" },
]) => ({ id: "issue-1", state, workers, history });

test("sums models, credits, tokens and active time per worker and per task", async (t) => {
  const { taskUsage } = await import("./usage.mjs");
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
    models: ["m1", "m2"], credits: 3.75, input_tokens: 300, output_tokens: 30, active_minutes: 5,
  });
  assert.equal(usage.workers.implementation.credits, 0.5);
  assert.deepEqual(usage.workers.review, usage.workers.investigation);
  assert.deepEqual(usage.total, {
    models: ["m1", "m2"], credits: 4.25, input_tokens: 350, output_tokens: 35, active_minutes: 7,
  }, "A session shared by two roles counts once in the total.");
  assert.equal(usage.started_at, "2026-05-01T10:00:00Z");
  assert.equal(usage.ended_at, null, "An open task has no end.");
});

test("falls back to tokens when a log has no credits, and the total follows", async (t) => {
  const { taskUsage } = await import("./usage.mjs");
  const directory = await sessions(t, {
    [ids.a]: [event(0, "session.start"), record("m1", 1_000_000_000, 10, 1)],
    [ids.b]: [event(0, "session.start"), record("m1", null, 20, 2)],
  });
  const usage = await taskUsage(task({ investigation: { session: ids.a }, implementation: { session: ids.b } }), directory);
  assert.equal(usage.workers.investigation.credits, 1);
  assert.equal(usage.workers.implementation.credits, null);
  assert.equal(usage.total.credits, null);
  assert.deepEqual([usage.total.input_tokens, usage.total.output_tokens], [30, 3]);
});

test("a missing, unnamed, empty or foreign session is n/a, never an error", async (t) => {
  const { taskUsage } = await import("./usage.mjs");
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
  const { sessionUsage } = await import("./usage.mjs");
  const directory = await sessions(t, { [ids.a]: [event(0, "session.start"), record("m1", 1_000_000_000, 1, 1)] });
  const file = join(directory, ids.a, "events.jsonl");
  const before = await sessionUsage(ids.a, directory);
  const stamp = new Date(Date.now() - 60_000);
  await writeFile(file, `${event(0, "session.start")}\n${record("m9", 9_000_000_000, 9, 9)}\n`);
  await utimes(file, stamp, stamp);
  // The rewrite changes size and time, but a log read moments ago is served from the cache.
  assert.deepEqual(await sessionUsage(ids.a, directory), before);
});
