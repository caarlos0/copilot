// The factory/v1 schema. Validators take `any` because they check untrusted JSON.
export const format = "factory/v1";
export const archiveFormat = "factory-archive/v1";
export const states = ["initial", "investigation", "implementation", "review", "blocked", "resolved"] as const;
export const transitions: Record<State, State[]> = {
  initial: ["investigation", "blocked", "resolved"],
  investigation: ["implementation", "blocked", "resolved"],
  implementation: ["review", "blocked", "resolved"],
  review: ["implementation", "blocked", "resolved"],
  blocked: ["initial", "investigation", "implementation", "review", "resolved"],
  resolved: ["initial"],
};
const runStatuses = ["active", "paused", "blocked", "finished"] as const;
export const outcomes = ["merged", "already-fixed", "duplicate", "invalid", "cancelled", "completed"] as const;
export const operatorOutcomes = outcomes.filter((outcome) => outcome !== "merged");
const mergeSources = ["lever", "comment", "factory-session"] as const;
const workerRoles = ["investigation", "implementation", "review"] as const;
const workerModes = ["one-shot", "continuous"] as const;
const workerStatuses = ["running", "idle", "closed", "unknown"] as const;
const ruleKinds = ["search", "backlog", "improve"] as const;
const everyUnits: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
export const defaultLimits: Limits = { investigation: 3, implementation: 3 };
export const maxWorkerSummary = 2000;
export const defaultBudget: Budget = { max_parallel_workers: 10 };
export const maxParallelWorkers = 100;
export const maxRoleLimit = 100;
export const leverSpends = ["standard", "high", "max"] as const;
export const leverAutonomyCaps = ["L0", "L1", "L2", "L3", "L4", "L5"] as const;

export type State = (typeof states)[number];
export type RunStatus = (typeof runStatuses)[number];
export type Outcome = (typeof outcomes)[number];
export type MergeSource = (typeof mergeSources)[number];
export type WorkerRole = (typeof workerRoles)[number];
export type WorkerMode = (typeof workerModes)[number];
export type WorkerStatus = (typeof workerStatuses)[number];
export type RuleKind = (typeof ruleKinds)[number];
export type LeverSpend = (typeof leverSpends)[number];
export type LeverAutonomyCap = (typeof leverAutonomyCaps)[number];
export type BlockerClass = (typeof blockerClasses)[number];

export type Worker = {
  status: WorkerStatus;
  mode?: WorkerMode | null;
  session?: string | null;
  pane?: string | null;
  window?: string | null;
  name?: string | null;
  brief?: string | null;
  result?: string | null;
  summary?: string | null;
  summary_at?: string | null;
  launched_at?: string;
  session_scan?: string;
};
export type BlockerOption = { label: string; state?: State; recommended?: boolean };
export type Blocker = {
  from: State;
  reason: string;
  since: string;
  class?: BlockerClass;
  owner?: string;
  options?: BlockerOption[];
};
export type Resolution = { outcome: Outcome; note?: string | null; at: string };
export type HistoryItem = {
  state: State;
  at: string;
  note?: string | null;
  source?: "dashboard";
  feedback_id?: string;
};
export type Feedback = { id: string; acknowledged_id: string | null };
export type Merge = {
  authorized_by: string;
  source: MergeSource;
  evidence: string;
  authorized_at: string;
  requested_at?: string | null;
  head: string;
};
export type Worktree = { path: string; created_by_run: boolean };
export type Task = {
  id: string;
  title: string;
  state: State;
  updated_at: string;
  revision?: number;
  next_action: string;
  issue?: string | null;
  pr?: string | null;
  head?: string | null;
  reviewed_head?: string | null;
  links: string[];
  history: HistoryItem[];
  feedback?: Feedback | null;
  blocker?: Blocker | null;
  resolution?: Resolution | null;
  merge?: Merge | null;
  workers: Partial<Record<WorkerRole, Worker | null>>;
  worktree?: Worktree | null;
  details?: Record<string, unknown> | null;
};
export type Rule = {
  id: string;
  description: string;
  enabled: boolean;
  query?: string | null;
  kind?: RuleKind;
  every?: string | null;
  prompt?: string | null;
  last_run_at?: string | null;
  worker?: Worker | null;
};
export type Ignored = { url: string; at: string; reason: string };
export type Limits = Partial<Record<"investigation" | "implementation", number>>;
export type Budget = { max_parallel_workers: number };
export type Lever = { spend?: LeverSpend | null; autonomy_cap?: LeverAutonomyCap | null };
export type Factory = {
  format: typeof format;
  id: string;
  project: string;
  goal: string;
  status: RunStatus;
  updated_at: string;
  rex_session?: string | null;
  rules: Rule[];
  ignored?: Ignored[];
  limits: Limits;
  budget?: Budget;
  lever?: Lever;
  tasks: Task[];
};
export type Archive = { format: typeof archiveFormat; project: string; day: string; tasks: Task[] };
// A factory as the dashboard sidebar lists it.
export type FactorySummary = {
  project: string;
  file: string;
  status: RunStatus;
  task_count: number;
  counts: Record<State, number>;
};
type Seen = { ids: Set<string>; issue: Set<string>; pr: Set<string> };

export function isObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function nullableText(value: unknown, field: string) {
  if (value != null) text(value, field);
}

function oneOf(value: unknown, values: readonly unknown[], field: string) {
  if (!values.includes(value)) throw new Error(`${field} must be one of: ${values.join(", ")}.`);
}

export function timestamp(value: any, field: string) {
  text(value, field);
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be a timestamp with a timezone.`);
  }
}

export function artifactName(value: any, field = "artifact") {
  text(value, field);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(`${field} must be a filename in the state directory.`);
  }
  return value;
}

// A brief is a worker brief in the state directory, or a task brief in its `briefs/` folder.
export function briefName(value: any, field = "brief") {
  text(value, field);
  if (!/^(briefs\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(`${field} must be a filename in the state directory or its briefs folder.`);
  }
  return value;
}

export function githubURL(value: unknown, field = "link") {
  const url = new URL(text(value, field));
  if (url.origin !== "https://github.com" || url.username || url.password ||
      !/^\/[^/]+\/[^/]+\/(issues|pull)\/\d+$/.test(url.pathname)) {
    throw new Error(`${field} must be an HTTPS GitHub issue or pull request URL.`);
  }
  return url;
}

// A security advisory URL (`/advisories/GHSA-...` or `/OWNER/REPO/security/advisories/GHSA-...`)
// as its canonical `https://github.com/advisories/GHSA-xxxx-xxxx-xxxx`, else null.
export function advisoryURL(value: string) {
  const match = /^https:\/\/github\.com\/(?:[^/?#]+\/[^/?#]+\/security\/)?advisories\/GHSA((?:-[23456789cfghjmpqrvwx]{4}){3})(?:[?#].*)?$/i.exec(value);
  return match && `https://github.com/advisories/GHSA${match[1].toLowerCase()}`;
}

// Issues first, then pull requests, then advisories, each by ascending number or ID. A resource
// that appears twice (query, fragment or owner/repo case differ) keeps its first URL.
export function sortReferences(hrefs: Iterable<string>) {
  const key = (href: string) => {
    if (advisoryURL(href)) return [2, 0];
    const [, , , kind, number] = githubURL(href).pathname.split("/");
    return [kind === "issues" ? 0 : 1, Number(number)];
  };
  const seen = new Set();
  const unique = [...hrefs].map((href) => advisoryURL(href) ?? href).filter((href) => {
    const identity = advisoryURL(href) ?? githubResourceURL(href).toLowerCase();
    return !seen.has(identity) && seen.add(identity);
  });
  return unique.sort((a, b) => {
    const [kindA, numberA] = key(a);
    const [kindB, numberB] = key(b);
    return kindA - kindB || (kindA === 2 ? a.localeCompare(b) : numberA - numberB);
  });
}

export function githubResourceURL(value: unknown, field = "link") {
  const url = githubURL(value, field);
  return `${url.origin}${url.pathname}`;
}

// The case-folded `github.com/owner/repo/(issues|pull)/N` identity of a link, or null for anything else.
export function resourceId(value: unknown) {
  try {
    return githubResourceURL(value).toLowerCase();
  } catch {
    return null;
  }
}

const ownIds = (task: Pick<Task, "issue" | "pr">) => [task.issue, task.pr].map(resourceId).filter(Boolean) as string[];
const namedIds = (task: Pick<Task, "issue" | "pr" | "links">) => new Set([...ownIds(task), ...(task.links ?? []).map(resourceId).filter(Boolean) as string[]]);

// Two tasks are one piece of work when the issue or PR of one appears in the other's issue, pr or links.
export function sharesWork(a: Pick<Task, "issue" | "pr" | "links">, b: Pick<Task, "issue" | "pr" | "links">) {
  const named = [namedIds(a), namedIds(b)];
  return ownIds(a).some((id) => named[1].has(id)) || ownIds(b).some((id) => named[0].has(id));
}

// Why a task cannot take part in a merge, or null. A merged PR is final; a merged-away task is done.
export function mergeRefusal(task: Task) {
  if (task.resolution?.outcome === "merged") return `Task ${task.id} was merged and is final.`;
  if (task.details?.merged_into != null) return `Task ${task.id} was already merged into ${task.details.merged_into}.`;
  return null;
}

const stageRank: Record<string, number> = { initial: 0, investigation: 1, implementation: 2, review: 3 };
const stage = (task: Task) => (task.state === "resolved" ? -1 : stageRank[task.state === "blocked" ? task.blocker!.from : task.state]);

// Sort order for the task a merge keeps: furthest along, then with a PR, then older. The first one wins.
export function keepFirst(a: Task, b: Task) {
  return stage(b) - stage(a) || Number(b.pr != null) - Number(a.pr != null) ||
    Date.parse(a.history[0].at) - Date.parse(b.history[0].at) || a.id.localeCompare(b.id);
}

function githubKind(value: unknown, kind: string, field: string) {
  const url = githubURL(value, field);
  if (url.pathname.split("/")[3] !== kind) {
    throw new Error(`${field} must be an HTTPS GitHub ${kind === "pull" ? "pull request" : "issue"} URL.`);
  }
  return url.href;
}

const issueURL = (value: unknown, field = "issue") => githubKind(value, "issues", field);
export const prURL = (value: unknown, field = "pr") => githubKind(value, "pull", field);

function fullSHA(value: unknown, field: string) {
  if (value != null && !/^[a-f0-9]{40}$/.test(value as string)) {
    throw new Error(`${field} must be a full 40-character lowercase commit SHA or null.`);
  }
}

export function entered(task: Task) {
  return task.history.at(-1)!.at;
}

export function byRecency<T extends Task>(tasks: T[]) {
  const time = (task: Task) => Date.parse(task.updated_at) || Date.parse(task.history?.at(-1)?.at as string) || 0;
  return [...tasks].sort((a, b) => time(b) - time(a) || a.id.localeCompare(b.id));
}

// The worker summary a task card shows: the current state's role first, else the newest by summary_at.
export function cardSummary(task: Task) {
  const time = (worker: Worker | null | undefined) => Date.parse(worker!.summary_at!) || 0;
  const found = Object.entries(task.workers ?? {}).filter(([, worker]) => worker?.summary);
  const [role, worker] = found.find(([name]) => name === task.state)
    ?? found.sort(([, a], [, b]) => time(b) - time(a))[0] ?? [];
  return worker ? { role, text: worker.summary } : null;
}

// Task palette matching: every term must appear in the task's identifying fields, never in history or comments.
export function rankTasks<T extends Task>(tasks: T[], query: string, limit = 20) {
  const text = query.trim().toLowerCase();
  if (!text) return byRecency(tasks).slice(0, limit);
  const terms = text.split(/\s+/);
  const rank = (task: Task) => {
    const id = task.id.toLowerCase();
    const title = task.title.toLowerCase();
    if (id === text) return 0;
    if (id.startsWith(text)) return 1;
    if (title.startsWith(text)) return 2;
    if (id.includes(text)) return 3;
    return title.includes(text) ? 4 : 5;
  };
  const searchable = (task: Task) => [task.id, task.title, task.state, task.resolution?.outcome, task.issue, task.pr, ...task.links]
    .filter(Boolean).join("\n").toLowerCase();
  return byRecency(tasks)
    .filter((task) => terms.every((term) => searchable(task).includes(term)))
    .map((task) => ({ task, rank: rank(task) }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map(({ task }) => task);
}

export function cyclesOf(task: Task) {
  return task.history.filter((item, index) =>
    item.state === "implementation" && task.history[index - 1]?.state === "review").length;
}

// A task without an issue follows the local flow: it can review and merge without a PR.
const needsPR = (task: Task) => task.issue != null && task.pr == null;

export function operatorStates(task: Task): State[] {
  const open: State[] = ["initial", "investigation", "implementation", "review"];
  if (task.state === "resolved") return task.resolution?.outcome === "merged" ? [] : ["initial"];
  const candidates = task.state === "blocked" ? open : open.slice(0, open.indexOf(task.state));
  return [...candidates.filter((state) => state !== "review" || !needsPR(task)), "resolved"];
}

const openStates = ["initial", "investigation", "implementation", "review"];
const maxBlockerOptions = 8;
export const blockerClasses = ["user-decision", "outside-action", "external-wait", "ci-infra", "approval"] as const;
const blockerOwner = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function validateBlockerOwner(owner: unknown, field: string) {
  if (typeof owner !== "string" || !blockerOwner.test(owner)) {
    throw new Error(`${field} must be a GitHub login or operator.`);
  }
}

// "Class: user-decision. Owner: alice.", or null for an old blocker with neither.
export function blockerMeta(blocker: Blocker) {
  const parts = [blocker.class && `Class: ${blocker.class}.`, blocker.owner && `Owner: ${blocker.owner}.`];
  return parts.filter(Boolean).join(" ") || null;
}
const maxOptionLabel = 300;

function validateBlockerOptions(options: any, field: string) {
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

// The Recommended badge comes from the `recommended` flag, so a typed "(recommended)" suffix is noise.
export const stripRecommended = (label: string) => label.replace(/\s*[(\[]\s*recommended\s*[)\]]\s*$/i, "");

// --blocker is plain text, or a JSON object {"reason": "...", "options": [...], "class": "...", "owner": "..."}.
export function parseBlocker(value: string): Pick<Blocker, "reason" | "class" | "owner" | "options"> {
  const input = typeof value === "string" ? value.trim() : "";
  let parsed: any;
  if (input.startsWith("{")) {
    try { parsed = JSON.parse(input); } catch { /* plain text that starts with a brace */ }
  }
  if (!isObject(parsed)) return { reason: value };
  const extra = Object.keys(parsed).filter((key) => !["reason", "options", "class", "owner"].includes(key));
  if (extra.length) throw new Error(`--blocker JSON has unknown keys: ${extra.join(", ")}.`);
  text(parsed.reason, "--blocker reason");
  const meta: Pick<Blocker, "class" | "owner"> = {};
  if (parsed.class !== undefined) {
    oneOf(parsed.class, blockerClasses, "--blocker class");
    meta.class = parsed.class;
  }
  if (parsed.owner !== undefined) {
    validateBlockerOwner(parsed.owner, "--blocker owner");
    meta.owner = parsed.owner;
  }
  if (parsed.options === undefined) return { reason: parsed.reason, ...meta };
  const options = Array.isArray(parsed.options)
    ? parsed.options.map((option: any) => (isObject(option) && typeof option.label === "string"
      ? { ...option, label: stripRecommended(option.label) }
      : option))
    : parsed.options;
  validateBlockerOptions(options, "--blocker options");
  return { reason: parsed.reason, ...meta, options };
}

// The destination an Unblock popup selects first: where the task was blocked from, else the first open one.
export function unblockState(task: Task) {
  const choices = operatorStates(task);
  return choices.includes(task.blocker?.from as State) ? task.blocker!.from : choices[0];
}

// Choosing an option copies its label into the comment and, when allowed, selects its state.
export function unblockChoice(task: Task, option: BlockerOption) {
  const state = operatorStates(task).includes(option.state as State) ? option.state : unblockState(task);
  return { state, comment: stripRecommended(option.label) };
}

export function checkTransition(task: Task, to: string, operator = false) {
  if (task.state === to && !operator) return;
  const allowed: string[] = operator ? operatorStates(task) : [...transitions[task.state]];
  // A PR handed over for review skips the work states.
  if (!operator && task.state === "initial" && task.pr != null) allowed.push("review");
  if (!allowed.includes(to)) {
    throw new Error(`Task ${task.id} cannot move from ${task.state} to ${to}. Allowed: ${allowed.join(", ") || "none"}.`);
  }
  if (task.state === "resolved" && task.resolution?.outcome === "merged") {
    throw new Error(`Task ${task.id} was merged. Create a new task instead of reopening it.`);
  }
}

function validateWorker(field: string, worker: any) {
  if (!isObject(worker)) throw new Error(`${field} must be an object or null.`);
  oneOf(worker.status, workerStatuses, `${field}.status`);
  if (worker.mode != null) oneOf(worker.mode, workerModes, `${field}.mode`);
  for (const key of ["session", "pane", "window", "name"]) nullableText(worker[key], `${field}.${key}`);
  for (const key of ["brief", "result"]) {
    if (worker[key] != null) artifactName(worker[key], `${field}.${key}`);
  }
  if (worker.summary != null) {
    text(worker.summary, `${field}.summary`);
    if (worker.summary.length > maxWorkerSummary) {
      throw new Error(`${field}.summary must be at most ${maxWorkerSummary} characters.`);
    }
  }
  if (worker.summary_at != null) timestamp(worker.summary_at, `${field}.summary_at`);
}

function validateTask(task: any, seen: Seen) {
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

  for (const [field, check] of [["issue", issueURL], ["pr", prURL]] as const) {
    if (task[field] == null) continue;
    const href = check(task[field], `${at} ${field}`);
    const identity = githubResourceURL(href, `${at} ${field}`);
    if (seen[field].has(identity)) throw new Error(`Duplicate ${field} URL across tasks: ${href}`);
    seen[field].add(identity);
  }
  fullSHA(task.head, `${at} head`);
  fullSHA(task.reviewed_head, `${at} reviewed_head`);
  if (!Array.isArray(task.links)) throw new Error(`${at} links must be an array.`);
  for (const value of task.links) if (!advisoryURL(value)) githubURL(value, `${at} links[]`);

  if (!Array.isArray(task.history) || !task.history.length) {
    throw new Error(`${at} history must be a non-empty array.`);
  }
  const feedbackIds: string[] = [];
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
    if (task.blocker.class !== undefined) oneOf(task.blocker.class, blockerClasses, `${at} blocker.class`);
    if (task.blocker.owner !== undefined) validateBlockerOwner(task.blocker.owner, `${at} blocker.owner`);
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

export function validateArchive(data: any, project: string, day: string) {
  if (!isObject(data)) throw new Error("Archive must be a JSON object.");
  if (data.format !== archiveFormat) throw new Error(`format must be "${archiveFormat}".`);
  if (data.project !== project) throw new Error(`project must be "${project}".`);
  if (data.day !== day) throw new Error(`day must be "${day}".`);
  if (!Array.isArray(data.tasks)) throw new Error("tasks must be an array.");
  const ids = new Set<string>();
  for (const task of data.tasks) validateTask(task, { ids, issue: new Set<string>(), pr: new Set<string>() });
}

export function intervalMs(every: string) {
  const match = /^([1-9]\d{0,3})([mhd])$/.exec(every);
  if (!match) throw new Error(`every must look like 30m, 6h, or 1d (up to 9999 units), not ${JSON.stringify(every)}.`);
  return Number(match[1]) * everyUnits[match[2]];
}

// Epoch ms when the rule is next due; 0 means due now; null means it has no schedule.
export function nextRun(rule: Rule) {
  if (!rule.enabled || !rule.every) return null;
  return rule.last_run_at == null ? 0 : Date.parse(rule.last_run_at) + intervalMs(rule.every);
}

export function dueRules(data: Factory, now = Date.now()) {
  if (data.status !== "active") return [];
  return data.rules.filter((rule) => (nextRun(rule) ?? Infinity) <= now).map((rule) => rule.id);
}

export function nextDue(data: Factory) {
  if (data.status !== "active") return null;
  const times = data.rules.map(nextRun).filter((time) => time !== null);
  return times.length ? Math.min(...times) : null;
}

function validateRule(rule: any) {
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

export function validate(data: any) {
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
  for (const [role, limit] of Object.entries<any>(data.limits)) {
    oneOf(role, ["investigation", "implementation"], "limits key");
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`limits.${role} must be a positive integer.`);
  }
  if (data.budget !== undefined) validateBudget(data.budget);
  if (data.lever !== undefined) validateLever(data.lever);
  if (!Array.isArray(data.tasks)) throw new Error("tasks must be an array.");
  const seen: Seen = { ids: new Set(), issue: new Set(), pr: new Set() };
  for (const task of data.tasks) validateTask(task, seen);
}

function validateBudget(budget: any) {
  if (!isObject(budget)) throw new Error("budget must be an object.");
  for (const key of Object.keys(budget)) oneOf(key, ["max_parallel_workers"], "budget key");
  const value = budget.max_parallel_workers;
  if (!Number.isInteger(value) || value < 1 || value > maxParallelWorkers) {
    throw new Error(`budget.max_parallel_workers must be an integer from 1 to ${maxParallelWorkers}.`);
  }
}

// Ceilings only: null or a missing key means no cap. They can lower what Lever resolves, never raise it.
function validateLever(lever: any) {
  if (!isObject(lever)) throw new Error("lever must be an object.");
  for (const [key, value] of Object.entries(lever)) {
    oneOf(key, ["spend", "autonomy_cap"], "lever key");
    if (value !== null) oneOf(value, key === "spend" ? leverSpends : leverAutonomyCaps, `lever.${key}`);
  }
}

export function countByState(tasks: Pick<Task, "state">[]) {
  const counts = Object.fromEntries(states.map((state) => [state, 0])) as Record<State, number>;
  for (const task of tasks) counts[task.state] += 1;
  return counts;
}

// Sidebar order: active with open tasks, paused or blocked with open tasks (after the active ones), nothing open, finished.
function factoryGroup({ status, task_count, counts }: FactorySummary) {
  if (status === "finished") return 3;
  if (task_count - counts.resolved === 0) return 2;
  return status === "active" ? 0 : 1;
}

// The sidebar section of a factory: open work (running, paused, or blocked), nothing open, or finished.
export const factorySections = [["active", "Active"], ["idle", "Idle"], ["finished", "Finished"]];
export const factorySection = (factory: FactorySummary) => factorySections[Math.max(factoryGroup(factory) - 1, 0)][0];

export function compareFactories(a: FactorySummary, b: FactorySummary) {
  return factoryGroup(a) - factoryGroup(b)
    || a.project.localeCompare(b.project, undefined, { sensitivity: "base" })
    || a.file.localeCompare(b.file);
}

// Plain digits 1-9 pick the Nth of `count` sidebar items; -1 when the key is not a hotkey.
export function digitIndex(
  { key, metaKey, ctrlKey, altKey, shiftKey }: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean },
  count: number,
) {
  if (metaKey || ctrlKey || altKey || shiftKey || !/^[1-9]$/.test(key)) return -1;
  const index = Number(key) - 1;
  return index < count ? index : -1;
}

// Shortens an `owner/repo` label until `measure(text)` fits `width`, like fish's prompt_pwd:
// full name, abbreviated owner, repo alone, then the repo cut from the start so its end stays.
export function fitProjectLabel(label: string, width: number, measure: (text: string) => number) {
  const slash = label.indexOf("/");
  const repo = label.slice(slash + 1);
  const steps = slash > 0 ? [label, `${label[0]}/${repo}`, repo] : [label];
  const fits = steps.find((text) => measure(text) <= width);
  if (fits !== undefined) return fits;
  for (let keep = repo.length - 1; keep > 0; keep--) {
    const text = `…${repo.slice(-keep)}`;
    if (measure(text) <= width) return text;
  }
  return "…";
}
