import { randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { archiveDirectory, findArchived, readArchive, removeArchived, saveArchive } from "./archive.mjs";
import { emit } from "./broker.mjs";
import { checkTransition, format, operatorOutcomes, outcomes, validate } from "./factory-data.mjs";
import { recordSessions, registryFile, sessionID } from "./sessions.mjs";

const defaultLimits = { investigation: 3, implementation: 3 };

export class ConflictError extends Error {}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function merge(current, patch) {
  if (!isObject(current) || !isObject(patch)) return patch;
  return Object.fromEntries([
    ...Object.entries(current),
    ...Object.entries(patch).map(([key, value]) => [
      key, merge(Object.hasOwn(current, key) ? current[key] : undefined, value),
    ]),
  ]);
}

async function readOptional(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function json(value, option, check) {
  const parsed = JSON.parse(value);
  if (check && !check(parsed)) throw new Error(`--${option} has the wrong JSON type.`);
  return parsed;
}

const nullable = (value) => (value === "null" ? null : value);

function normalizedURL(value) {
  if (value == null || value === "null") return null;
  try {
    return new URL(value).href;
  } catch {
    return value;
  }
}

function archivedMessage(id, matches) {
  const lines = matches.map(({ task, day }) => {
    const outcome = task.resolution ? `${task.resolution.outcome}, ` : "";
    const revision = task.revision ?? 0;
    const fence = task.feedback ? ` --feedback-id ${task.feedback.id}` : "";
    const action = task.resolution?.outcome === "merged"
      ? "Merged, so it cannot be reopened: skip it, or file a new issue and task."
      : `Restore with: --task ${task.id} --restore --state initial --note WHY --expected-revision ${revision}${fence}`;
    return `- ${task.id} "${task.title}" (${outcome}archived ${day}, revision ${revision}). ${action}`;
  });
  return `Task ${id} matches archived work. Ask the user whether to restore it or skip it; do not add a duplicate.\n${lines.join("\n")}`;
}

function newTask(values, now) {
  for (const option of ["title", "next-action", "issue"]) {
    if (values[option] === undefined) {
      throw new Error(`A new task needs --${option}. Use --issue null for work without a GitHub issue.`);
    }
  }
  if (values.state !== undefined && values.state !== "initial") {
    throw new Error("A new task starts in the initial state.");
  }
  return {
    id: values.task,
    title: values.title,
    state: "initial",
    updated_at: now,
    next_action: values["next-action"],
    issue: null,
    pr: null,
    head: null,
    reviewed_head: null,
    links: [],
    blocker: null,
    resolution: null,
    merge: null,
    workers: {},
    worktree: null,
    history: [{ state: "initial", at: now, note: values.note ?? null }],
    details: {},
  };
}

function changeState(task, values, now, operator) {
  const to = values.state;
  checkTransition(task, to, operator);
  const from = task.state;
  if (values.resolution !== undefined && to !== "resolved") {
    throw new Error("--resolution is allowed only when moving to resolved.");
  }
  if (to === "blocked") {
    if (!values.blocker) throw new Error("Moving to blocked needs --blocker REASON.");
    task.blocker = { from, reason: values.blocker, since: now };
  } else if (values.blocker !== undefined) {
    throw new Error("--blocker is allowed only when moving to or staying in blocked.");
  }
  if (from === "blocked") task.blocker = null;
  if (to === "resolved") {
    const allowed = operator ? operatorOutcomes : outcomes;
    if (!allowed.includes(values.resolution)) {
      throw new Error(`Moving to resolved needs --resolution ${allowed.join("|")}.`);
    }
    task.resolution = { outcome: values.resolution, note: values.note ?? null, at: now };
  }
  if (from === "resolved") {
    task.resolution = null;
    task.merge = null;
  }
  task.state = to;
  task.history = [...task.history, { state: to, at: now, note: values.note ?? null }];
}

function taskPatch(task, values) {
  const patch = {};
  for (const [option, field] of [
    ["title", "title"], ["issue", "issue"], ["pr", "pr"], ["head", "head"],
    ["reviewed-head", "reviewed_head"], ["next-action", "next_action"],
  ]) {
    if (values[option] === undefined) continue;
    patch[field] = ["issue", "pr", "head", "reviewed-head"].includes(option)
      ? nullable(values[option]) : values[option];
  }
  if (values.links !== undefined) patch.links = json(values.links, "links", Array.isArray);
  for (const option of ["workers", "details"]) {
    if (values[option] !== undefined) patch[option] = json(values[option], option, isObject);
  }
  for (const option of ["worktree", "merge"]) {
    if (values[option] !== undefined) {
      patch[option] = values[option] === "null" ? null : json(values[option], option, isObject);
    }
  }
  if (patch.head !== undefined && patch.head !== task.head && values.merge === undefined) {
    patch.merge = null;
  }
  return patch;
}

// The state is already saved, so a failed notification only warns.
async function announce(file, source, events) {
  for (const event of events) {
    try {
      await emit(file, { ...event, source });
    } catch (error) {
      console.error(`${file}: ${event.type} event not emitted: ${error.message}`);
    }
  }
}

async function writeFactory(file, values, operator, source) {
  const original = await readOptional(file);
  const isNew = original === null;
  const now = new Date().toISOString();
  if (isNew && (!values.project || !values["run-goal"])) {
    throw new Error("New factories require --project and --run-goal.");
  }
  let current = isNew
    ? {
      format,
      id: basename(file, extname(file)),
      project: values.project,
      goal: values["run-goal"],
      status: values["run-status"] ?? "active",
      updated_at: now,
      rex_session: null,
      rules: [],
      limits: defaultLimits,
      tasks: [],
    }
    : JSON.parse(original);
  if (!isObject(current)) throw new Error("Factory must be a JSON object.");
  if (!isNew) validate(current);

  const rootPatch = { updated_at: values["updated-at"] ?? now };
  for (const [option, field] of [
    ["project", "project"], ["run-goal", "goal"], ["run-status", "status"],
  ]) {
    if (values[option] !== undefined) rootPatch[field] = values[option];
  }
  if (values["rex-session"] !== undefined) rootPatch.rex_session = nullable(values["rex-session"]);
  if (values.rules !== undefined) rootPatch.rules = json(values.rules, "rules", Array.isArray);
  if (values.limits !== undefined) rootPatch.limits = json(values.limits, "limits", isObject);
  if (values.ignored !== undefined) rootPatch.ignored = json(values.ignored, "ignored", Array.isArray);
  const sessions = [];
  const track = (value, role, owner) => {
    const id = sessionID(value);
    if (id) sessions.push({ id, role, ...owner, at: rootPatch.updated_at });
  };
  if (values.session !== undefined) {
    if (!sessionID(values.session)) throw new Error("--session must be a Copilot session UUID.");
    track(values.session, "factory", {});
  }
  if (values.rule === undefined) {
    if (values.ran || values["rule-worker"] !== undefined) throw new Error("--ran and --rule-worker need --rule ID.");
  } else {
    const changes = {};
    if (values.ran) changes.last_run_at = rootPatch.updated_at;
    if (values["rule-worker"] !== undefined) {
      changes.worker = values["rule-worker"] === "null" ? null : json(values["rule-worker"], "rule-worker", isObject);
    }
    if (!Object.keys(changes).length) throw new Error("--rule needs --ran or --rule-worker.");
    const rules = rootPatch.rules ?? current.rules;
    const rule = rules.find((item) => item.id === values.rule);
    if (!rule) throw new Error(`Unknown rule: ${values.rule}`);
    rootPatch.rules = rules.map((item) => (item === rule ? { ...rule, ...changes } : item));
    track(changes.worker?.session, rule.kind === "improve" ? "improver" : "producer", { rule: rule.id });
  }

  let tasks = Array.isArray(current.tasks) ? current.tasks : [];
  const directory = archiveDirectory(file);
  const restoring = values.restore === true;
  const live = values.task !== undefined && tasks.some((task) => task.id === values.task);
  if (restoring) {
    if (values.task === undefined || values.state !== "initial" ||
        typeof values.note !== "string" || !values.note.trim()) {
      throw new Error("--restore needs --task ID, --state initial, and --note WHY.");
    }
    if (live) throw new Error(`Task ${values.task} is live. Restore applies only to archived tasks.`);
  }
  const addingTask = values.task !== undefined && !live && !restoring;
  const inserting = addingTask || restoring;
  let archived = null;
  const events = [];
  if (values.task !== undefined) {
    if (inserting) {
      const matches = findArchived(await readArchive(directory, current.project), restoring
        ? { id: values.task }
        : { id: values.task, issue: normalizedURL(values.issue), pr: normalizedURL(values.pr) });
      if (restoring) {
        archived = matches[0];
        if (!archived) throw new Error(`Task ${values.task} is not in the archive.`);
      } else if (matches.length) {
        throw new Error(archivedMessage(values.task, matches));
      }
    }
    const at = values["task-updated-at"] ?? now;
    const before = restoring ? archived.task
      : addingTask ? newTask(values, at) : tasks.find((task) => task.id === values.task);
    const revision = before.revision ?? 0;
    if (values["expected-revision"] !== undefined) {
      if (!/^\d+$/.test(values["expected-revision"]) ||
          !Number.isSafeInteger(Number(values["expected-revision"]))) {
        throw new Error("--expected-revision must be a non-negative safe integer.");
      }
      if (addingTask) throw new Error("--expected-revision applies only to existing tasks.");
      if (Number(values["expected-revision"]) !== revision) {
        throw new ConflictError("Task changed since it was read. Reload it and reconcile before saving.");
      }
    } else if (operator || before.feedback) {
      throw new ConflictError("This task needs --expected-revision from a fresh read.");
    }
    if (operator) {
      if (addingTask) throw new Error("Select an existing task.");
      if (typeof values.note !== "string" || !values.note.trim()) {
        throw new Error("A comment is required when moving a task from the dashboard.");
      }
      checkTransition(before, values.state, true);
    } else if (values["ack-feedback"] !== undefined) {
      if (!before.feedback || values["ack-feedback"] !== before.feedback.id) {
        throw new ConflictError("Dashboard feedback changed. Reread it before acknowledging.");
      }
      if (Object.keys(values).some((key) => !["task", "expected-revision", "ack-feedback"].includes(key))) {
        throw new Error("Use --ack-feedback only with --task and --expected-revision.");
      }
    } else if (before.feedback) {
      if (before.feedback.acknowledged_id !== before.feedback.id) {
        throw new ConflictError("Dashboard feedback is pending. Reconcile workers, then use --ack-feedback ID.");
      }
      if (values["feedback-id"] !== before.feedback.id) {
        throw new ConflictError("Worker feedback ID is stale or missing. Rebrief the worker before applying its result.");
      }
    } else if (values["feedback-id"] !== undefined) {
      throw new ConflictError("This task has no dashboard feedback matching --feedback-id.");
    }
    let task = structuredClone(before);
    if (values.state !== undefined && values.state !== task.state) {
      changeState(task, values, at, operator);
    } else {
      if (values.blocker !== undefined) {
        if (task.state !== "blocked") throw new Error("--blocker needs --state blocked or a blocked task.");
        task.blocker = { ...task.blocker, reason: values.blocker };
      }
      if (values.resolution !== undefined) {
        throw new Error("--resolution is allowed only when moving to resolved.");
      }
    }
    const patch = taskPatch(task, values);
    task = merge(task, { ...patch, updated_at: at, revision: revision + 1 });
    for (const [role, worker] of Object.entries(patch.workers ?? {})) {
      track(worker?.session, role, { task: task.id });
    }
    if (operator) {
      const id = randomUUID();
      Object.assign(task.history.at(-1), { source: "dashboard", feedback_id: id });
      task.feedback = { id, acknowledged_id: before.feedback?.acknowledged_id ?? null };
      task.merge = null;
      task.next_action = "Read dashboard feedback and reconcile workers before continuing.";
    } else if (values["ack-feedback"] !== undefined) {
      task.feedback.acknowledged_id = values["ack-feedback"];
    }
    tasks = inserting ? [...tasks, task] : tasks.map((item) => (item.id === task.id ? task : item));
    const from = addingTask ? null : before.state;
    events.push(from === task.state
      ? { type: "task.updated", task: task.id, data: { revision: task.revision } }
      : { type: "task.moved", task: task.id, data: { from, to: task.state, revision: task.revision } });
    if (operator) {
      events.push({ type: "feedback.pending", task: task.id, data: { feedback_id: task.feedback.id } });
    }
  }
  current = merge(current, rootPatch);
  current.tasks = tasks;
  validate(current);
  let stale = [];
  if (inserting) {
    const cutoff = Date.parse(now) - 7 * 24 * 60 * 60 * 1000;
    stale = current.tasks.filter((task) =>
      task.id !== values.task && task.state === "resolved" && Date.parse(task.updated_at) < cutoff &&
      !(task.feedback && task.feedback.acknowledged_id !== task.feedback.id));
    current.tasks = current.tasks.filter((task) => !stale.includes(task));
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
      throw new ConflictError("Factory changed during update. Reread it and reconcile before retrying.");
    }
    // Archive first: a retry upserts by ID, so a failure never loses a task.
    if (stale.length) await saveArchive(directory, current.project, stale);
    await recordSessions(registryFile(file), sessions);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  await announce(file, source, events);
  if (archived) {
    try {
      await removeArchived(directory, current.project, values.task);
    } catch (error) {
      throw new Error(`Task ${values.task} is restored, but its archive copy was not removed: ${error.message}. The live task wins; do not retry the restore.`);
    }
  }
  return current;
}

export async function update(file, values, { operator = false, source = operator ? "dashboard" : "coordinator" } = {}) {
  try {
    file = await realpath(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    file = join(await realpath(dirname(resolve(file))), basename(file));
  }
  const lockFile = `${file}.write.lock`;
  let lock;
  try {
    lock = await open(lockFile, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new ConflictError("Factory write is locked. Reread before retrying; remove a stale .write.lock only after verifying no writer is active.");
  }
  try {
    return await writeFactory(file, values, operator, source);
  } finally {
    try {
      await lock.close();
    } finally {
      await rm(lockFile);
    }
  }
}

const taskOptions = [
  "title", "issue", "pr", "head", "reviewed-head", "state", "note", "next-action", "blocker",
  "resolution", "links", "workers", "worktree", "merge", "details", "task-updated-at",
  "expected-revision", "feedback-id", "ack-feedback",
];

async function main() {
  let file;
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      options: {
        help: { type: "boolean", short: "h" },
        project: { type: "string" },
        "run-goal": { type: "string" },
        "run-status": { type: "string" },
        "rex-session": { type: "string" },
        rules: { type: "string" },
        limits: { type: "string" },
        "updated-at": { type: "string" },
        task: { type: "string" },
        restore: { type: "boolean" },
        ignored: { type: "string" },
        rule: { type: "string" },
        ran: { type: "boolean" },
        "rule-worker": { type: "string" },
        session: { type: "string" },
        source: { type: "string" },
        ...Object.fromEntries(taskOptions.map((option) => [option, { type: "string" }])),
      },
      allowPositionals: true,
    }));
    if (values.help) {
      console.log(`Create or update a factory.json with validated flags.

Usage: node factory.mjs FILE [RUN OPTIONS] [TASK OPTIONS]
       bun factory.mjs FILE [RUN OPTIONS] [TASK OPTIONS]

Create a factory (FILE is <owner.repo>-factory.json):
  node factory.mjs FILE --project owner/repo --run-goal "Run the factory for owner/repo" \\
    --rex-session "$REX_SESSION"

Add a task (link its GitHub issue, or pass --issue null for work without one):
  node factory.mjs FILE --task issue-42 --title "Fix login" \\
    --issue https://github.com/owner/repo/issues/42 --next-action "Start investigation"
  node factory.mjs FILE --task favicon --title "Add a favicon" --issue null \\
    --next-action "Start investigation"

Move a task (the state change and its history entry are one write):
  node factory.mjs FILE --task issue-42 --state investigation --note "Worker started"
  node factory.mjs FILE --task issue-42 --state blocked --blocker "Needs a product decision"
  node factory.mjs FILE --task issue-42 --state resolved --resolution merged

Bring back archived work (ask the user first; the add command prints this when a new task
matches an archived id, issue, or PR):
  node factory.mjs FILE --task issue-42 --restore --state initial --note "User wants it again" \\
    --expected-revision N

Run options:
  --project VALUE       Project (owner/repo); stored once
  --run-goal VALUE      Factory goal
  --run-status VALUE    active, paused, blocked, or finished (default active on create)
  --rex-session VALUE   Rex session the factory started in, or null
  --rules JSON          Replace the rules array. A rule: {id, description, enabled, kind?, query?,
                        every?, prompt?, last_run_at?, worker?}. kind: search (needs query), backlog,
                        or improve. every (30m, 6h, 1d) makes the rule run on a schedule while the
                        factory runs
  --rule ID --ran       Stamp the rule's last_run_at now. Do it before dispatching the run, and after
                        every due wake, even when nothing was found
  --rule ID --rule-worker JSON  Set the rule's worker record (same fields as a task worker), or null
  --ignored JSON        Replace the skipped-work list: [{url, at, reason}]
  --session UUID        Record the factory's own Copilot session in FILE's sessions registry
                        (<owner.repo>-factory-sessions.jsonl). Worker sessions are recorded
                        automatically from --workers and --rule-worker records that have a session
  --limits JSON         Merge worker caps, e.g. '{"investigation":2}' (default 3 each)
  --updated-at VALUE    Explicit run timestamp (ISO 8601 with timezone)
  --source NAME         Source of the events this write emits to the broker (default coordinator;
                        task.moved, task.updated, feedback.pending). The factory waits with
                        --exclude-source coordinator, so its own writes do not wake it

Task options:
  --task ID             Task ID; required when changing a task
  --title VALUE         Task title (new task)
  --issue VALUE         GitHub issue URL (new task), or null for work without an issue
  --pr VALUE            GitHub PR URL, or null
  --head VALUE          Full PR head SHA (local branch head without an issue), or null; a new head
                        clears the merge decision
  --reviewed-head VALUE Full SHA of the last reviewed head, or null
  --state VALUE         initial, investigation, implementation, review, blocked, resolved
  --note VALUE          History note for the state change
  --next-action VALUE   Next action (new task)
  --blocker VALUE       Reason; with --state blocked, or to edit a blocked task
  --resolution VALUE    ${outcomes.join(", ")}; with --state resolved
  --links JSON          Replace the GitHub issue/PR URL array
  --workers JSON        Merge worker records by role, e.g.
                        '{"implementation":{"status":"running","pane":"block:id"}}'; a null role clears it
  --worktree JSON       {"path":"...","created_by_run":true}, or null
  --merge JSON          Merge the head-specific decision ({authorized_by,source,evidence,
                        authorized_at,head,requested_at}), or null to clear it
                        Source: lever; legacy comment/factory-session records remain readable
                        Audit evidence only; recheck Lever's may_merge before landing
  --details JSON        Merge a JSON object into task details
  --task-updated-at VALUE  Explicit task and transition timestamp (ISO 8601 with timezone)
  --expected-revision N  Task revision from a fresh read (missing revision means 0)
                        Required after a dashboard move; rejects stale writes
  --ack-feedback ID     Acknowledge dashboard direction after reconciling workers
                        Use only with --task and --expected-revision
  --feedback-id ID      Feedback ID from the worker result; required after acknowledgement

Allowed moves: initial to investigation, investigation to implementation, implementation to
review, review to implementation, any open state to blocked or resolved, blocked to any open
state, and resolved to initial (reopen, not after a merge). A task with an issue needs a PR in
review and for a merge decision. A task without an issue (--issue null) uses every state without a
PR; record its local branch head in --head and, after a local git merge, the merge commit SHA in
--details before resolving it as merged. Adding or restoring a task moves resolved tasks
last updated more than seven days ago, except those with pending dashboard feedback, into
<owner.repo>-factory-archive/YYYY-MM-DD.json (by last update day). Archived tasks are never deleted.
Adding a new task that matches an archived id, issue, or PR fails; ask the user whether to restore
or skip it.
The helper validates the whole file before writing. Success is
silent. Errors go to stderr. Exit: 0 success, 1 invalid data or I/O, 2 usage. Use literal null
only for nullable fields. Keep the factory's owner lock while using this command.
The dashboard can move a task back or directly to resolved with a non-merge outcome and a comment.
A short-lived FILE.write.lock serializes
dashboard and CLI writes; it is separate from the factory owner lock. Each task write increments
revision. Dashboard feedback blocks agent updates until acknowledged, then fences out results
with an old feedback ID. A conflict is an error, never an automatic retry.`);
      return;
    }
    if (positionals.length !== 1 || !positionals[0]) throw new Error("Exactly one factory FILE is required.");
    [file] = positionals;
    if (values.task === undefined && taskOptions.some((option) => values[option] !== undefined)) {
      throw new Error("Task options require --task ID.");
    }
    if (values.task === undefined && Object.keys(values).length === 0) {
      throw new Error("Specify run options or --task ID.");
    }
    file = resolve(file);
  } catch (error) {
    console.error(`${error.message}\nRun with --help for usage.`);
    process.exitCode = 2;
    return;
  }
  try {
    const { source, ...writes } = values;
    await update(file, writes, { source });
  } catch (error) {
    console.error(`${file}: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
