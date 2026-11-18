export const format = "factory/v1";
export const archiveFormat = "factory-archive/v1";
export const states = ["initial", "investigation", "implementation", "review", "blocked", "resolved"];
const transitions = {
  initial: ["investigation", "blocked", "resolved"],
  investigation: ["implementation", "blocked", "resolved"],
  implementation: ["review", "blocked", "resolved"],
  review: ["implementation", "blocked", "resolved"],
  blocked: ["initial", "investigation", "implementation", "review", "resolved"],
  resolved: ["initial"],
};
const runStatuses = ["active", "paused", "blocked", "finished"];
export const outcomes = ["merged", "already-fixed", "duplicate", "invalid", "cancelled", "completed"];
export const operatorOutcomes = outcomes.filter((outcome) => outcome !== "merged");
const mergeSources = ["lever", "comment", "factory-session"];
const workerRoles = ["investigation", "implementation", "review"];
const workerModes = ["one-shot", "continuous"];
const workerStatuses = ["running", "idle", "closed", "unknown"];
const ruleKinds = ["search", "backlog", "improve"];
const everyUnits = { m: 60_000, h: 3_600_000, d: 86_400_000 };
export const defaultLimits = { investigation: 3, implementation: 3 };
export const defaultBudget = { max_parallel_workers: 10 };
export const maxParallelWorkers = 100;
export const maxRoleLimit = 100;
export const leverSpends = ["standard", "high", "max"];
export const leverAutonomyCaps = ["L0", "L1", "L2", "L3", "L4", "L5"];

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function nullableText(value, field) {
  if (value != null) text(value, field);
}

function oneOf(value, values, field) {
  if (!values.includes(value)) throw new Error(`${field} must be one of: ${values.join(", ")}.`);
}

export function timestamp(value, field) {
  text(value, field);
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be a timestamp with a timezone.`);
  }
}

export function artifactName(value, field = "artifact") {
  text(value, field);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(`${field} must be a filename in the state directory.`);
  }
  return value;
}

export function githubURL(value, field = "link") {
  const url = new URL(text(value, field));
  if (url.origin !== "https://github.com" || url.username || url.password ||
      !/^\/[^/]+\/[^/]+\/(issues|pull)\/\d+$/.test(url.pathname)) {
    throw new Error(`${field} must be an HTTPS GitHub issue or pull request URL.`);
  }
  return url;
}

export function githubResourceURL(value, field = "link") {
  const url = githubURL(value, field);
  return `${url.origin}${url.pathname}`;
}

function githubKind(value, kind, field) {
  const url = githubURL(value, field);
  if (url.pathname.split("/")[3] !== kind) {
    throw new Error(`${field} must be an HTTPS GitHub ${kind === "pull" ? "pull request" : "issue"} URL.`);
  }
  return url.href;
}

const issueURL = (value, field = "issue") => githubKind(value, "issues", field);
export const prURL = (value, field = "pr") => githubKind(value, "pull", field);

function fullSHA(value, field) {
  if (value != null && !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(`${field} must be a full 40-character lowercase commit SHA or null.`);
  }
}

export function entered(task) {
  return task.history.at(-1).at;
}

export function byRecency(tasks) {
  const time = (task) => Date.parse(task.history?.at(-1)?.at) || 0;
  return [...tasks].sort((a, b) => time(b) - time(a) || a.id.localeCompare(b.id));
}

// Task palette matching: every term must appear in the task's identifying fields, never in history or comments.
export function rankTasks(tasks, query, limit = 20) {
  const text = query.trim().toLowerCase();
  if (!text) return byRecency(tasks).slice(0, limit);
  const terms = text.split(/\s+/);
  const rank = (task) => {
    const id = task.id.toLowerCase();
    const title = task.title.toLowerCase();
    if (id === text) return 0;
    if (id.startsWith(text)) return 1;
    if (title.startsWith(text)) return 2;
    if (id.includes(text)) return 3;
    return title.includes(text) ? 4 : 5;
  };
  const searchable = (task) => [task.id, task.title, task.state, task.resolution?.outcome, task.issue, task.pr, ...task.links]
    .filter(Boolean).join("\n").toLowerCase();
  return byRecency(tasks)
    .filter((task) => terms.every((term) => searchable(task).includes(term)))
    .map((task) => ({ task, rank: rank(task) }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map(({ task }) => task);
}

export function cyclesOf(task) {
  return task.history.filter((item, index) =>
    item.state === "implementation" && task.history[index - 1]?.state === "review").length;
}

// A task without an issue follows the local flow: it can review and merge without a PR.
const needsPR = (task) => task.issue != null && task.pr == null;

export function operatorStates(task) {
  const open = ["initial", "investigation", "implementation", "review"];
  if (task.state === "resolved") return task.resolution?.outcome === "merged" ? [] : ["initial"];
  const candidates = task.state === "blocked" ? open : open.slice(0, open.indexOf(task.state));
  return [...candidates.filter((state) => state !== "review" || !needsPR(task)), "resolved"];
}

const openStates = ["initial", "investigation", "implementation", "review"];
const maxBlockerOptions = 8;
const maxOptionLabel = 300;

function validateBlockerOptions(options, field) {
  if (!Array.isArray(options) || !options.length || options.length > maxBlockerOptions) {
    throw new Error(`${field} must be an array of 1 to ${maxBlockerOptions} options.`);
  }
  let recommended = 0;
  for (const option of options) {
    if (!isObject(option)) throw new Error(`${field} entries must be objects.`);
    text(option.label, `${field} label`);
    if (option.label.length > maxOptionLabel) {
      throw new Error(`${field} label must be at most ${maxOptionLabel} characters.`);
    }
    if (option.state !== undefined) oneOf(option.state, openStates, `${field} state`);
    if (option.recommended !== undefined) {
      if (typeof option.recommended !== "boolean") throw new Error(`${field} recommended must be a boolean.`);
      if (option.recommended) recommended += 1;
    }
  }
  if (recommended > 1) throw new Error(`${field} may have at most one recommended option.`);
}

// --blocker is plain text, or a JSON object {"reason": "...", "options": [...]}.
export function parseBlocker(value) {
  const input = typeof value === "string" ? value.trim() : "";
  let parsed;
  if (input.startsWith("{")) {
    try { parsed = JSON.parse(input); } catch { /* plain text that starts with a brace */ }
  }
  if (!isObject(parsed)) return { reason: value };
  const extra = Object.keys(parsed).filter((key) => key !== "reason" && key !== "options");
  if (extra.length) throw new Error(`--blocker JSON has unknown keys: ${extra.join(", ")}.`);
  text(parsed.reason, "--blocker reason");
  if (parsed.options === undefined) return { reason: parsed.reason };
  validateBlockerOptions(parsed.options, "--blocker options");
  return { reason: parsed.reason, options: parsed.options };
}

// The destination an Unblock popup selects first: where the task was blocked from, else the first open one.
export function unblockState(task) {
  const choices = operatorStates(task);
  return choices.includes(task.blocker?.from) ? task.blocker.from : choices[0];
}

// Choosing an option copies its label verbatim into the comment and, when allowed, selects its state.
export function unblockChoice(task, option) {
  const state = operatorStates(task).includes(option.state) ? option.state : unblockState(task);
  return { state, comment: option.label };
}

export function checkTransition(task, to, operator = false) {
  if (task.state === to && !operator) return;
  const allowed = operator ? operatorStates(task) : [...transitions[task.state]];
  // A PR handed over for review skips the work states.
  if (!operator && task.state === "initial" && task.pr != null) allowed.push("review");
  if (!allowed.includes(to)) {
    throw new Error(`Task ${task.id} cannot move from ${task.state} to ${to}. Allowed: ${allowed.join(", ") || "none"}.`);
  }
  if (task.state === "resolved" && task.resolution?.outcome === "merged") {
    throw new Error(`Task ${task.id} was merged. Create a new task instead of reopening it.`);
  }
}

function validateWorker(field, worker) {
  if (!isObject(worker)) throw new Error(`${field} must be an object or null.`);
  oneOf(worker.status, workerStatuses, `${field}.status`);
  if (worker.mode != null) oneOf(worker.mode, workerModes, `${field}.mode`);
  for (const key of ["session", "pane", "window", "name"]) nullableText(worker[key], `${field}.${key}`);
  for (const key of ["brief", "result"]) {
    if (worker[key] != null) artifactName(worker[key], `${field}.${key}`);
  }
}

function validateTask(task, seen) {
  if (!isObject(task)) throw new Error("Each task must be a JSON object.");
  for (const field of ["id", "title", "next_action"]) text(task[field], `task.${field}`);
  const at = `Task ${task.id}`;
  if (seen.ids.has(task.id)) throw new Error(`Duplicate task ID: ${task.id}`);
  seen.ids.add(task.id);
  oneOf(task.state, states, `${at} state`);
  timestamp(task.updated_at, `${at} updated_at`);
  if (task.revision !== undefined && (!Number.isSafeInteger(task.revision) || task.revision < 0)) {
    throw new Error(`${at} revision must be a non-negative safe integer.`);
  }

  for (const [field, check] of [["issue", issueURL], ["pr", prURL]]) {
    if (task[field] == null) continue;
    const href = check(task[field], `${at} ${field}`);
    const identity = githubResourceURL(href, `${at} ${field}`);
    if (seen[field].has(identity)) throw new Error(`Duplicate ${field} URL across tasks: ${href}`);
    seen[field].add(identity);
  }
  fullSHA(task.head, `${at} head`);
  fullSHA(task.reviewed_head, `${at} reviewed_head`);
  if (!Array.isArray(task.links)) throw new Error(`${at} links must be an array.`);
  for (const value of task.links) githubURL(value, `${at} links[]`);

  if (!Array.isArray(task.history) || !task.history.length) {
    throw new Error(`${at} history must be a non-empty array.`);
  }
  const feedbackIds = [];
  for (const item of task.history) {
    if (!isObject(item)) throw new Error(`${at} history entries must be objects.`);
    oneOf(item.state, states, `${at} history state`);
    timestamp(item.at, `${at} history at`);
    nullableText(item.note, `${at} history note`);
    if (item.source !== undefined) {
      oneOf(item.source, ["dashboard"], `${at} history source`);
      text(item.note, `${at} dashboard comment`);
      text(item.feedback_id, `${at} history feedback_id`);
      if (feedbackIds.includes(item.feedback_id)) throw new Error(`${at}: duplicate feedback ID.`);
      feedbackIds.push(item.feedback_id);
    } else if (item.feedback_id !== undefined) {
      throw new Error(`${at}: feedback history needs source dashboard.`);
    }
  }
  if (task.history.at(-1).state !== task.state) {
    throw new Error(`${at}: the last history entry must match state ${task.state}.`);
  }
  if (task.feedback != null) {
    if (!isObject(task.feedback)) throw new Error(`${at} feedback must be an object or null.`);
    text(task.feedback.id, `${at} feedback.id`);
    if (task.feedback.id !== feedbackIds.at(-1)) {
      throw new Error(`${at}: feedback must reference the latest dashboard history entry.`);
    }
    if (task.feedback.acknowledged_id !== null && !feedbackIds.includes(task.feedback.acknowledged_id)) {
      throw new Error(`${at}: feedback acknowledgement must reference dashboard history.`);
    }
  } else if (feedbackIds.length) {
    throw new Error(`${at}: dashboard history needs a feedback record.`);
  }

  if (task.state === "blocked") {
    if (!isObject(task.blocker)) throw new Error(`${at}: a blocked task needs a blocker object.`);
    oneOf(task.blocker.from, states.filter((state) => state !== "blocked" && state !== "resolved"),
      `${at} blocker.from`);
    text(task.blocker.reason, `${at} blocker.reason`);
    timestamp(task.blocker.since, `${at} blocker.since`);
    if (task.blocker.options !== undefined) validateBlockerOptions(task.blocker.options, `${at} blocker.options`);
  } else if (task.blocker != null) {
    throw new Error(`${at}: blocker is allowed only in the blocked state.`);
  }
  if (task.state === "resolved") {
    if (!isObject(task.resolution)) throw new Error(`${at}: a resolved task needs a resolution object.`);
    oneOf(task.resolution.outcome, outcomes, `${at} resolution.outcome`);
    timestamp(task.resolution.at, `${at} resolution.at`);
    nullableText(task.resolution.note, `${at} resolution.note`);
  } else if (task.resolution != null) {
    throw new Error(`${at}: resolution is allowed only in the resolved state.`);
  }
  if (task.state === "review" && needsPR(task)) {
    throw new Error(`${at}: a task with an issue needs a pr in review.`);
  }

  if (task.merge != null) {
    if (!isObject(task.merge)) throw new Error(`${at} merge must be an object or null.`);
    if (needsPR(task)) throw new Error(`${at}: a merge decision for a task with an issue needs a pr.`);
    text(task.merge.authorized_by, `${at} merge.authorized_by`);
    oneOf(task.merge.source, mergeSources, `${at} merge.source`);
    text(task.merge.evidence, `${at} merge.evidence`);
    timestamp(task.merge.authorized_at, `${at} merge.authorized_at`);
    if (task.merge.requested_at != null) timestamp(task.merge.requested_at, `${at} merge.requested_at`);
    if (task.merge.head == null) throw new Error(`${at} merge.head is required.`);
    fullSHA(task.merge.head, `${at} merge.head`);
    if (task.state !== "resolved" && task.head !== task.merge.head) {
      throw new Error(`${at}: merge decision is for head ${task.merge.head}, not the current head. Clear it with --merge null.`);
    }
  }

  if (!isObject(task.workers)) throw new Error(`${at} workers must be an object.`);
  for (const [role, worker] of Object.entries(task.workers)) {
    oneOf(role, workerRoles, `${at} worker role`);
    if (worker != null) validateWorker(`${at} workers.${role}`, worker);
  }
  if (task.worktree != null) {
    if (!isObject(task.worktree)) throw new Error(`${at} worktree must be an object or null.`);
    text(task.worktree.path, `${at} worktree.path`);
    if (typeof task.worktree.created_by_run !== "boolean") {
      throw new Error(`${at} worktree.created_by_run must be a boolean.`);
    }
  }
  if (task.details != null && !isObject(task.details)) {
    throw new Error(`${at} details must be an object or null.`);
  }
}

export function validateArchive(data, project, day) {
  if (!isObject(data)) throw new Error("Archive must be a JSON object.");
  if (data.format !== archiveFormat) throw new Error(`format must be "${archiveFormat}".`);
  if (data.project !== project) throw new Error(`project must be "${project}".`);
  if (data.day !== day) throw new Error(`day must be "${day}".`);
  if (!Array.isArray(data.tasks)) throw new Error("tasks must be an array.");
  const ids = new Set();
  for (const task of data.tasks) validateTask(task, { ids, issue: new Set(), pr: new Set() });
}

export function intervalMs(every) {
  const match = /^([1-9]\d{0,3})([mhd])$/.exec(every);
  if (!match) throw new Error(`every must look like 30m, 6h, or 1d (up to 9999 units), not ${JSON.stringify(every)}.`);
  return Number(match[1]) * everyUnits[match[2]];
}

// Epoch ms when the rule is next due; 0 means due now; null means it has no schedule.
export function nextRun(rule) {
  if (!rule.enabled || !rule.every) return null;
  return rule.last_run_at == null ? 0 : Date.parse(rule.last_run_at) + intervalMs(rule.every);
}

export function dueRules(data, now = Date.now()) {
  if (data.status !== "active") return [];
  return data.rules.filter((rule) => (nextRun(rule) ?? Infinity) <= now).map((rule) => rule.id);
}

export function nextDue(data) {
  if (data.status !== "active") return null;
  const times = data.rules.map(nextRun).filter((time) => time !== null);
  return times.length ? Math.min(...times) : null;
}

function validateRule(rule) {
  if (!isObject(rule)) throw new Error("Each rule must be a JSON object.");
  text(rule.id, "rule.id");
  const at = `Rule ${rule.id}`;
  text(rule.description, `${at} description`);
  nullableText(rule.query, `${at} query`);
  if (typeof rule.enabled !== "boolean") throw new Error(`${at} enabled must be a boolean.`);
  if (rule.last_run_at != null) timestamp(rule.last_run_at, `${at} last_run_at`);
  if (rule.kind !== undefined) oneOf(rule.kind, ruleKinds, `${at} kind`);
  if (rule.kind === "search") text(rule.query, `${at} query`);
  if (rule.every != null) intervalMs(rule.every);
  nullableText(rule.prompt, `${at} prompt`);
  if (rule.worker != null) validateWorker(`${at} worker`, rule.worker);
}

export function validate(data) {
  if (!isObject(data)) throw new Error("Factory must be a JSON object.");
  if (data.format !== format) throw new Error(`format must be "${format}".`);
  for (const field of ["id", "project", "goal"]) text(data[field], field);
  oneOf(data.status, runStatuses, "status");
  timestamp(data.updated_at, "updated_at");
  nullableText(data.rex_session, "rex_session");
  if (!Array.isArray(data.rules)) throw new Error("rules must be an array.");
  const ruleIds = new Set();
  for (const rule of data.rules) {
    validateRule(rule);
    if (ruleIds.has(rule.id)) throw new Error(`Duplicate rule ID: ${rule.id}`);
    ruleIds.add(rule.id);
  }
  if (data.ignored !== undefined) {
    if (!Array.isArray(data.ignored)) throw new Error("ignored must be an array.");
    for (const item of data.ignored) {
      if (!isObject(item)) throw new Error("Each ignored entry must be a JSON object.");
      githubURL(item.url, "ignored.url");
      timestamp(item.at, "ignored.at");
      text(item.reason, "ignored.reason");
    }
  }
  if (!isObject(data.limits)) throw new Error("limits must be an object.");
  for (const [role, limit] of Object.entries(data.limits)) {
    oneOf(role, ["investigation", "implementation"], "limits key");
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`limits.${role} must be a positive integer.`);
  }
  if (data.budget !== undefined) validateBudget(data.budget);
  if (data.lever !== undefined) validateLever(data.lever);
  if (!Array.isArray(data.tasks)) throw new Error("tasks must be an array.");
  const seen = { ids: new Set(), issue: new Set(), pr: new Set() };
  for (const task of data.tasks) validateTask(task, seen);
}

export function validateBudget(budget) {
  if (!isObject(budget)) throw new Error("budget must be an object.");
  for (const key of Object.keys(budget)) oneOf(key, ["max_parallel_workers"], "budget key");
  const value = budget.max_parallel_workers;
  if (!Number.isInteger(value) || value < 1 || value > maxParallelWorkers) {
    throw new Error(`budget.max_parallel_workers must be an integer from 1 to ${maxParallelWorkers}.`);
  }
}

// Ceilings only: null or a missing key means no cap. They can lower what Lever resolves, never raise it.
export function validateLever(lever) {
  if (!isObject(lever)) throw new Error("lever must be an object.");
  for (const [key, value] of Object.entries(lever)) {
    oneOf(key, ["spend", "autonomy_cap"], "lever key");
    if (value !== null) oneOf(value, key === "spend" ? leverSpends : leverAutonomyCaps, `lever.${key}`);
  }
}

// Every worker with status running counts, whatever its role, including rule workers.
export function runningWorkers(data) {
  const workers = [...data.tasks.flatMap((task) => Object.values(task.workers)), ...data.rules.map((rule) => rule.worker)];
  return workers.filter((worker) => worker?.status === "running").length;
}

export function budgetText(data) {
  const cap = data.budget?.max_parallel_workers;
  return `${runningWorkers(data)} running / ${cap === undefined ? "no total cap" : `budget ${cap}`}`;
}

export function countByState(tasks) {
  const counts = Object.fromEntries(states.map((state) => [state, 0]));
  for (const task of tasks) counts[task.state] += 1;
  return counts;
}

export const isIdle = (tasks) => tasks.every((task) => task.state === "resolved");

export function hopsSince(tasks, since) {
  const cutoff = Date.parse(since);
  return tasks.flatMap((task) => task.history.flatMap((item, index) =>
    Date.parse(item.at) > cutoff
      ? [{ id: task.id, from: task.history[index - 1]?.state ?? null, to: item.state, at: item.at }]
      : []))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
