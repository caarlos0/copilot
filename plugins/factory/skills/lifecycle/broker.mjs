import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { dueRules, isObject, nextDue } from "./factory-data.mjs";

const maxTimer = 2 ** 31 - 1;
const maxLine = 64 * 1024;
const workerOutcomes = ["working", "waiting", "complete", "blocked"];

// Each type lists whether it needs --task and the data keys it must carry.
const eventTypes = {
  "task.moved": { task: true, data: ["to"] },
  "task.updated": { task: true, data: ["revision"] },
  "worker.result": { task: true, data: ["role", "outcome"] },
  "worker.blocked": { task: true, data: ["role", "reason"] },
  "feedback.pending": { task: true, data: ["feedback_id"] },
};

const eventsFile = (file) =>
  join(dirname(file), `${basename(file, extname(file))}-events.jsonl`);

class UsageError extends Error {}

function validateEvent({ type, task, source, data }) {
  const schema = eventTypes[type];
  if (!schema) throw new UsageError(`Unknown event type ${type}. Use one of: ${Object.keys(eventTypes).join(", ")}.`);
  if (!/^[a-z][a-z0-9-]*$/.test(source)) throw new UsageError("--source must be lowercase letters, digits, and hyphens.");
  if (schema.task && !task) throw new UsageError(`${type} needs --task ID.`);
  if (!isObject(data)) throw new UsageError("--data must be a JSON object.");
  for (const key of schema.data) {
    if (data[key] === undefined) throw new UsageError(`${type} data needs "${key}".`);
  }
  if (type === "worker.result" && !workerOutcomes.includes(data.outcome)) {
    throw new UsageError(`worker.result outcome must be one of: ${workerOutcomes.join(", ")}.`);
  }
}

// The log directory is resolved the way factory.mjs resolves its file.
export async function resolveFactory(file) {
  return join(await realpath(dirname(resolve(file))), basename(file));
}

async function size(file) {
  try {
    return (await stat(file)).size;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

// One O_APPEND write per event keeps concurrent emitters from interleaving lines.
export async function emit(factory, { type, task = null, source, data = {} }) {
  validateEvent({ type, task, source, data });
  const event = { id: randomUUID(), at: new Date().toISOString(), type, task, source, data };
  const line = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(line) > maxLine) throw new Error("Event is larger than 64 KiB. Keep long evidence in the result file.");
  const handle = await open(eventsFile(factory), "a", 0o600);
  try {
    await handle.write(line);
  } finally {
    await handle.close();
  }
  return event;
}

// Reads complete lines after the byte offset; a trailing partial line stays unread.
async function readEvents(file, offset) {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if (error.code === "ENOENT" && offset === 0) return { events: [], cursor: 0 };
    throw error;
  }
  try {
    const { size: length } = await handle.stat();
    if (offset > length) throw new Error(`Cursor ${offset} is past the end of the log (${length} bytes).`);
    const buffer = Buffer.alloc(length - offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const text = buffer.subarray(0, bytesRead);
    const end = text.lastIndexOf(10) + 1;
    const events = [];
    for (const line of text.subarray(0, end).toString("utf8").split("\n")) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        console.error(`Skipped a malformed event line: ${line.slice(0, 80)}`);
      }
    }
    return { events, cursor: offset + end };
  } finally {
    await handle.close();
  }
}

async function waitForEvents(factory, { since, timeout, exclude = [], due = false }) {
  const file = eventsFile(factory);
  let cursor = since ?? await size(file);
  const state = async () => JSON.parse(await readFile(factory, "utf8"));
  let dueAt = null;
  if (due) dueAt = nextDue(await state());

  const watchers = [];
  const timers = [];
  let stopped = false;
  try {
    return await new Promise((complete, fail) => {
      let dirty = false;
      let checking = false;
      const finish = (result) => {
        stopped = true;
        complete(result);
      };
      const abort = (error) => {
        stopped = true;
        fail(error);
      };
      async function check(now = Date.now()) {
        dirty = true;
        if (checking || stopped) return;
        checking = true;
        try {
          while (dirty && !stopped) {
            dirty = false;
            const read = await readEvents(file, cursor);
            cursor = read.cursor;
            const events = read.events.filter((event) => !exclude.includes(event.source));
            // Due rules come from the factory file on every wake, so they are never lost.
            const rules = due ? dueRules(await state(), now) : [];
            if (rules.length) {
              events.push({ id: null, at: new Date(now).toISOString(), type: "rule.due", task: null, source: "broker", data: { rules } });
            }
            if (events.length) finish({ events, cursor: String(cursor) });
          }
        } catch (error) {
          abort(error);
        } finally {
          checking = false;
        }
      }

      const directory = dirname(file);
      const watcher = watch(directory, (_, name) => {
        if (name === null || name === basename(file)) void check();
      });
      watcher.on("error", abort);
      watcher.on("close", () => {
        if (!stopped) abort(new Error(`Event watcher closed unexpectedly: ${directory}`));
      });
      watchers.push(watcher);

      const after = (ms, action) => {
        const tick = (left) => {
          const timer = setTimeout(() => (left > maxTimer ? tick(left - maxTimer) : action()), Math.min(left, maxTimer));
          timers.push(timer);
        };
        tick(ms);
      };
      if (timeout !== undefined) after(timeout * 1000, () => finish({ events: [], cursor: String(cursor), timeout: true }));
      if (dueAt !== null) after(Math.max(dueAt - Date.now(), 0), () => void check(dueAt));
      console.error("Watching events.");
      void check();
    });
  } finally {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  }
}

const usage = `Factory event broker: a durable, append-only event log with a waiter that wakes at once.

Usage: node broker.mjs wait FACTORY_FILE [--since CURSOR] [--timeout SECONDS]
                       [--exclude-source SOURCE ...] [--due]
       node broker.mjs emit FACTORY_FILE TYPE [--task ID] [--source SOURCE] [--data JSON]
       node broker.mjs cursor FACTORY_FILE

The log is <owner.repo>-factory-events.jsonl beside FACTORY_FILE (mode 0600). A cursor is a
byte offset in it. Events are notifications; the factory JSON stays the source of truth.

wait    Blocks until an event exists after the cursor, prints {"events":[...],"cursor":"N"},
        and exits. Pass the printed cursor to the next wait: no event is lost between calls.
        Without --since it starts at the current end of the log ("cursor" prints that end).
        --exclude-source skips events from a source (repeatable), so the factory ignores its
        own writes; skipped events still advance the cursor.
        --timeout S exits 0 with "events":[] and "timeout":true after S seconds.
        --due also returns a synthetic rule.due event (data.rules = rule IDs) when an enabled
        rule with "every" is due. Stamp it with factory.mjs --rule ID --ran, or the next wait
        returns it again. Leave --due off while no slot is free for the rule.
emit    Appends one event and prints it. Types: ${Object.keys(eventTypes).join(", ")}.
        Needed data keys: ${Object.entries(eventTypes).map(([type, { data }]) => `${type}: ${data.join(", ")}`).join("; ")}.
        worker.result outcome: ${workerOutcomes.join(", ")}. --source defaults to worker.
        factory.mjs emits task.moved, task.updated, and feedback.pending after every write.
cursor  Prints {"cursor":"N"} for the current end of the log.

Progress and errors go to stderr. Exit: 0 success, 1 operational failure, 2 invalid usage.`;

async function main() {
  let command;
  let factory;
  let args;
  try {
    const { values, positionals } = parseArgs({
      options: {
        help: { type: "boolean", short: "h" },
        since: { type: "string" },
        timeout: { type: "string" },
        "exclude-source": { type: "string", multiple: true },
        due: { type: "boolean" },
        task: { type: "string" },
        source: { type: "string" },
        data: { type: "string" },
      },
      allowPositionals: true,
    });
    if (values.help || positionals.length === 0) {
      console.log(usage);
      process.exitCode = values.help ? 0 : 2;
      return;
    }
    [command, factory, ...args] = positionals;
    if (!["wait", "emit", "cursor"].includes(command)) throw new Error(`Unknown command ${command}.`);
    if (!factory) throw new Error("A factory FILE is required.");
    if (command === "emit") {
      if (args.length !== 1) throw new Error("emit needs exactly one TYPE.");
      args = {
        type: args[0],
        task: values.task ?? null,
        source: values.source ?? "worker",
        data: values.data === undefined ? {} : JSON.parse(values.data),
      };
    } else {
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}.`);
      if (command === "cursor") args = {};
      else {
        if (values.since !== undefined && !/^\d+$/.test(values.since)) throw new Error("--since must be a cursor printed by wait or cursor.");
        const timeout = values.timeout === undefined ? undefined : Number(values.timeout);
        if (timeout !== undefined && !(timeout > 0)) throw new Error("--timeout must be a positive number of seconds.");
        args = {
          since: values.since === undefined ? undefined : Number(values.since),
          timeout,
          exclude: values["exclude-source"] ?? [],
          due: values.due === true,
        };
      }
    }
  } catch (error) {
    console.error(`${error.message}\nRun with --help for usage.`);
    process.exitCode = 2;
    return;
  }
  try {
    factory = await resolveFactory(factory);
    if (command === "emit") {
      console.log(JSON.stringify(await emit(factory, args)));
    } else if (command === "cursor") {
      console.log(JSON.stringify({ cursor: String(await size(eventsFile(factory))) }));
    } else {
      console.log(JSON.stringify(await waitForEvents(factory, args)));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
