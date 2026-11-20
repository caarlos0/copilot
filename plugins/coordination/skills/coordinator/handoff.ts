import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { validate } from "./board-data.mjs";

type Json = Record<string, any>;
type Values = Record<string, string | undefined>;

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;
const errorMessage = (error: unknown) => (error as Error).message;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function merge(current: unknown, patch: unknown): any {
  if (!isObject(current) || !isObject(patch)) return patch;
  return Object.fromEntries([
    ...Object.entries(current),
    ...Object.entries(patch).map(([key, value]) => [
      key, merge(Object.hasOwn(current, key) ? current[key] : undefined, value),
    ]),
  ]);
}

function tasksById(tasks: unknown, field: string) {
  if (!Array.isArray(tasks)) throw new Error(`${field} must be an array.`);
  const result = new Map<string, Json>();
  for (const task of tasks) {
    if (!isObject(task) || typeof task.id !== "string" || !task.id.trim()) {
      throw new Error(`${field}: each task needs a non-empty string id.`);
    }
    if (result.has(task.id)) throw new Error(`${field}: duplicate task ID: ${task.id}`);
    result.set(task.id, task);
  }
  return result;
}

async function readOptional(file: string) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function taskPatch(values: Values) {
  const patch: Json = {};
  for (const [option, field] of [
    ["goal", "goal"], ["status", "status"], ["next-action", "next_action"],
    ["worker", "worker"], ["blocker", "blocker"], ["brief", "brief"],
    ["result", "result"], ["pr", "pr"],
  ]) {
    if (values[option] !== undefined) {
      patch[field] = values[option] === "null" &&
        ["worker", "blocker", "brief", "result", "pr"].includes(option) ? null : values[option];
    }
  }
  if (values.links !== undefined) patch.links = JSON.parse(values.links);
  if (values.details !== undefined) {
    patch.details = JSON.parse(values.details);
    if (!isObject(patch.details)) throw new Error("--details must be a JSON object.");
  }
  if (values["task-updated-at"] !== undefined) patch.updated_at = values["task-updated-at"];
  return patch;
}

async function update(file: string, values: Values) {
  const original = await readOptional(file);
  const isNew = original === null;
  const now = new Date().toISOString();
  if (isNew && (!values.project || !values.role || !values["run-goal"])) {
    throw new Error("New handoffs require --project, --role, and --run-goal.");
  }
  let current: Json = isNew
    ? {
      id: basename(file, extname(file)),
      project: values.project,
      role: values.role,
      goal: values["run-goal"],
      status: values["run-status"] ?? "active",
      updated_at: now,
      tasks: [],
    }
    : JSON.parse(original);
  if (!isObject(current)) throw new Error("Handoff must be a JSON object.");

  const rootPatch: Json = {};
  for (const [option, field] of [
    ["project", "project"], ["role", "role"], ["run-goal", "goal"], ["run-status", "status"],
  ]) {
    if (values[option] !== undefined) rootPatch[field] = values[option];
  }
  rootPatch.updated_at = values["updated-at"] ?? now;

  const tasks = tasksById(current.tasks, "tasks");
  const addingTask = values.task !== undefined && !tasks.has(values.task);
  if (values.task !== undefined) {
    const taskUpdate = { id: values.task, updated_at: values["task-updated-at"] ?? now, ...taskPatch(values) };
    tasks.set(values.task, merge(tasks.get(values.task) ?? {}, taskUpdate));
  }
  current = merge(current, rootPatch);
  current.tasks = [...tasks.values()];
  validate(current);
  if (addingTask) {
    const cutoff = Date.parse(now) - 7 * 24 * 60 * 60 * 1000;
    current.tasks = current.tasks.filter((task: Json) =>
      task.id === values.task || task.status !== "done" || Date.parse(task.updated_at) >= cutoff);
  }

  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(current, null, 2)}\n`);
    } finally {
      await handle.close();
    }
    if (await readOptional(file) !== original) {
      throw new Error("Handoff changed during update. Reread it and reconcile before retrying.");
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main() {
  let file: string;
  let values: Values;
  try {
    const { values: parsed, positionals } = parseArgs({
      options: {
        help: { type: "boolean", short: "h" },
        project: { type: "string" },
        role: { type: "string" },
        "run-goal": { type: "string" },
        "run-status": { type: "string" },
        "updated-at": { type: "string" },
        task: { type: "string" },
        goal: { type: "string" },
        status: { type: "string" },
        "next-action": { type: "string" },
        worker: { type: "string" },
        blocker: { type: "string" },
        brief: { type: "string" },
        result: { type: "string" },
        pr: { type: "string" },
        links: { type: "string" },
        details: { type: "string" },
        "task-updated-at": { type: "string" },
      },
      allowPositionals: true,
    });
    const { help, ...flags } = parsed;
    values = flags;
    if (help) {
      console.log(`Create or update a coordinator handoff with validated flags.

Usage: node handoff.mjs FILE [RUN OPTIONS] [TASK OPTIONS]
       bun handoff.mjs FILE [RUN OPTIONS] [TASK OPTIONS]

Create a handoff:
  node handoff.mjs FILE --project owner/repo --role implementer \\
    --run-goal "Implement work for owner/repo"

Add a task:
  node handoff.mjs FILE --task issue-42 --goal "Fix login" \\
    --status pending --next-action "Write the worker brief"

Update a task:
  node handoff.mjs FILE --task issue-42 --status running \\
    --worker block:worker-id --next-action "Review the result"

Run options:
  --project VALUE       Project key stored once on the handoff
  --role VALUE          Coordinator role
  --run-goal VALUE      Handoff goal
  --run-status VALUE    active, paused, blocked, or finished (default: active on create)
  --updated-at VALUE    Explicit run timestamp (ISO 8601 with timezone)

Task options:
  --task ID             Task ID; required when changing a task
  --goal VALUE          Task goal (required for new tasks)
  --status VALUE        pending, running, verifying, blocked, or done
  --next-action VALUE   Next action (required for new tasks)
  --worker VALUE        Worker identity, or null when unknown
  --blocker VALUE       Blocker text (only with blocked status), or null to clear
  --brief VALUE         State-directory filename, or null to clear
  --result VALUE        State-directory filename, or null to clear
  --pr VALUE            GitHub PR URL, or null to clear
  --links JSON          Replace GitHub issue/PR URL array; [] clears it
  --details JSON        Merge a JSON object into task details
  --task-updated-at VALUE  Explicit task timestamp (ISO 8601 with timezone)

The handoff ID comes from FILE's basename. A new task needs --goal,
--status, and --next-action. Its repository comes from the handoff's --project.
Only supplied fields change. Adding a new task ID removes existing done tasks
last updated more than seven days ago, measured at write time. Other updates
preserve omitted tasks. Artifact files are not removed.
When leaving blocked status, clear any blocker with --blocker null.
The helper validates the complete handoff before writing. Success is silent.
Errors go to stderr. Exit: 0 on success, 1 on invalid data or I/O, 2 on usage.
Use literal null only for nullable fields. Use -- before a FILE beginning with -.
Keep the coordinator's project/role owner lock while using this command.`);
      return;
    }
    if (positionals.length !== 1 || !positionals[0]) throw new Error("Exactly one handoff FILE is required.");
    [file] = positionals;
    if (values.task === undefined && [
      "goal", "status", "next-action", "worker", "blocker", "brief", "result", "pr",
      "links", "details", "task-updated-at",
    ].some((field) => values[field] !== undefined)) {
      throw new Error("Task options require --task ID.");
    }
    if (!values.task && Object.keys(values).length === 0) {
      throw new Error("Specify run options or --task ID.");
    }
    file = resolve(file);
  } catch (error) {
    console.error(`${errorMessage(error)}\nRun with --help for usage.`);
    process.exitCode = 2;
    return;
  }
  try {
    await update(file, values);
  } catch (error) {
    console.error(`${file}: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

await main();
