import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { eventsFile } from "./broker.ts";
import type { Factory } from "./factory-data.ts";
import { causeTaskId, causes, classes, detectStops, recordStop, scanStops, stopId } from "./stops.ts";
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

const event = (type: string, task: string | null, data: Record<string, unknown>, id = `${type}-${Math.random()}`) =>
  ({ id, at: "2026-05-01T12:00:00Z", type, task, source: "test", data });
const prompt = (session: string, text: string, extra: Record<string, unknown> = {}) =>
  event("attention.requested", null, { session, kind: "permission", text, ...extra });
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
    prompt("s1", text + "a"), prompt("s1", text + "b"),
    prompt("s2", "Run ls."), prompt("s2", "Run pwd."),
    prompt("s3", "Run ls."), prompt("s4", "Run ls."),
    prompt("s5", "Run ls.", { kind: "sandbox-bypass" }), prompt("s5", "Run ls."),
    prompt("s6", "Ask.", { kind: "ask-user" }), prompt("s6", "Ask.", { kind: "ask-user" }),
  ]);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].cause, "repeated-permission");
  assert.equal(stops[0].count, 2);
  assert.equal(stops[0].task, null);
});

test("detectStops maps the session of a prompt to a task, else keeps the event role", () => {
  const owned = open("t1", { workers: { review: { status: "running", session: "s1" } } });
  const [mapped, unmapped] = detectStops(world([owned]), [
    prompt("s1", "Run ls.", { role: "implementation" }), prompt("s1", "Run ls.", { role: "implementation" }),
    prompt("s9", "Run ls.", { role: "implementation" }), prompt("s9", "Run ls.", { role: "implementation" }),
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
