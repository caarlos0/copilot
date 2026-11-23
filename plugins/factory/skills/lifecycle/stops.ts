import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { emit, eventsFile, resolveFactory, stopCauses, stopClasses, type BrokerEvent } from "./broker.ts";
import type { Factory, WorkerRole } from "./factory-data.ts";

export const causes = stopCauses;
export const classes = stopClasses;

export type Stop = {
  stop_id: string;
  cause: string;
  task: string | null;
  role: string | null;
  class: string;
  detail: string;
  count: number;
  // Only a not-rebased emit-refused stop has a head. repeated-conflict counts the different heads.
  head?: string;
};

export type ScannedStop = Stop & { at: string; cause_task: string | null; cause_state: string | null };

// A stop id is CAUSE:TASK:ROLE:KEY. A stop without a task or role has "-" in its place.
export const stopId = (cause: string, task: string | null, role: string | null, key: string) =>
  `${cause}:${task ?? "-"}:${role ?? "-"}:${key}`;

// The id of the cause task for a stop: one task for each stop_id.
export const causeTaskId = (id: string) => `cause-${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;

type StopEvent = { at: string; task: string | null; data: Omit<Stop, "task"> };

// Reads the first stop.recorded event of each stop_id, oldest first.
async function readStops(file: string) {
  let text: string;
  try {
    text = await readFile(eventsFile(file), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map<string, StopEvent>();
    throw error;
  }
  const stops = new Map<string, StopEvent>();
  for (const line of text.split("\n")) {
    if (!line.includes('"stop.recorded"')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const id = event?.data?.stop_id;
    if (event.type === "stop.recorded" && typeof id === "string" && !stops.has(id)) stops.set(id, event);
  }
  return stops;
}

// Appends one stop.recorded event (source stops). A stop_id that is already in the log records nothing.
export async function recordStop(file: string, stop: Stop) {
  const factory = await resolveFactory(file);
  if ((await readStops(factory)).has(stop.stop_id)) return { recorded: false };
  const { task, ...data } = stop;
  await emit(factory, { type: "stop.recorded", task, source: "stops", data });
  return { recorded: true };
}

// Pairs each recorded stop with its cause task: the task whose details.stop_id equals the stop_id.
export async function scanStops(file: string, factory: Factory): Promise<ScannedStop[]> {
  const stops = await readStops(await resolveFactory(file));
  return [...stops.values()].map(({ at, task, data }) => {
    const cause = factory.tasks.find((candidate) => candidate.details?.stop_id === data.stop_id);
    return { ...data, task, at, cause_task: cause?.id ?? null, cause_state: cause?.state ?? null };
  });
}

const maxDetail = 300;
const repeatedPrompts = 2;
const repeatedConflicts = 2;
const promptKinds = ["permission", "sandbox-bypass"];
const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8);
const clip = (text: string) => (text.length > maxDetail ? `${text.slice(0, maxDetail - 3)}...` : text);

export type QuietWorker = { task: string; role: string; minutes: number };

// Finds the stops that a factory and its events show. Events are oldest first. The function is pure:
// the caller gives the quiet minutes of each worker and records the stops.
export function detectStops(factory: Factory, events: BrokerEvent[], quiet: QuietWorker[] = []): Stop[] {
  const found = new Map<string, Stop>();
  const add = (stop: Stop) => found.has(stop.stop_id) || found.set(stop.stop_id, stop);
  const tasks = new Map(factory.tasks.map((task) => [task.id, task]));

  for (const task of factory.tasks) {
    if (task.state !== "blocked" || !task.blocker) continue;
    add({
      stop_id: stopId("blocked", task.id, null, task.blocker.since),
      cause: "blocked",
      task: task.id,
      role: null,
      class: task.blocker.class ?? "none",
      detail: clip(`The task is blocked. Reason: ${task.blocker.reason}`),
      count: 1,
    });
  }

  events.forEach((event, index) => {
    const task = event.task ? tasks.get(event.task) : undefined;
    if (event.type !== "worker.blocked" || !task || task.state === "resolved") return;
    const role = String(event.data.role);
    const cleared = events.slice(index + 1).some((later) => later.type === "task.moved" && later.task === task.id && later.data.to !== "blocked");
    if (cleared || task.workers[role as WorkerRole]?.status === "running") return;
    add({
      stop_id: stopId("worker-blocked", task.id, role, event.id ?? event.at),
      cause: "worker-blocked",
      task: task.id,
      role,
      class: "worker-fixable",
      detail: clip(`The worker reported blocked. Reason: ${event.data.reason}`),
      count: 1,
    });
  });

  for (const { task, role, minutes } of quiet) {
    const launched = tasks.get(task)?.workers[role as WorkerRole]?.launched_at;
    add({
      stop_id: stopId("worker-quiet", task, role, launched ?? "-"),
      cause: "worker-quiet",
      task,
      role,
      class: "worker-fixable",
      detail: `The worker was quiet for ${minutes} minutes after its last turn.`,
      count: 1,
    });
  }

  const prompts = new Map<string, BrokerEvent[]>();
  for (const event of events) {
    const { session, kind, text } = event.data;
    if (event.type !== "attention.requested" || !promptKinds.includes(kind) || typeof session !== "string" || typeof text !== "string") continue;
    const key = [session, kind, text.slice(0, 120)].join("\0");
    prompts.set(key, [...(prompts.get(key) ?? []), event]);
  }
  for (const [key, group] of prompts) {
    if (group.length < repeatedPrompts) continue;
    const { session, kind, role: eventRole } = group[0].data;
    const owner = factory.tasks.flatMap((task) => Object.entries(task.workers ?? {}).map(([role, worker]) => ({ task: task.id, role, worker })))
      .find(({ worker }) => worker?.session === session);
    const role = owner?.role ?? eventRole ?? null;
    add({
      stop_id: stopId("repeated-permission", owner?.task ?? null, role, short(key)),
      cause: "repeated-permission",
      task: owner?.task ?? null,
      role,
      class: "worker-fixable",
      detail: `The worker asked for the same ${kind} approval ${group.length} times in one session.`,
      count: group.length,
    });
  }

  const conflicts = new Map<string, BrokerEvent[]>();
  for (const event of events) {
    if (event.type !== "stop.recorded" || event.data.cause !== "emit-refused" || !event.task || !event.data.head) continue;
    conflicts.set(event.task, [...(conflicts.get(event.task) ?? []), event]);
  }
  for (const [task, group] of conflicts) {
    const heads = new Set(group.map((event) => event.data.head));
    if (heads.size < repeatedConflicts) continue;
    const { head, role } = group[0].data;
    add({
      stop_id: stopId("repeated-conflict", task, role ?? null, String(head).slice(0, 12)),
      cause: "repeated-conflict",
      task,
      role: role ?? null,
      class: "worker-fixable",
      detail: `The head was not rebased on ${heads.size} different heads.`,
      count: heads.size,
    });
  }

  return [...found.values()];
}
