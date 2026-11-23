import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { eventsFile } from "./broker.ts";
import type { Factory } from "./factory-data.ts";
import { causeTaskId, causes, classes, recordStop, scanStops, stopId } from "./stops.ts";
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
