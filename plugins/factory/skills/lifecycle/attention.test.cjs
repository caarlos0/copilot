const assert = require("node:assert/strict");
const { appendFile, chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { delimiter, join } = require("node:path");
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
  const { scanAttention, openAttention, resolveAttention } = await import("./attention.mjs");

  let n = 0;
  const log = (type, data, at = requestedAt, task = null) =>
    appendFile(join(directory, "owner.repo-factory-events.jsonl"), `${JSON.stringify({ id: `e${++n}`, at, type, task, source: "attention", data })}\n`);
  const request = (session, extra = {}, at = requestedAt) =>
    log("attention.requested", { session, kind: "sandbox-bypass", text: "Run command: ls", role: "implementation", pane: "block:aaaa", ...extra }, at, "fix-it");
  const sessionLog = async (session, ...events) => {
    await mkdir(join(state, session), { recursive: true });
    await appendFile(join(state, session, "events.jsonl"), events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  };
  // A fake `rex` first on PATH. The real one fails on `block ls -A --json`.
  const originalPath = process.env.PATH;
  t.after(() => { process.env.PATH = originalPath; });
  const fakeRex = async (script) => {
    const bin = join(directory, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "rex"), `#!/bin/sh\n[ "$1" = "--autostart=false" ] && shift\n${script}\n`);
    await chmod(join(bin, "rex"), 0o755);
    process.env.PATH = `${bin}${delimiter}${originalPath}`;
  };
  const events = async () => (await readFile(join(directory, "owner.repo-factory-events.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  return { directory, file, log, request, sessionLog, fakeRex, events, scanAttention, openAttention, resolveAttention };
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

test("an answer is found even when the session wrote more than one tail after it", async (t) => {
  const f = await setup(t);
  await f.request("busy");
  await f.request("still-waiting");
  const filler = (at) => ({ type: "assistant.message", data: { content: "x".repeat(1000) }, timestamp: at });
  const later = Array.from({ length: 700 }, (_, i) => filler(new Date(Date.parse(after) + 1000 + i).toISOString()));
  const before = Array.from({ length: 700 }, (_, i) => filler(new Date(Date.parse(requestedAt) - 3_600_000 + i).toISOString()));
  await f.sessionLog("busy", ...before, { ...fixtures.permissionRequested, timestamp: requestedAt },
    { ...fixtures.permissionCompleted, timestamp: after }, ...later);
  await f.sessionLog("still-waiting", ...before, { ...fixtures.permissionRequested, timestamp: requestedAt }, ...later);

  const { open, resolved } = await f.scanAttention(f.file, { now, panes: null });
  assert.deepEqual(open.map((item) => item.session), ["still-waiting"]);
  assert.deepEqual(resolved.map(({ item, reason }) => [item.session, reason]), [["busy", "answered"]]);
});

test("asks Rex for the live panes, and a pane Rex no longer lists is resolved", async (t) => {
  const f = await setup(t);
  await f.request("gone", { pane: "block:01a1f4d3-c03e-7f0b-bc24-060b0352db5f" });
  await f.request("live", { pane: "block:01a1f4e8-4bb0-72d2-bff2-25420482aad9" });
  await f.fakeRex(`case "$*" in
  "block ls -A -q --short=false") printf 'block:01a1f4e8-4bb0-72d2-bff2-25420482aad9\\nblock:01a1f4e9-0000-7000-8000-000000000000\\n' ;;
  *) echo "Error: unexpected arguments: $*" >&2; exit 1 ;;
esac`);

  const { open, resolved } = await f.scanAttention(f.file, { now });
  assert.deepEqual(open.map((item) => item.session), ["live"]);
  assert.deepEqual(resolved.map(({ item, reason }) => [item.session, reason]), [["gone", "pane-gone"]]);
});

test("the pane check is skipped when Rex fails or lists nothing", async (t) => {
  const f = await setup(t);
  await f.request("pane", { pane: "block:01a1f4d3-c03e-7f0b-bc24-060b0352db5f" });
  await f.fakeRex("echo 'Error: no server' >&2; exit 1");
  assert.equal((await f.openAttention(f.file, { now })).length, 1);
  await f.fakeRex("exit 0");
  assert.equal((await f.openAttention(f.file, { now })).length, 1);
});

test("resolveAttention records one resolved event per closed session, once", async (t) => {
  const f = await setup(t);
  await f.request("gone", { pane: "block:01a1-gone" });
  await f.request("gone", { pane: "block:01a1-gone" });
  await f.request("old", {}, "2026-04-29T12:00:00.000Z");
  await f.request("open", { pane: "block:01a1-live" });

  const scan = await f.resolveAttention(f.file, { source: "attention", now, panes: ["block:01a1-live"] });
  assert.deepEqual(scan.open.map((item) => item.session), ["open"]);
  const resolved = (await f.events()).filter(({ type }) => type === "attention.resolved");
  assert.deepEqual(resolved.map(({ source, data }) => [source, data.session, data.reason]), [
    ["attention", "gone", "pane-gone"],
    ["attention", "old", "expired"],
  ]);
  await f.resolveAttention(f.file, { source: "attention", now, panes: ["block:01a1-live"] });
  assert.equal((await f.events()).filter(({ type }) => type === "attention.resolved").length, 2);
});
