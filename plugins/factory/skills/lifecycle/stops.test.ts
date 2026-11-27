import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { eventsFile } from "./broker.ts";
import { groupStops, type Factory } from "./factory-data.ts";
import { causeTaskId, causeTaskValues, causes, classes, clip, detectStops, dismissStop, isStopDismissed, recordStop, scanStops, stopId } from "./stops.ts";
import type { Stop } from "./stops.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "stops-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "owner.repo-factory.json");
}

const stop = (key: string, extra: Partial<Stop> = {}): Stop => ({
  stop_id: stopId("worker-quiet", "t1", "implementation", key),
  cause: "worker-quiet",
  task: "t1",
  role: "implementation",
  class: "worker-fixable",
  detail: "The worker was quiet for 12 minutes.",
  count: 1,
  ...extra,
});

test("stopId joins cause, task, role and key, and uses - for a missing task or role", () => {
  assert.equal(stopId("worker-quiet", "t1", "review", "k"), "worker-quiet:t1:review:k");
  assert.equal(stopId("repeated-permission", null, null, "k"), "repeated-permission:-:-:k");
  assert.match(causeTaskId("a"), /^cause-[0-9a-f]{8}$/);
  assert.equal(causeTaskId("a"), causeTaskId("a"));
  assert.notEqual(causeTaskId("a"), causeTaskId("b"));
});

test("recordStop appends one stop.recorded event per stop_id", async (t) => {
  const file = await fixture(t);
  assert.deepEqual(await recordStop(file, stop("k1")), { recorded: true });
  assert.deepEqual(await recordStop(file, stop("k1", { detail: "Other text." })), { recorded: false });
  assert.deepEqual(await recordStop(file, stop("k2")), { recorded: true });
  const events = (await readFile(eventsFile(file), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "stop.recorded");
  assert.equal(events[0].source, "stops");
  assert.equal(events[0].task, "t1");
  assert.equal(events[0].data.detail, "The worker was quiet for 12 minutes.");
});

test("recordStop refuses a cause or a class that is not in the lists", async (t) => {
  const file = await fixture(t);
  assert.ok(causes.includes("emit-refused") && classes.includes("none"));
  await assert.rejects(recordStop(file, stop("k", { cause: "tired" })), /cause must be one of/);
  await assert.rejects(recordStop(file, stop("k", { class: "someone" })), /class must be one of/);
  await assert.rejects(readFile(eventsFile(file), "utf8"), { code: "ENOENT" });
});

test("scanStops links a stop to the task whose details.stop_id equals it", async (t) => {
  const file = await fixture(t);
  assert.deepEqual(await scanStops(file, { tasks: [] } as unknown as Factory), []);
  await recordStop(file, stop("k1"));
  await recordStop(file, stop("k2", { task: null, role: null }));
  const factory = { tasks: [
    { id: "t1", state: "implementation", details: null },
    { id: causeTaskId(stop("k1").stop_id), state: "investigation", details: { stop_id: stop("k1").stop_id, cause_of: "t1" } },
  ] } as unknown as Factory;
  const [linked, open] = await scanStops(file, factory);
  assert.equal(linked.cause_task, causeTaskId(stop("k1").stop_id));
  assert.equal(linked.cause_state, "investigation");
  assert.equal(linked.task, "t1");
  assert.equal(open.cause_task, null);
  assert.equal(open.cause_state, null);
  assert.equal(open.task, null);
});

const baseTime = Date.parse("2026-05-01T12:00:00Z");
const atOffset = (ms: number) => new Date(baseTime + ms).toISOString();
const event = (type: string, task: string | null, data: Record<string, unknown>, id = `${type}-${Math.random()}`, at = atOffset(0)) =>
  ({ id, at, type, task, source: "test", data });
const prompt = (session: string, text: string, extra: Record<string, unknown> = {}, offsetMs = 0) =>
  event("attention.requested", null, { session, kind: "permission", text, ...extra }, undefined, atOffset(offsetMs));
const world = (tasks: object[]) => ({ tasks } as unknown as Factory);
const open = (id: string, extra: object = {}) => ({ id, state: "implementation", workers: {}, ...extra });

test("detectStops names a blocked task with its class, and none for an old blocker", () => {
  const blocked = (id: string, blocker: object) => open(id, { state: "blocked", blocker: { from: "implementation", since: "2026-05-01T10:00:00Z", ...blocker } });
  const stops = detectStops(world([
    blocked("a", { reason: "Needs a decision.", class: "user-decision" }),
    blocked("b", { reason: "Old blocker." }),
    open("c"),
  ]), []);
  assert.deepEqual(stops.map(({ cause, task, class: kind }) => [cause, task, kind]), [
    ["blocked", "a", "user-decision"],
    ["blocked", "b", "none"],
  ]);
  assert.equal(stops[0].stop_id, "blocked:a:-:2026-05-01T10:00:00Z");
});

test("detectStops reports a worker.blocked that nothing cleared", () => {
  const blocked = event("worker.blocked", "t1", { role: "implementation", reason: "No access." }, "e1");
  const moved = (to: string) => event("task.moved", "t1", { to });
  const stops = (events: ReturnType<typeof event>[], task = open("t1")) => detectStops(world([task]), events);

  assert.deepEqual(stops([blocked]).map(({ stop_id, class: kind }) => [stop_id, kind]), [["worker-blocked:t1:implementation:e1", "worker-fixable"]]);
  assert.equal(stops([blocked, moved("blocked")]).length, 1);
  assert.equal(stops([blocked, moved("review")]).length, 0);
  assert.equal(stops([blocked], open("t1", { workers: { implementation: { status: "running" } } })).length, 0);
  assert.equal(stops([blocked], open("t1", { state: "resolved" })).length, 0);
});

test("detectStops turns quiet minutes into a worker-quiet stop keyed by the launch time", () => {
  const task = open("t1", { workers: { implementation: { status: "running", launched_at: "2026-05-01T09:00:00Z" } } });
  const [stop] = detectStops(world([task]), [], [{ task: "t1", role: "implementation", minutes: 12 }]);
  assert.equal(stop.stop_id, "worker-quiet:t1:implementation:2026-05-01T09:00:00Z");
  assert.match(stop.detail, /12 minutes/);
  assert.deepEqual(detectStops(world([task]), []), []);
});

test("detectStops reports the same prompt in one session 2 or more times, not different ones", () => {
  const text = "x".repeat(150);
  const stops = detectStops(world([]), [
    prompt("s1", text + "a", {}, 0), prompt("s1", text + "b", {}, 5000),
    prompt("s2", "Run ls.", {}, 0), prompt("s2", "Run pwd.", {}, 5000),
    prompt("s3", "Run ls.", {}, 0), prompt("s4", "Run ls.", {}, 5000),
    prompt("s5", "Run ls.", { kind: "sandbox-bypass" }, 0), prompt("s5", "Run ls.", {}, 5000),
    prompt("s6", "Ask.", { kind: "ask-user" }, 0), prompt("s6", "Ask.", { kind: "ask-user" }, 5000),
  ]);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].cause, "repeated-permission");
  assert.equal(stops[0].count, 2);
  assert.equal(stops[0].task, null);
});

test("detectStops ignores duplicate prompts within 2000 ms and keeps real repeats", () => {
  assert.deepEqual(detectStops(world([]), [
    prompt("s1", "Run ls.", {}, 0),
    prompt("s1", "Run ls.", {}, 350),
    prompt("s2", "Run ls.", {}, 0),
    prompt("s2", "Run ls.", {}, 2000),
  ]), []);

  const [boundary] = detectStops(world([]), [
    prompt("s3", "Run ls.", {}, 0),
    prompt("s3", "Run ls.", {}, 2001),
  ]);
  assert.equal(boundary.cause, "repeated-permission");
  assert.equal(boundary.count, 2);

  // Two real prompts that each emitted a duplicate pair count as 2, not 4.
  const [paired] = detectStops(world([]), [
    prompt("s4", "Run ls.", {}, 0),
    prompt("s4", "Run ls.", {}, 400),
    prompt("s4", "Run ls.", {}, 10_000),
    prompt("s4", "Run ls.", {}, 10_350),
  ]);
  assert.equal(paired.cause, "repeated-permission");
  assert.equal(paired.count, 2);
});

test("detectStops maps the session of a prompt to a task, else keeps the event role", () => {
  const owned = open("t1", { workers: { review: { status: "running", session: "s1" } } });
  const [mapped, unmapped] = detectStops(world([owned]), [
    prompt("s1", "Run ls.", { role: "implementation" }, 0), prompt("s1", "Run ls.", { role: "implementation" }, 5000),
    prompt("s9", "Run ls.", { role: "implementation" }, 0), prompt("s9", "Run ls.", { role: "implementation" }, 5000),
  ]);
  assert.deepEqual([mapped.task, mapped.role], ["t1", "review"]);
  assert.deepEqual([unmapped.task, unmapped.role], [null, "implementation"]);
});

test("detectStops reports repeated conflicts only for 2 or more different heads of one task", () => {
  const refused = (task: string, head?: string) => event("stop.recorded", task, { cause: "emit-refused", role: "implementation", ...(head && { head }) });
  const stops = (...events: ReturnType<typeof event>[]) => detectStops(world([]), events);

  assert.equal(stops(refused("t1", "a".repeat(40))).length, 0);
  assert.equal(stops(refused("t1", "a".repeat(40)), refused("t1", "a".repeat(40))).length, 0);
  assert.equal(stops(refused("t1", "a".repeat(40)), refused("t2", "b".repeat(40))).length, 0);
  assert.equal(stops(refused("t1", "a".repeat(40)), refused("t1")).length, 0);
  const [stop] = stops(refused("t1", "a".repeat(40)), refused("t1", "b".repeat(40)), refused("t1", "c".repeat(40)));
  assert.equal(stop.stop_id, `repeated-conflict:t1:implementation:${"a".repeat(12)}`);
  assert.equal(stop.count, 3);
  assert.equal(stop.class, "worker-fixable");
});

test("dismissStop records stop.dismissed once, hides the stop from scanStops, and prevents re-recording", async (t) => {
  const file = await fixture(t);
  const first = stop("k1");
  const second = stop("k2", { task: null, role: null });
  await recordStop(file, first);
  await recordStop(file, second);

  assert.equal(await dismissStop(file, "missing"), null);
  assert.deepEqual(await dismissStop(file, first.stop_id), { dismissed: true, recorded: true });
  assert.deepEqual(await dismissStop(file, first.stop_id), { dismissed: true, recorded: false });
  assert.equal(await isStopDismissed(file, first.stop_id), true);
  assert.equal(await isStopDismissed(file, second.stop_id), false);

  assert.deepEqual(await recordStop(file, first), { recorded: false }, "A dismissed stop is already recorded and is not appended again.");
  const scanned = await scanStops(file, world([]));
  assert.deepEqual(scanned.map(({ stop_id }) => stop_id), [second.stop_id]);
  const lines = (await readFile(eventsFile(file), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const dismissed = lines.filter(({ type }) => type === "stop.dismissed");
  assert.equal(dismissed.length, 1);
  assert.deepEqual([dismissed[0].source, dismissed[0].task, dismissed[0].data], ["stops", null, { stop_id: first.stop_id }]);

  assert.deepEqual(causeTaskValues(first), {
    task: causeTaskId(first.stop_id),
    title: "Cause: worker-quiet in t1",
    issue: "null",
    "next-action": "Find the root cause. Then propose a prevention, not only a retry.",
    details: JSON.stringify({ stop_id: first.stop_id, cause_of: "t1" }),
  });
  assert.deepEqual(causeTaskValues(second), {
    task: causeTaskId(second.stop_id),
    title: "Cause: worker-quiet in no task",
    issue: "null",
    "next-action": "Find the root cause. Then propose a prevention, not only a retry.",
    details: JSON.stringify({ stop_id: second.stop_id, cause_of: null }),
  });
});

test("emit-refused stops auto-resolve on a later accepted worker.result for the same task and role", async (t) => {
  const file = await fixture(t);
  const appendResult = (task: string, role: string, outcome = "complete") => appendFile(
    eventsFile(file),
    `${JSON.stringify({ id: `r-${Math.random()}`, at: new Date().toISOString(), type: "worker.result", task, source: "worker", data: { role, outcome } })}\n`,
  );
  const refused = (task: string, role: string, key = "bad-result", detail = 'Result file t1-result.json is missing the "task" key.'): Stop => ({
    stop_id: stopId("emit-refused", task, role, key),
    cause: "emit-refused",
    task,
    role,
    class: "worker-fixable",
    detail,
    count: 1,
  });
  const permission: Stop = {
    stop_id: stopId("repeated-permission", "t1", "implementation", "p1"),
    cause: "repeated-permission",
    task: "t1",
    role: "implementation",
    class: "worker-fixable",
    detail: "The worker asked for the same permission approval 2 times in one session.",
    count: 2,
  };

  // An earlier worker.result does not resolve a later refusal.
  await appendResult("t1", "implementation");
  await recordStop(file, refused("t1", "implementation"));
  await recordStop(file, refused("t1", "review"));
  await recordStop(file, refused("t2", "implementation"));
  await recordStop(file, permission);

  assert.deepEqual((await scanStops(file, world([]))).map(({ stop_id }) => stop_id), [
    "emit-refused:t1:implementation:bad-result",
    "emit-refused:t1:review:bad-result",
    "emit-refused:t2:implementation:bad-result",
    permission.stop_id,
  ]);

  // A later worker.result for (t1, implementation) hides that emit-refused stop, not other roles, tasks, or repeated-permission.
  await appendResult("t1", "implementation");
  assert.deepEqual((await scanStops(file, world([]))).map(({ stop_id }) => stop_id), [
    "emit-refused:t1:review:bad-result",
    "emit-refused:t2:implementation:bad-result",
    permission.stop_id,
  ]);

  // A new unfixed refusal for (t1, implementation) after auto-resolve records again with the new detail.
  const second = refused("t1", "implementation", "bad-result", 'Result file t1-result.json has outcome "working", but the event has "complete".');
  assert.deepEqual(await recordStop(file, second), { recorded: true });
  const reopened = (await scanStops(file, world([]))).find(({ stop_id }) => stop_id === second.stop_id);
  assert.equal(reopened?.detail, second.detail);

  // A dismissed emit-refused stop stays dismissed even if refused again after a worker.result.
  await dismissStop(file, second.stop_id);
  await appendResult("t1", "implementation");
  assert.deepEqual(await recordStop(file, second), { recorded: false });
  assert.equal((await scanStops(file, world([]))).find(({ stop_id }) => stop_id === second.stop_id), undefined);
  assert.equal(clip("x".repeat(310)).length, 300);
});

test("stops auto-clean when their cause resolves and stay open when unresolved", async (t) => {
  const file = await fixture(t);
  const append = (event: object) => appendFile(eventsFile(file), `${JSON.stringify({ id: `e-${Math.random()}`, at: new Date().toISOString(), ...event })}\n`);
  const record = (extra: Partial<Stop> & Pick<Stop, "cause" | "task" | "role" | "stop_id">) => recordStop(file, {
    class: "worker-fixable", detail: "detail", count: 1, ...extra,
  });

  const blockedOld = stopId("blocked", "b1", null, "2026-05-01T10:00:00Z");
  const blockedNew = stopId("blocked", "b2", null, "2026-05-01T10:00:00Z");
  const blockedStay = stopId("blocked", "b3", null, "2026-05-01T10:00:00Z");
  const workerBlockedRun = stopId("worker-blocked", "wb1", "implementation", "k1");
  const workerBlockedResult = stopId("worker-blocked", "wb2", "implementation", "k2");
  const workerBlockedStillBlocked = stopId("worker-blocked", "wb3", "implementation", "k3");
  const quietParked = stopId("worker-quiet", "q1", "implementation", "2026-05-01T10:00:00Z");
  const quietClosed = stopId("worker-quiet", "q2", "implementation", "2026-05-01T10:00:00Z");
  const quietRelaunched = stopId("worker-quiet", "q3", "implementation", "2026-05-01T10:00:00Z");
  const quietResult = stopId("worker-quiet", "q4", "implementation", "2026-05-01T10:00:00Z");
  const conflictDone = stopId("repeated-conflict", "c1", "implementation", "2026-05-01T10:00:00Z");
  const permOpen = stopId("repeated-permission", "p1", "implementation", "h1");
  const permResolvedTask = stopId("repeated-permission", "p2", "implementation", "h2");
  const permResolvedCause = stopId("repeated-permission", "p3", "implementation", "h3");
  const permArchived = stopId("repeated-permission", "p4", "implementation", "h4");

  for (const item of [
    { stop_id: blockedOld, cause: "blocked" as const, task: "b1", role: null, class: "user-decision" },
    { stop_id: blockedNew, cause: "blocked" as const, task: "b2", role: null, class: "user-decision" },
    { stop_id: blockedStay, cause: "blocked" as const, task: "b3", role: null, class: "user-decision" },
    { stop_id: workerBlockedRun, cause: "worker-blocked" as const, task: "wb1", role: "implementation" },
    { stop_id: workerBlockedResult, cause: "worker-blocked" as const, task: "wb2", role: "implementation" },
    { stop_id: workerBlockedStillBlocked, cause: "worker-blocked" as const, task: "wb3", role: "implementation" },
    { stop_id: quietParked, cause: "worker-quiet" as const, task: "q1", role: "implementation" },
    { stop_id: quietClosed, cause: "worker-quiet" as const, task: "q2", role: "implementation" },
    { stop_id: quietRelaunched, cause: "worker-quiet" as const, task: "q3", role: "implementation" },
    { stop_id: quietResult, cause: "worker-quiet" as const, task: "q4", role: "implementation" },
    { stop_id: conflictDone, cause: "repeated-conflict" as const, task: "c1", role: "implementation" },
    { stop_id: permOpen, cause: "repeated-permission" as const, task: "p1", role: "implementation" },
    { stop_id: permResolvedTask, cause: "repeated-permission" as const, task: "p2", role: "implementation" },
    { stop_id: permResolvedCause, cause: "repeated-permission" as const, task: "p3", role: "implementation" },
    { stop_id: permArchived, cause: "repeated-permission" as const, task: "p4", role: "implementation" },
  ]) await record(item);

  await append({ type: "worker.result", task: "wb2", source: "worker", data: { role: "implementation", outcome: "complete" } });
  await append({ type: "worker.result", task: "wb3", source: "worker", data: { role: "implementation", outcome: "blocked" } });
  await append({ type: "worker.result", task: "q4", source: "worker", data: { role: "implementation", outcome: "complete" } });
  await append({ type: "worker.result", task: "c1", source: "worker", data: { role: "implementation", outcome: "complete" } });
  await append({ type: "worker.result", task: "p1", source: "worker", data: { role: "implementation", outcome: "complete" } });
  await append({ type: "task.moved", task: "p4", source: "coordinator", data: { from: "implementation", to: "resolved" } });

  const open = await scanStops(file, world([
    { id: "b1", state: "implementation" },
    { id: "b2", state: "blocked", blocker: { from: "implementation", class: "user-decision", reason: "Second block.", since: "2026-05-01T11:00:00Z" } },
    { id: "b3", state: "blocked", blocker: { from: "implementation", class: "user-decision", reason: "Still blocked.", since: "2026-05-01T10:00:00Z" } },
    { id: "wb1", state: "implementation", workers: { implementation: { status: "running" } } },
    { id: "wb2", state: "implementation", workers: { implementation: { status: "idle" } } },
    { id: "wb3", state: "blocked", workers: { implementation: { status: "idle" } } },
    { id: "q1", state: "implementation", workers: { implementation: { status: "idle", launched_at: "2026-05-01T10:00:00Z" } } },
    { id: "q2", state: "implementation", workers: { implementation: { status: "closed", launched_at: "2026-05-01T10:00:00Z" } } },
    { id: "q3", state: "implementation", workers: { implementation: { status: "running", launched_at: "2026-05-01T10:30:00Z" } } },
    { id: "q4", state: "implementation", workers: { implementation: { status: "running", launched_at: "2026-05-01T10:00:00Z" } } },
    { id: "c1", state: "implementation" },
    { id: "p1", state: "implementation", workers: { implementation: { status: "closed" } } },
    { id: "p2", state: "resolved" },
    { id: "p3", state: "implementation" },
    { id: causeTaskId(permResolvedCause), state: "resolved", details: { stop_id: permResolvedCause, cause_of: "p3" } },
  ]));

  assert.deepEqual(open.map(({ stop_id }) => stop_id), [
    blockedStay,
    workerBlockedStillBlocked,
    quietParked,
    permOpen,
  ]);
});

test("groupStops groups by cause, splits blocked stops by class, and keeps first-seen order", () => {
  const groups = groupStops([
    { stop_id: "s1", cause: "blocked", class: "user-decision" },
    { stop_id: "s2", cause: "worker-quiet", class: "worker-fixable" },
    { stop_id: "s3", cause: "blocked", class: "approval" },
    { stop_id: "s4", cause: "blocked", class: "user-decision" },
    { stop_id: "s5", cause: "worker-quiet", class: "none" },
    { stop_id: "s6", cause: "blocked", class: null },
  ]);
  assert.deepEqual(groups, [
    { key: "blocked:user-decision", cause: "blocked", class: "user-decision", stops: [{ stop_id: "s1", cause: "blocked", class: "user-decision" }, { stop_id: "s4", cause: "blocked", class: "user-decision" }] },
    { key: "worker-quiet", cause: "worker-quiet", class: null, stops: [{ stop_id: "s2", cause: "worker-quiet", class: "worker-fixable" }, { stop_id: "s5", cause: "worker-quiet", class: "none" }] },
    { key: "blocked:approval", cause: "blocked", class: "approval", stops: [{ stop_id: "s3", cause: "blocked", class: "approval" }] },
    { key: "blocked:none", cause: "blocked", class: "none", stops: [{ stop_id: "s6", cause: "blocked", class: null }] },
  ]);
});
