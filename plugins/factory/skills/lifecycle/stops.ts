import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { emit, eventsFile, resolveFactory, stopCauses, stopClasses } from "./broker.ts";
import type { Factory } from "./factory-data.ts";

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
