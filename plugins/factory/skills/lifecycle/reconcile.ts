import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { lastEvent, resolveAttention, sameId } from "./attention.ts";
import { eventsFile, readEvents, resolveFactory, waiterPid } from "./broker.ts";
import { intervalMs, keepFirst, mergeRefusal, resourceId, sharesWork, type Factory, type Task, type Worker } from "./factory-data.ts";
import { defaultBranch } from "./default-branch.ts";
import { hooksInactive } from "./gate.ts";
import { scanProposals } from "./proposals.ts";
import { readJSON } from "./state-dir.ts";
import { causeTaskValues, detectStops, recordStop, scanStops, type QuietWorker } from "./stops.ts";

const usage = "Usage: node factory.mjs reconcile FACTORY_FILE [--default-branch NAME] [--blocked-after 24h] [--attention-after 30m]";

type Finding = Record<string, unknown>;
type Live = { sessionGone: boolean; windows: string[] };

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
}).trim();

function isAncestor(cwd: string, branch: string) {
  try {
    git(cwd, "merge-base", "--is-ancestor", "HEAD", branch);
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

const factoryScript = join(dirname(fileURLToPath(import.meta.url)), "factory.mjs");

const closes = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s*:?\s+#(\d+)/gi;

// The issue URLs a PR closes, from GitHub. Without gh, or when it fails, the PR closes none.
async function closedIssues(pr: string): Promise<string[]> {
  try {
    const { stdout } = await promisify(execFile)("gh", ["pr", "view", pr, "--json", "closingIssuesReferences,body"], { timeout: 10_000 });
    const { closingIssuesReferences, body } = JSON.parse(stdout);
    const repo = pr.replace(/\/pull\/\d+.*$/, "");
    return [
      ...closingIssuesReferences.map((issue: { url: string }) => issue.url),
      ...[...body.matchAll(closes)].map(([, number]) => `${repo}/issues/${number}`),
    ];
  } catch {
    return [];
  }
}

// Tasks that hold one piece of work, as groups: the task to keep, the ones to merge into it, and the command.
async function duplicateTasks(file: string, tasks: Task[]) {
  const candidates = tasks.filter((task) => !mergeRefusal(task));
  const pairs: Task[][] = candidates.flatMap((a, i) => candidates.slice(i + 1).filter((b) => sharesWork(a, b)).map((b) => [a, b]));
  // Only a PR task that no link already explains needs GitHub's word on the issues it closes.
  const open = candidates.filter((task) => task.state !== "resolved" && task.pr && !pairs.some((pair) => pair.includes(task)));
  const closed = await Promise.all(open.map((task) => closedIssues(task.pr as string)));
  open.forEach((task, i) => {
    for (const url of closed[i].filter(resourceId)) {
      for (const other of candidates.filter((item) => item !== task && sharesWork({ issue: url, links: [] }, item))) {
        pairs.push([task, other]);
      }
    }
  });

  const groups: Set<Task>[] = [];
  for (const pair of pairs) {
    const touched = groups.filter((group) => pair.some((task) => group.has(task)));
    const joined = new Set([...pair, ...touched.flatMap((group) => [...group])]);
    groups.splice(0, groups.length, ...groups.filter((group) => !touched.includes(group)), joined);
  }
  return groups.map((group) => {
    const [keep, ...rest] = [...group].sort(keepFirst);
    return {
      kind: "duplicate-task",
      keep: keep.id,
      merge: rest.map((task) => task.id),
      command: rest.map((task) => `node ${factoryScript} write ${file} --merge-task ${keep.id} --from ${task.id}`).join(" && "),
    };
  });
}

// Reading must never start a Rex server.
const rexJSON = (...args: string[]) => JSON.parse(execFileSync("rex", ["--autostart=false", ...args, "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 10_000,
}));

// A gone session makes `rex window ls` fail, so ask for the session list first.
function liveState(session: string): Live {
  const sessions: string[] = rexJSON("ls").sessions.map((s: { session_id: string }) => s.session_id);
  if (!sessions.some((id) => sameId(id, session))) return { sessionGone: true, windows: [] };
  return { sessionGone: false, windows: rexJSON("window", "ls", "-s", session).windows.map((w: { window_id: string }) => w.window_id) };
}

const quietAfter = intervalMs("10m");

// Idle minutes of a running worker that ended its turn without a new result, else null.
async function quietMinutes(worker: Worker | null | undefined, resultTime: number | null) {
  if (worker?.status !== "running" || !worker.session) return null;
  if (resultTime !== null && resultTime > (Date.parse(worker.launched_at ?? "") || 0)) return null;
  const event = await lastEvent(worker.session);
  if (event?.type !== "assistant.turn_end" || !(Date.now() - event.at > quietAfter)) return null;
  return Math.floor((Date.now() - event.at) / 60_000);
}

async function reconcile(file: string, branchOverride?: string, blockedAfter = intervalMs("24h"), attentionAfter = intervalMs("30m")) {
  const factory: Factory = JSON.parse(await readFile(file, "utf8"));
  const directory = dirname(file);
  const findings: Finding[] = [];
  const errors: string[] = [];
  const open = factory.tasks.filter((task) => task.state !== "resolved");
  const quiet: QuietWorker[] = [];

  // Only a finished run with no open task may sit without a waiter.
  if ((factory.status === "active" || open.length > 0) && await waiterPid(await resolveFactory(file)) === null) {
    findings.push({ kind: "no-waiter", status: factory.status ?? null, open: open.length });
  }

  const inactive = hooksInactive(file);
  if (inactive) findings.push({ kind: "hooks-inactive", reason: inactive });

  findings.push(...await duplicateTasks(file, factory.tasks));

  // One Rex read per sweep, and only when a check needs it. After a Rex failure, null.
  let live: Live | null | undefined;
  const rex = () => {
    if (live === undefined) {
      try {
        live = factory.rex_session ? liveState(factory.rex_session) : null;
      } catch (error) {
        errors.push(`rex: ${(error as Error).message.split("\n")[0]}`);
        live = null;
      }
    }
    return live;
  };
  const openWindows = () => rex()?.windows ?? [];
  const missing: Finding[] = [];
  const checkMissing = (worker: Worker | null | undefined, finding: Finding) => {
    if (worker?.status !== "running" || !rex()) return;
    const window = worker.window;
    if (!window || !openWindows().some((id) => sameId(id, window))) {
      missing.push({
        ...finding,
        window: worker.window ?? null,
        pane: worker.pane ?? null,
        brief: worker.brief ?? null,
        result: worker.result ?? null,
      });
    }
  };

  for (const task of open) {
    for (const [role, worker] of Object.entries(task.workers ?? {})) {
      const result = worker?.result ? await readJSON(join(directory, worker.result)) : null;
      if (result?.outcome === "complete" && Date.parse(result.updated_at) > Date.parse(task.updated_at)) {
        findings.push({
          kind: "unprocessed-result",
          task: task.id,
          state: task.state,
          role,
          result: worker?.result,
          head: result.head ?? null,
        });
      } else {
        checkMissing(worker, { kind: "worker-missing", task: task.id, role, worktree: task.worktree?.path ?? null });
      }

      const resultFile = worker?.result ? join(directory, worker.result) : null;
      const resultTime = resultFile ? await stat(resultFile).then(({ mtimeMs }) => mtimeMs, () => null) : null;
      const idle = await quietMinutes(worker, resultTime);
      if (idle !== null) {
        findings.push({ kind: "worker-quiet", task: task.id, role, idle_minutes: idle });
        quiet.push({ task: task.id, role, minutes: idle });
      }
    }

    const blocked = task.state === "blocked" ? task.blocker : null;
    if (blocked && Date.now() - Date.parse(blocked.since) > blockedAfter) {
      findings.push({
        kind: "stale-blocked",
        task: task.id,
        class: blocked.class ?? null,
        owner: blocked.owner ?? null,
        since: blocked.since,
        reason: blocked.reason,
      });
    }

    // Tasks with an issue or PR land on GitHub; only local-merge tasks can be left behind.
    if (!task.worktree?.path || task.issue || task.pr) continue;
    try {
      const ahead = Number(git(task.worktree.path, "rev-list", "--count", `${defaultBranch(task.worktree.path, branchOverride) ?? "main"}..HEAD`));
      if (ahead > 0) {
        findings.push({
          kind: "branch-ahead",
          task: task.id,
          state: task.state,
          branch: git(task.worktree.path, "rev-parse", "--abbrev-ref", "HEAD"),
          ahead,
        });
      }
    } catch {
      errors.push(`${task.id}: cannot read worktree ${task.worktree.path}.`);
    }
  }

  const resolved = factory.tasks.filter((task) => task.state === "resolved");
  for (const task of resolved) {
    const worktree = task.worktree;
    if (task.resolution?.outcome !== "merged" || !worktree?.path || !existsSync(worktree.path)) continue;
    try {
      // A squash-merged PR branch is never in the default branch; `factory.mjs worktree` verifies the PR with gh.
      if (git(worktree.path, "status", "--porcelain") !== "" || !(task.pr || isAncestor(worktree.path, defaultBranch(worktree.path, branchOverride) ?? "main"))) continue;
      const finding: Finding = {
        kind: "merged-worktree",
        task: task.id,
        path: worktree.path,
        created_by_run: worktree.created_by_run,
      };
      if (task.pr) {
        const branch = git(worktree.path, "rev-parse", "--abbrev-ref", "HEAD");
        finding.command = `node ${factoryScript} worktree delete ${branch} --merged-pr ${task.pr}`;
      }
      findings.push(finding);
    } catch {
      errors.push(`${task.id}: cannot read worktree ${worktree.path}.`);
    }
  }

  // Resolving a task closes its workers; a running record left behind counts against the budget.
  for (const task of resolved) {
    for (const [role, worker] of Object.entries(task.workers ?? {})) {
      if (worker?.status !== "running") continue;
      findings.push({
        kind: "stale-running",
        task: task.id,
        role,
        window: worker.window ?? null,
        fix: `node ${factoryScript} write ${file} --task ${task.id} --workers '${JSON.stringify({ [role]: { status: "closed" } })}'`,
      });
    }
  }

  if (resolved.some((task) => Object.values(task.workers ?? {}).some((w) => w?.window))) {
    for (const task of resolved) {
      for (const [role, worker] of Object.entries(task.workers ?? {})) {
        const window = openWindows().find((id) => worker?.window && sameId(id, worker.window));
        if (window) findings.push({ kind: "open-window", task: task.id, role, window });
      }
    }
  }

  // A rule worker is finished when its result is complete and newer than the rule's last run stamp.
  for (const rule of factory.rules ?? []) {
    const worker = rule.worker;
    const file = worker?.result ? join(directory, worker.result) : null;
    const result = file ? await readJSON(file) : null;
    const at = result && (Date.parse(result.updated_at) || (await stat(file as string)).mtimeMs);
    const finished = result?.outcome === "complete" && (!rule.last_run_at || at > Date.parse(rule.last_run_at));
    if (!finished) {
      checkMissing(worker, { kind: "worker-missing", rule: rule.id, role: "rule", worktree: null });
      continue;
    }
    const windowId = worker?.window;
    const window = windowId ? openWindows().find((id) => sameId(id, windowId)) : undefined;
    if (window || worker?.status === "running") {
      findings.push({ kind: "rule-worker-done", rule: rule.id, window: window ?? null, result: worker?.result });
    }
  }

  // A prompt waits for the user, so only the user can clear it. Report it; never answer it.
  try {
    const { open: waiting } = await resolveAttention(file, { source: "reconcile" });
    for (const item of waiting) {
      if (Date.now() - Date.parse(item.at) <= attentionAfter) continue;
      findings.push({
        kind: "attention-stale",
        task: item.task,
        title: item.title,
        role: item.role,
        attention: item.kind,
        text: item.text,
        pane: item.pane,
        since: item.at,
      });
    }
  } catch (error) {
    errors.push(`attention: ${(error as Error).message.split("\n")[0]}`);
  }

  // A proposal waits for the user for as long as it takes, so an undecided one is never stuck work.
  // A decision the coordinator has not recorded in the result file is: the wake may have been lost.
  // Only the newest proposal of a result file counts, as the next run overwrites that file; and a
  // result with no change has nothing to apply.
  try {
    const { open: proposed, decided } = await scanProposals(await resolveFactory(file));
    const newest = (proposal: (typeof decided)[number]) => ![...proposed, ...decided].some(({ result, at }) =>
      result === proposal.result && Date.parse(at) > Date.parse(proposal.at));
    for (const proposal of decided.filter(newest)) {
      const result = await readJSON(join(directory, proposal.result as string));
      if (!result?.change || result.decision) continue;
      findings.push({
        kind: "improve-decided-unapplied",
        rule: proposal.rule,
        proposal_id: proposal.id,
        change: proposal.kind,
        title: proposal.title,
        decision: proposal.decision,
        decided_at: proposal.decided_at,
        result: proposal.result,
      });
    }
  } catch (error) {
    errors.push(`improve: ${(error as Error).message.split("\n")[0]}`);
  }

  // Record each new stop once. A stop stays a finding until a cause task holds its stop_id or the stop is dismissed.
  try {
    const log = await resolveFactory(file);
    for (const stop of detectStops(factory, (await readEvents(eventsFile(log), 0)).events, quiet)) await recordStop(log, stop);
    for (const stop of (await scanStops(log, factory)).filter(({ cause_task }) => cause_task === null)) {
      const values = causeTaskValues(stop);
      findings.push({
        kind: "stop",
        stop_id: stop.stop_id,
        cause: stop.cause,
        class: stop.class,
        task: stop.task,
        role: stop.role,
        detail: stop.detail,
        command: `node ${factoryScript} write ${file} --task ${values.task} --title '${values.title}' --issue ${values.issue} --next-action '${values["next-action"]}' --details '${values.details}'`,
      });
    }
  } catch (error) {
    errors.push(`stops: ${(error as Error).message.split("\n")[0]}`);
  }

  if (missing.length > 0 && rex()?.sessionGone) {
    findings.push({ kind: "rex-session-missing", session: factory.rex_session, workers: missing.length });
  }
  findings.push(...missing);

  return { findings, errors };
}

export async function main(argv: string[]) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "default-branch": { type: "string" },
        "blocked-after": { type: "string", default: "24h" },
        "attention-after": { type: "string", default: "30m" },
      },
    });
    if (positionals.length !== 1) throw new Error(usage);
    const duration = (flag: "blocked-after" | "attention-after") => {
      try {
        return intervalMs(values[flag]);
      } catch {
        throw new Error(`--${flag} must look like 30m, 24h, or 2d, not ${JSON.stringify(values[flag])}.`);
      }
    };
    console.log(JSON.stringify(await reconcile(positionals[0], values["default-branch"], duration("blocked-after"), duration("attention-after")), null, 2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
