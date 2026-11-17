import { createHash, randomUUID } from "node:crypto";
import { access, link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { format, githubURL, prURL, validate } from "./factory-data.mjs";

const sources = ["implementer", "coordinator"];
const defaultLimits = { investigation: 3, implementation: 3 };

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readSource(file) {
  const raw = await readFile(file, "utf8");
  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.tasks)) throw new Error(`${file}: expected a handoff with a tasks array.`);
  for (const task of data.tasks) {
    if (typeof task?.id !== "string" || typeof task.updated_at !== "string" ||
        typeof task.goal !== "string" || typeof task.status !== "string") {
      throw new Error(`${file}: a task is missing id, goal, status, or updated_at. Repair it and retry.`);
    }
  }
  return { file, data, hash: createHash("sha256").update(raw).digest("hex") };
}

function validLink(value) {
  try {
    return githubURL(value).href;
  } catch {
    return null;
  }
}

function validPR(value) {
  try {
    return prURL(value);
  } catch {
    return null;
  }
}

function text(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function issueURLOf(old, details, links, project) {
  const named = /^issue-([^.]+)\.(.+)-(\d+)$/.exec(old.id);
  const numbered = /^issue-(\d+)$/.exec(old.id);
  const ref = /^([^/\s]+\/[^#\s]+)#(\d+)$/.exec(details.ref ?? "");
  const guesses = [
    ref && `https://github.com/${ref[1]}/issues/${ref[2]}`,
    numbered && `https://github.com/${text(old.repository) ?? project}/issues/${numbered[1]}`,
    named && `https://github.com/${named[1]}/${named[2]}/issues/${named[3]}`,
  ].map((value) => value && validLink(value)).filter(Boolean);
  const issues = links.filter((href) => href.split("/")[5] === "issues");
  return guesses[0] ?? (issues.length === 1 ? issues[0] : null);
}

function mapTask(role, file, old, project) {
  const pr = validPR(old.pr);
  const links = [...new Set([...(old.links ?? []), ...(old.pr ? [old.pr] : [])].map(validLink).filter(Boolean))];
  const details = old.details && typeof old.details === "object" ? old.details : {};
  const issue = issueURLOf(old, details, links, project);
  if (issue && !links.includes(issue)) links.push(issue);

  let state = "initial";
  if (old.status === "done") state = "resolved";
  else if (old.status === "blocked") state = "blocked";
  else if (pr && issue) state = "implementation";

  const brief = text(old.brief);
  const result = text(old.result);
  const pane = text(details.pane_id);
  const window = text(details.window_id);
  const worker = pane || window || brief || result
    ? {
      status: state === "resolved" ? "closed" : "unknown",
      mode: "continuous",
      session: text(details.session_id),
      pane,
      window,
      name: text(details.session_title),
      brief,
      result,
    }
    : null;
  const worktreePath = text(details.worktree_path) ?? text(details.worktree);

  return {
    id: old.id,
    title: old.goal,
    state,
    updated_at: old.updated_at,
    next_action: state === "initial" || state === "implementation"
      ? `Reconcile this migrated task with its legacy details and any live worker, then continue. Legacy next action: ${text(old.next_action) ?? "none recorded"}`
      : text(old.next_action) ?? "Reconcile this migrated task.",
    issue,
    pr,
    head: null,
    reviewed_head: null,
    links,
    blocker: state === "blocked"
      ? {
        from: pr ? "implementation" : "initial",
        reason: text(old.blocker) ?? "Blocked in the legacy handoff; no reason was recorded.",
        since: old.updated_at,
      }
      : null,
    resolution: state === "resolved"
      ? { outcome: "completed", note: "Migrated from a done legacy task; the outcome was not recorded.", at: old.updated_at }
      : null,
    merge: null,
    workers: worker ? { implementation: worker } : {},
    worktree: worktreePath
      ? { path: worktreePath, created_by_run: details.worktree_created_by_run === true }
      : null,
    history: [{ state, at: old.updated_at, note: `Migrated from the legacy ${role} handoff (status ${old.status}).` }],
    details: { legacy: { role, file, status: old.status, task: old } },
  };
}

function reviewerPatch(reviewers) {
  const byPR = new Map();
  for (const { file, data } of reviewers) {
    for (const old of data.tasks) {
      const pr = validPR(old.pr) ?? validPR(old.url);
      if (pr) byPR.set(pr, { file, old });
    }
  }
  return byPR;
}

function build(project, key, loaded, reviewers) {
  const tasks = [];
  const report = { merged: [], renamed: [], reviewer_attached: 0, reviewer_skipped: 0 };
  for (const { role, source } of loaded) {
    for (const old of source.data.tasks) {
      let task = mapTask(role, source.file, old, project);
      const twins = tasks.flatMap((other, index) =>
        (task.pr && other.pr === task.pr) || (task.issue && other.issue === task.issue)
          ? [{ index, task: other }]
          : []);
      if (twins.length) {
        const group = [...twins.map(({ task: twin }) => twin), task];
        let keep = group[0];
        for (const candidate of group.slice(1)) {
          if (Date.parse(candidate.updated_at) > Date.parse(keep.updated_at)) keep = candidate;
        }
        const drops = group.filter((candidate) => candidate !== keep)
          .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
        for (const drop of drops) {
          keep.links = [...new Set([...keep.links, ...drop.links])];
          keep.workers = { ...drop.workers, ...keep.workers };
          keep.worktree ??= drop.worktree;
          keep.pr ??= drop.pr;
          keep.issue ??= drop.issue;
          keep.details.legacy_merged = [
            ...(keep.details.legacy_merged ?? []),
            drop.details.legacy,
            ...(drop.details.legacy_merged ?? []),
          ];
          report.merged.push({ kept: keep.id, merged: drop.id });
        }
        tasks[twins[0].index] = keep;
        for (const { index } of twins.slice(1).reverse()) tasks.splice(index, 1);
        continue;
      }
      if (tasks.some((other) => other.id === task.id)) {
        let id = `${role}-${task.id}`;
        for (let count = 2; tasks.some((other) => other.id === id); count += 1) id = `${role}-${task.id}-${count}`;
        report.renamed.push({ from: task.id, to: id, role });
        task = { ...task, id };
      }
      tasks.push(task);
    }
  }

  const matched = new Set();
  const byPR = reviewerPatch(reviewers);
  for (const task of tasks) {
    const match = task.pr && byPR.get(task.pr);
    if (!match) continue;
    matched.add(task.pr);
    const reviewed = /^[a-f0-9]{40}$/.test(match.old.lastReviewedHead ?? "") ? match.old.lastReviewedHead : null;
    task.reviewed_head = reviewed;
    task.workers.review = {
      status: "unknown",
      mode: "continuous",
      pane: null,
      window: null,
      name: null,
      session: null,
      brief: text(match.old.brief),
      result: text(match.old.result),
    };
    task.details.legacy_reviewer = { file: match.file, status: match.old.status, task: match.old };
    report.reviewer_attached += 1;
  }
  report.reviewer_skipped = [...byPR.keys()].filter((pr) => !matched.has(pr)).length;

  const statuses = loaded.flatMap(({ source }) => (typeof source.data.status === "string" ? [source.data.status] : []));
  const status = statuses.includes("active") ? "active" : statuses.includes("blocked") ? "blocked" : "paused";
  const data = {
    format,
    id: `${key}-factory`,
    project,
    goal: `Run the factory for ${project}`,
    status,
    updated_at: new Date().toISOString(),
    rex_session: null,
    rules: [],
    limits: defaultLimits,
    tasks,
  };
  validate(data);
  return { data, report };
}

async function main() {
  let options;
  try {
    options = parseArgs({
      options: {
        help: { type: "boolean", short: "h" },
        project: { type: "string" },
        directory: { type: "string", default: join(homedir(), ".local/state/copilot-coordinator") },
        "dry-run": { type: "boolean" },
        archive: { type: "boolean" },
        "ignore-locks": { type: "boolean" },
      },
    }).values;
    if (options.help) {
      console.log(`Migrate legacy coordinator handoffs into one factory.json.

Usage: node migrate.mjs --project owner/repo [--directory PATH] [--dry-run] [--archive]
                        [--ignore-locks]
       bun migrate.mjs --project owner/repo [options]

Reads <owner.repo>-implementer.json and <owner.repo>-coordinator.json and writes
<owner.repo>-factory.json in the state directory (default ~/.local/state/copilot-coordinator).
A <owner.repo>-reviewer.json is read only to attach reviews to migrated tasks with the same
PR; its other tasks (other authors' PRs) are not imported and stay with coordination:review.

Mapping: done becomes resolved (completed); blocked stays blocked; a task with both a PR and
an issue enters implementation; every other open task enters initial for reconciliation.
Tasks that share a PR or issue are merged (the newest is kept, the others are saved under
details.legacy_merged). A repeated ID with different work gets a role prefix. Every original
task is kept under details.legacy.

The command never changes a source unless --archive is given, then it moves the implementer and
coordinator handoffs to archive/<date>-factory-migration/ after checking they did not change.
It refuses to overwrite an existing factory.json, and stops when a legacy owner lock exists
(stop the legacy coordinator and remove its lock first, or pass --ignore-locks).
--dry-run prints the report and writes nothing. Exit: 0 success, 1 failure, 2 usage.`);
      return;
    }
    if (!/^[^/\s]+\/[^/\s]+$/.test(options.project ?? "")) {
      throw new Error("--project owner/repo is required.");
    }
  } catch (error) {
    console.error(`${error.message}\nRun with --help for usage.`);
    process.exitCode = 2;
    return;
  }

  const project = options.project;
  const key = project.replace("/", ".");
  const directory = resolve(options.directory);
  const target = join(directory, `${key}-factory.json`);
  const warnings = [];

  const loaded = [];
  for (const role of sources) {
    const file = join(directory, `${key}-${role}.json`);
    if (await exists(file)) loaded.push({ role, source: await readSource(file) });
  }
  if (!loaded.length) throw new Error(`No ${sources.join(" or ")} handoff found for ${project} in ${directory}.`);
  const reviewerFile = join(directory, `${key}-reviewer.json`);
  const reviewers = (await exists(reviewerFile)) ? [await readSource(reviewerFile)] : [];

  const locks = [];
  for (const { role } of loaded) {
    if (await exists(join(directory, `${key}-${role}.lock`))) locks.push(`${key}-${role}.lock`);
  }
  if (locks.length && !options["ignore-locks"] && !options["dry-run"]) {
    throw new Error(`Legacy owner lock exists: ${locks.join(", ")}. Stop the legacy coordinator and release its lock first.`);
  }
  if (locks.length) warnings.push(`Legacy owner lock exists: ${locks.join(", ")}.`);
  if (await exists(target) && !options["dry-run"]) {
    throw new Error(`${target} already exists. Move it away or reconcile it by hand; this command never overwrites.`);
  }

  const { data, report } = build(project, key, loaded, reviewers);
  const counts = Object.fromEntries(
    ["initial", "investigation", "implementation", "review", "blocked", "resolved"]
      .map((state) => [state, data.tasks.filter((task) => task.state === state).length]));
  const summary = {
    file: target,
    dry_run: Boolean(options["dry-run"]),
    sources: loaded.map(({ role, source }) => ({ role, file: source.file, tasks: source.data.tasks.length })),
    tasks: data.tasks.length,
    by_state: counts,
    ...report,
    warnings,
  };

  if (!options["dry-run"]) {
    for (const source of [...loaded.map((item) => item.source), ...reviewers]) {
      if (createHash("sha256").update(await readFile(source.file)).digest("hex") !== source.hash) {
        throw new Error(`${source.file} changed during migration. Stop its writer and retry.`);
      }
    }
    const archive = join(directory, "archive", `${new Date().toISOString().slice(0, 10)}-factory-migration`);
    const moves = options.archive
      ? loaded.map(({ source }) => [source.file, join(archive, basename(source.file))])
      : [];
    for (const [, destination] of moves) {
      if (await exists(destination)) throw new Error(`${destination} already exists; archive by hand.`);
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    try {
      await link(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    if (options.archive) {
      await mkdir(archive, { recursive: true });
      for (const [from, to] of moves) await rename(from, to);
      summary.archived = moves.map(([, to]) => to);
    }
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
