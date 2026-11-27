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

const causeTaskNextAction = "Find the root cause. Then propose a prevention, not only a retry.";

// Writer values that create the cause task for a stop. Shared by reconcile and the dashboard server.
export function causeTaskValues(stop: Pick<Stop, "stop_id" | "cause" | "task">) {
  return {
    task: causeTaskId(stop.stop_id),
    title: `Cause: ${stop.cause} in ${stop.task ?? "no task"}`,
    issue: "null",
    "next-action": causeTaskNextAction,
    details: JSON.stringify({ stop_id: stop.stop_id, cause_of: stop.task }),
  };
}

type StopEvent = { at: string; task: string | null; data: Omit<Stop, "task"> };

const workerResultAutoCauses = new Set(["worker-blocked", "worker-quiet", "repeated-conflict"]);
const taskMovedAutoCauses = new Set(["blocked", "worker-blocked"]);

// Reads recorded stops (oldest first), dismissed stop_ids, and stops auto-resolved by later events.
async function readStopEvents(file: string) {
  let text: string;
  try {
    text = await readFile(eventsFile(file), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        stops: new Map<string, StopEvent>(),
        dismissed: new Set<string>(),
        resolved: new Set<string>(),
        movedResolved: new Map<string, string>(),
      };
    }
    throw error;
  }
  const stops = new Map<string, StopEvent>();
  const dismissed = new Set<string>();
  const resolved = new Set<string>();
  // Tracks stops whose task or cause task moved to resolved after the stop, for tasks later archived.
  const movedResolved = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.includes('"stop.') && !line.includes('"worker.result"') && !line.includes('"task.moved"')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "worker.result") {
      const role = typeof event.data?.role === "string" ? event.data.role : null;
      const outcome = typeof event.data?.outcome === "string" ? event.data.outcome : null;
      if (!event.task || !role) continue;
      for (const [id, stop] of stops) {
        if (stop.task !== event.task) continue;
        if (stop.data.cause === "emit-refused" && stop.data.role === role) {
          resolved.add(id);
        } else if (outcome !== "blocked" && workerResultAutoCauses.has(stop.data.cause) &&
            (stop.data.role === role || (stop.data.cause === "repeated-conflict" && stop.data.role === null))) {
          resolved.add(id);
        }
      }
      continue;
    }
    if (event?.type === "task.moved") {
      const to = typeof event.data?.to === "string" ? event.data.to : null;
      if (!event.task || !to) continue;
      if (to === "resolved") {
        for (const [id, stop] of stops) {
          if (stop.task === event.task || causeTaskId(id) === event.task) movedResolved.set(id, event.task);
        }
      } else {
        for (const [id, taskId] of movedResolved) {
          if (taskId === event.task) movedResolved.delete(id);
        }
      }
      if (to !== "blocked") {
        for (const [id, stop] of stops) {
          if (taskMovedAutoCauses.has(stop.data.cause) && stop.task === event.task) resolved.add(id);
        }
      }
      continue;
    }
    const id = event?.data?.stop_id;
    if (typeof id !== "string" || !id) continue;
    if (event.type === "stop.recorded") {
      if (!stops.has(id)) {
        stops.set(id, event);
      } else if (event.data.cause === "emit-refused" && resolved.has(id) && !dismissed.has(id)) {
        stops.set(id, event);
        resolved.delete(id);
      }
    } else if (event.type === "stop.dismissed") {
      dismissed.add(id);
    }
  }
  return { stops, dismissed, resolved, movedResolved };
}

// Appends one stop.recorded event (source stops). A stop_id that is already open or dismissed records nothing.
export async function recordStop(file: string, stop: Stop) {
  const factory = await resolveFactory(file);
  const { stops, dismissed, resolved } = await readStopEvents(factory);
  const reopen = stop.cause === "emit-refused" && resolved.has(stop.stop_id) && !dismissed.has(stop.stop_id);
  if (stops.has(stop.stop_id) && !reopen) return { recorded: false };
  const { task, ...data } = stop;
  await emit(factory, { type: "stop.recorded", task, source: "stops", data });
  return { recorded: true };
}

// Appends one stop.dismissed event (source stops). Returns null for an unknown stop_id.
export async function dismissStop(file: string, id: string) {
  const factory = await resolveFactory(file);
  const { stops, dismissed } = await readStopEvents(factory);
  if (!stops.has(id)) return null;
  if (dismissed.has(id)) return { dismissed: true, recorded: false };
  await emit(factory, { type: "stop.dismissed", source: "stops", data: { stop_id: id } });
  return { dismissed: true, recorded: true };
}

export async function isStopDismissed(file: string, id: string) {
  return (await readStopEvents(await resolveFactory(file))).dismissed.has(id);
}

export async function isStopRecorded(file: string, id: string) {
  return (await readStopEvents(await resolveFactory(file))).stops.has(id);
}

function isResolvedByFactory(
  stop: StopEvent,
  tasks: Map<string, Factory["tasks"][number]>,
  cause: Factory["tasks"][number] | undefined,
  movedResolvedTask: string | undefined,
) {
  if (cause?.state === "resolved") return true;
  const source = stop.task ? tasks.get(stop.task) : undefined;
  if (source?.state === "resolved") return true;
  if (movedResolvedTask && !tasks.has(movedResolvedTask)) return true;
  if (!source) return false;

  const { cause: kind, role, stop_id: id } = stop.data;
  if (kind === "blocked") {
    if (source.state !== "blocked") return true;
    const prefix = `blocked:${source.id}:-:`;
    if (source.blocker?.since && id.startsWith(prefix) && id !== stopId("blocked", source.id, null, source.blocker.since)) {
      return true;
    }
    return false;
  }
  const worker = role ? source.workers?.[role as WorkerRole] : null;
  if (kind === "worker-blocked") return worker?.status === "running";
  if (kind === "worker-quiet" && worker) {
    if (worker.status === "closed") return true;
    if (worker.launched_at) {
      const prefix = `worker-quiet:${source.id}:${role}:`;
      if (id.startsWith(prefix)) {
        const key = id.slice(prefix.length);
        if (key !== "-" ? worker.launched_at !== key : Date.parse(worker.launched_at) > Date.parse(stop.at)) return true;
      }
    }
  }
  return false;
}

// Pairs each open (not dismissed and not auto-resolved) recorded stop with its cause task: the task whose details.stop_id equals the stop_id.
export async function scanStops(file: string, factory: Factory): Promise<ScannedStop[]> {
  const { stops, dismissed, resolved, movedResolved } = await readStopEvents(await resolveFactory(file));
  const tasks = new Map(factory.tasks.map((task) => [task.id, task]));
  const causesByStop = new Map(
    factory.tasks
      .filter((task) => typeof task.details?.stop_id === "string")
      .map((task) => [task.details!.stop_id as string, task]),
  );
  const open: ScannedStop[] = [];
  for (const event of stops.values()) {
    const { at, task, data } = event;
    if (dismissed.has(data.stop_id) || resolved.has(data.stop_id)) continue;
    const cause = causesByStop.get(data.stop_id);
    if (isResolvedByFactory(event, tasks, cause, movedResolved.get(data.stop_id))) continue;
    open.push({ ...data, task, at, cause_task: cause?.id ?? null, cause_state: cause?.state ?? null });
  }
  return open;
}

const maxDetail = 300;
const repeatedPrompts = 2;
const duplicatePromptWindowMs = 2000;
const repeatedConflicts = 2;
const promptKinds = ["permission", "sandbox-bypass"];
const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8);
export const clip = (text: string) => (text.length > maxDetail ? `${text.slice(0, maxDetail - 3)}...` : text);

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
    const list = prompts.get(key) ?? [];
    const prev = list.at(-1);
    if (prev && Math.abs(Date.parse(event.at) - Date.parse(prev.at)) <= duplicatePromptWindowMs) continue;
    list.push(event);
    prompts.set(key, list);
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
