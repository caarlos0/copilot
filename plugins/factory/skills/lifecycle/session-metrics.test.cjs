const assert = require("node:assert/strict");
const { mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");

const script = join(__dirname, "session-metrics.mjs");
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const start = Date.parse("2026-05-01T12:00:00Z");

const event = (seconds, type, data = {}) =>
  JSON.stringify({ type, data, timestamp: new Date(start + seconds * 1000).toISOString() });
const bash = (seconds, id, command, success = true) => [
  event(seconds, "tool.execution_start", { toolCallId: id, toolName: "bash", arguments: { command } }),
  event(seconds, "tool.execution_complete", { toolCallId: id, success }),
];

// Time in seconds: 5 s of work, a 20 min wait for the user, then a 1 min wait for a wake-up.
const events = [
  event(0, "user.message", { content: "SECRET-PROMPT" }),
  event(1, "assistant.turn_start"),
  ...bash(2, "a", "sleep 30 && gh pr checks 5 -R secret/repo"),
  ...bash(3, "b", "gh pr checks 5 -R secret/repo --watch --fail-fast", false),
  ...bash(3, "c", "gh wait 5"),
  ...bash(3, "e", "node /skills/lifecycle/pr-watch.mjs 5 --merge"),
  event(3, "tool.execution_start", { toolCallId: "d", toolName: "ask_user", arguments: { message: "SECRET-QUESTION" } }),
  event(3, "tool.execution_complete", { toolCallId: "d", success: true }),
  event(4, "session.usage_record", { usage: { model: "m1", cost: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, duration: 2000 } }),
  event(5, "assistant.turn_end"),
  event(1205, "user.message", { content: "SECRET-PROMPT" }),
  event(1206, "assistant.turn_start"),
  event(1207, "session.usage_record", { usage: { model: "m2", cost: 2, inputTokens: 200, outputTokens: 20, duration: 3000 } }),
  event(1210, "assistant.turn_end"),
  event(1270, "assistant.turn_start"),
  "{not json",
  event(1275, "assistant.turn_end"),
];

async function fixture(t, { registry = [{ id: first, role: "implementation", task: "issue-1", at: "2026-05-01T11:00:00Z" }] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "metrics-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, first));
  await writeFile(join(directory, first, "events.jsonl"), `${events.join("\n")}\n`);
  const file = join(directory, "owner.repo-factory-sessions.jsonl");
  await writeFile(file, registry.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  const run = (...args) => spawnSync(process.execPath, [script, "--directory", directory, ...args], { encoding: "utf8" });
  return { directory, file, run };
}

test("measures waits, commands, tools, and usage without exposing content", async (t) => {
  const f = await fixture(t, {
    registry: [
      { id: first, role: "implementation", task: "issue-1", at: "2026-05-01T11:00:00Z" },
      { id: second, role: "improver", rule: "self", at: "2026-05-01T11:30:00Z" },
    ],
  });
  const result = f.run("--registry", f.file);
  assert.equal(result.status, 0, result.stderr);
  for (const secret of ["SECRET-PROMPT", "SECRET-QUESTION", "secret/repo"]) {
    assert.ok(!result.stdout.includes(secret), `${secret} must not be in the report`);
  }
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.missing, [second]);
  assert.equal(report.sessions.length, 1);
  assert.deepEqual(report.sessions[0], {
    id: first, role: "implementation", task: "issue-1",
    events: 20, skipped_lines: 1,
    started_at: "2026-05-01T12:00:00.000Z", ended_at: "2026-05-01T12:21:15.000Z", wall_minutes: 21.25,
    user_messages: 2, turns: 3,
    idle: { minutes: 21, over_10_minutes: 1, longest_minutes: 20 },
    tools: { bash: { calls: 4, failures: 1 }, ask_user: { calls: 1, failures: 0 } },
    commands: { sleep: 1, gh_wait: 2, watch: 1, status_reads: 1 },
    usage: { cost: 3, input_tokens: 300, output_tokens: 30, cache_read_tokens: 50, model_seconds: 5, models: ["m1", "m2"] },
  });
  assert.deepEqual(report.totals, {
    sessions: 1, wall_minutes: 21.25, user_messages: 2, turns: 3,
    idle_minutes: 21, idle_over_10_minutes: 1, ask_user_calls: 1,
    commands: { sleep: 1, gh_wait: 2, watch: 1, status_reads: 1 },
    usage: { cost: 3, input_tokens: 300, output_tokens: 30, cache_read_tokens: 50, model_seconds: 5 },
  });
});

test("streams the log: blank lines, CRLF, and a last line without a newline", async (t) => {
  const f = await fixture(t);
  const lines = [event(0, "user.message"), "", event(1, "assistant.turn_start"), event(2, "assistant.turn_end")];
  await writeFile(join(f.directory, first, "events.jsonl"), `${lines.slice(0, 3).join("\r\n")}\n${lines[3]}`);
  const [session] = JSON.parse(f.run(first).stdout).sessions;
  assert.equal(session.events, 3);
  assert.equal(session.skipped_lines, 0);
  assert.equal(session.turns, 1);
  assert.equal(session.ended_at, "2026-05-01T12:00:02.000Z");
});

test("--since keeps sessions registered at or after that time; IDs work without a registry", async (t) => {
  const f = await fixture(t);
  const since = (time) => JSON.parse(f.run("--registry", f.file, "--since", time).stdout);
  assert.equal(since("2026-05-01T11:00:00Z").sessions.length, 1);
  assert.equal(since("2026-05-01T11:00:01Z").sessions.length, 0);
  const direct = JSON.parse(f.run(first).stdout);
  assert.equal(direct.sessions[0].id, first);
  assert.equal(direct.sessions[0].role, undefined);
});

test("--since always keeps the factory session", async (t) => {
  const f = await fixture(t, { registry: [{ id: first, role: "factory", at: "2026-05-01T11:00:00Z" }] });
  const result = JSON.parse(f.run("--registry", f.file, "--since", "2026-05-02T00:00:00Z").stdout);
  assert.deepEqual(result.sessions.map((item) => item.role), ["factory"]);
});

test("--active-since includes sessions that started earlier and counts only the window", async (t) => {
  const f = await fixture(t, {
    registry: [
      { id: first, role: "implementation", task: "issue-1", at: "2026-05-01T09:00:00Z" },
      { id: second, role: "implementation", task: "issue-2", at: "2026-05-01T09:00:00Z" },
    ],
  });
  // The second session ran from 10:00:00 to 10:01:40, two hours before the first.
  const old = [event(-7200, "user.message"), event(-7199, "assistant.turn_start"), event(-7100, "assistant.turn_end")];
  await mkdir(join(f.directory, second));
  await writeFile(join(f.directory, second, "events.jsonl"), `${old.join("\n")}\n`);
  const run = (time) => JSON.parse(f.run("--registry", f.file, "--active-since", time).stdout);

  const late = run("2026-05-01T12:20:06Z");
  assert.equal(late.active_since, "2026-05-01T12:20:06.000Z");
  assert.deepEqual(late.started_before_window, [first]);
  assert.deepEqual(late.sessions.map((item) => item.id), [first]);
  const [session] = late.sessions;
  assert.equal(session.started_before_window, true);
  assert.equal(session.started_at, "2026-05-01T12:20:06.000Z");
  assert.equal(session.user_messages, 0);
  assert.equal(session.turns, 2);
  assert.equal(session.commands.sleep, 0);
  assert.equal(session.usage.cost, 2);
  assert.deepEqual(session.usage.models, ["m2"]);
  assert.equal(late.totals.sessions, 1);

  const both = run("2026-05-01T10:01:00Z");
  assert.deepEqual(both.sessions.map((item) => [item.id, item.started_before_window]), [[first, false], [second, true]]);
  assert.deepEqual(both.started_before_window, [second]);
  assert.equal(both.sessions[0].usage.cost, 3);
  assert.equal(run("2026-05-01T12:30:00Z").sessions.length, 0);
});

test("usage errors exit 2 and a bad registry exits 1", async (t) => {
  const f = await fixture(t);
  for (const args of [[], ["../etc"], [first, "--registry", f.file], ["--registry", f.file, "--since", "soon"], ["--registry", f.file, "--active-since", "soon"], ["--registry", f.file, "--since", "2026-05-01T00:00:00Z", "--active-since", "2026-05-01T00:00:00Z"]]) {
    const result = f.run(...args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /Run with --help/);
  }
  await writeFile(f.file, '{"id":"nope","role":"factory","at":"2026-05-01T11:00:00Z"}\n');
  const result = f.run("--registry", f.file);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /line 1 is not a session entry/);
});
