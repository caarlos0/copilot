const assert = require("node:assert/strict");
const { appendFile, mkdir, mkdtemp, open, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const fixtures = require("../../hooks/fixtures/session-log-events.json");

const requestedAt = "2026-05-01T12:00:00.000Z";
const after = "2026-05-01T12:00:25.000Z";
const before = "2026-05-01T11:59:00.000Z";
const now = Date.parse("2026-05-01T12:10:00.000Z");

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "attention-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, "session-state");
  await mkdir(state);
  process.env.FACTORY_SESSION_STATE = state;
  t.after(() => delete process.env.FACTORY_SESSION_STATE);
  const file = join(directory, "owner.repo-factory.json");
  await writeFile(file, JSON.stringify({ tasks: [{ id: "fix-it", title: "Fix the thing" }] }));
  const { scanAttention, openAttention } = await import("./attention.mjs");

  let n = 0;
  const log = (type, data, at = requestedAt, task = null) =>
    appendFile(join(directory, "owner.repo-factory-events.jsonl"), `${JSON.stringify({ id: `e${++n}`, at, type, task, source: "attention", data })}\n`);
  const request = (session, extra = {}, at = requestedAt) =>
    log("attention.requested", { session, kind: "sandbox-bypass", text: "Run command: ls", role: "implementation", pane: "block:aaaa", ...extra }, at, "fix-it");
  const sessionLog = async (session, ...events) => {
    await mkdir(join(state, session), { recursive: true });
    await appendFile(join(state, session, "events.jsonl"), events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  };
  return { directory, file, log, request, sessionLog, scanAttention, openAttention };
}

test("lists a request with no resolved event after it, with the task title", async (t) => {
  const f = await setup(t);
  await f.request("s1", { options: ["a", "b"] });
  await f.request("s2");
  await f.log("attention.resolved", { session: "s2" }, after);
  await f.request("s2", { text: "second" }, after);
  await f.request("s3");
  await f.log("attention.resolved", { session: "s3" }, after);

  const open = await f.openAttention(f.file, { now, panes: null });
  assert.deepEqual(open.map((item) => [item.session, item.text]), [["s1", "Run command: ls"], ["s2", "second"]]);
  assert.deepEqual(open[0], {
    id: "e1", at: requestedAt, session: "s1", task: "fix-it", role: "implementation", kind: "sandbox-bypass",
    text: "Run command: ls", options: ["a", "b"], pane: "block:aaaa", title: "Fix the thing",
  });
});

test("an absent events log has no open items", async (t) => {
  const f = await setup(t);
  assert.deepEqual(await f.openAttention(f.file, { now, panes: null }), []);
});

test("a permission.completed after the request resolves it; one before does not", async (t) => {
  const f = await setup(t);
  await f.request("answered");
  await f.request("old");
  await f.request("none");
  await f.sessionLog("answered", { ...fixtures.permissionRequested, timestamp: requestedAt }, { ...fixtures.permissionCompleted, timestamp: after });
  await f.sessionLog("old", { ...fixtures.permissionCompleted, timestamp: before });

  const { open, resolved } = await f.scanAttention(f.file, { now, panes: null });
  assert.deepEqual(open.map((item) => item.session), ["old", "none"]);
  assert.deepEqual(resolved.map(({ item, reason }) => [item.session, reason]), [["answered", "answered"]]);
});

test("an ask_user completion resolves, matched to its start by tool call ID", async (t) => {
  const f = await setup(t);
  await f.request("asked", { kind: "ask-user" });
  await f.request("other-tool", { kind: "ask-user" });
  await f.sessionLog("asked",
    { ...fixtures.askUserStart, timestamp: requestedAt },
    { ...fixtures.askUserComplete, timestamp: after });
  await f.sessionLog("other-tool",
    { ...fixtures.askUserStart, timestamp: requestedAt },
    { ...fixtures.askUserComplete, data: { ...fixtures.askUserComplete.data, toolCallId: "toolu_unrelated" }, timestamp: after });

  const open = await f.openAttention(f.file, { now, panes: null });
  assert.deepEqual(open.map((item) => item.session), ["other-tool"]);
});

test("a pane missing from Rex resolves; a short ID matches; null skips the check", async (t) => {
  const f = await setup(t);
  await f.request("gone", { pane: "block:01a1-gone" });
  await f.request("live", { pane: "block:01a1-live" });
  await f.request("nopane", { pane: undefined });

  const run = async (panes) => (await f.scanAttention(f.file, { now, panes })).open.map((item) => item.session);
  assert.deepEqual(await run(["block:01a1-live"]), ["live", "nopane"]);
  assert.deepEqual(await run(["block:00000000-01a1-live"]), ["live", "nopane"]);
  assert.deepEqual(await run(null), ["gone", "live", "nopane"]);
  const { resolved } = await f.scanAttention(f.file, { now, panes: ["block:01a1-live"] });
  assert.deepEqual(resolved.map(({ item, reason }) => [item.session, reason]), [["gone", "pane-gone"]]);
});

test("an item older than 24 hours is resolved", async (t) => {
  const f = await setup(t);
  await f.request("ancient", {}, "2026-04-29T12:00:00.000Z");
  await f.request("recent", {}, "2026-04-30T13:00:00.000Z");
  const { open, resolved } = await f.scanAttention(f.file, { now, panes: null });
  assert.deepEqual(open.map((item) => item.session), ["recent"]);
  assert.deepEqual(resolved.map(({ item, reason }) => [item.session, reason]), [["ancient", "expired"]]);
});

test("a session id that is not a plain name is never read as a path", async (t) => {
  const f = await setup(t);
  await f.request("../escape");
  assert.equal((await f.openAttention(f.file, { now, panes: null })).length, 1);
});

test("reads only the tail of a huge session log, and fast", async (t) => {
  const f = await setup(t);
  await f.request("big");
  const folder = join(f.directory, "session-state", "big");
  await mkdir(folder);
  // A sparse 600 MB file: reading it whole would fail or take seconds.
  const handle = await open(join(folder, "events.jsonl"), "w");
  const size = 600 * 1024 * 1024;
  await handle.truncate(size);
  const tail = [
    "{\"broken\":",
    JSON.stringify({ ...fixtures.permissionRequested, timestamp: requestedAt }),
    JSON.stringify({ ...fixtures.permissionCompleted, timestamp: after }),
  ].join("\n") + "\n";
  await handle.write(tail, size);
  await handle.close();

  const started = performance.now();
  const open2 = await f.openAttention(f.file, { now, panes: null });
  assert.deepEqual(open2, []);
  assert.ok(performance.now() - started < 1000, `took ${performance.now() - started} ms`);
});
