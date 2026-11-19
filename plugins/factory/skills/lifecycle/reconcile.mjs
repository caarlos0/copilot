import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveFactory, waiterPid } from "./broker.mjs";
import { intervalMs } from "./factory-data.mjs";
import { hooksInactive } from "./gate.mjs";

const usage = "Usage: node reconcile.mjs FACTORY_FILE [--default-branch NAME] [--blocked-after 24h]";

async function readJSON(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
}).trim();

function isAncestor(cwd, branch) {
  try {
    git(cwd, "merge-base", "--is-ancestor", "HEAD", branch);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

const worktreeScript = join(dirname(fileURLToPath(import.meta.url)), "worktree.mjs");

const rexJSON = (...args) => JSON.parse(execFileSync("rex", [...args, "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}));

// A gone session makes `rex window ls` fail, so ask for the session list first.
function liveState(session) {
  const sessions = rexJSON("ls").sessions.map((s) => s.session_id);
  if (!sessions.some((id) => sameId(id, session))) return { sessionGone: true, windows: [] };
  return { sessionGone: false, windows: rexJSON("window", "ls", "-s", session).windows.map((w) => w.window_id) };
}

// Rex may record short IDs; a short ID is the tail of the full one.
const bare = (id) => id.replace(/^\w+:/, "");
const sameId = (a, b) => bare(a).endsWith(bare(b)) || bare(b).endsWith(bare(a));

async function reconcile(file, defaultBranch = "main", blockedAfter = intervalMs("24h")) {
  const factory = JSON.parse(await readFile(file, "utf8"));
  const directory = dirname(file);
  const findings = [];
  const errors = [];
  const open = factory.tasks.filter((task) => task.state !== "resolved");

  // Only a finished run with no open task may sit without a waiter.
  if ((factory.status === "active" || open.length > 0) && await waiterPid(await resolveFactory(file)) === null) {
    findings.push({ kind: "no-waiter", status: factory.status ?? null, open: open.length });
  }

  const inactive = hooksInactive(file);
  if (inactive) findings.push({ kind: "hooks-inactive", reason: inactive });

  // One Rex read per sweep, and only when a check needs it. After a Rex failure, null.
  let live;
  const rex = () => {
    if (live === undefined) {
      try {
        live = factory.rex_session ? liveState(factory.rex_session) : null;
      } catch (error) {
        errors.push(`rex: ${error.message.split("\n")[0]}`);
        live = null;
      }
    }
    return live;
  };
  const openWindows = () => rex()?.windows ?? [];
  const missing = [];
  const checkMissing = (worker, finding) => {
    if (worker?.status !== "running" || !rex()) return;
    if (!worker.window || !openWindows().some((id) => sameId(id, worker.window))) {
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
          result: worker.result,
          head: result.head ?? null,
        });
      } else {
        checkMissing(worker, { kind: "worker-missing", task: task.id, role, worktree: task.worktree?.path ?? null });
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
      const ahead = Number(git(task.worktree.path, "rev-list", "--count", `${defaultBranch}..HEAD`));
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
      // A squash-merged PR branch is never in the default branch; `worktree.mjs` verifies the PR with gh.
      if (git(worktree.path, "status", "--porcelain") !== "" || !(task.pr || isAncestor(worktree.path, defaultBranch))) continue;
      const finding = {
        kind: "merged-worktree",
        task: task.id,
        path: worktree.path,
        created_by_run: worktree.created_by_run,
      };
      if (task.pr) {
        const branch = git(worktree.path, "rev-parse", "--abbrev-ref", "HEAD");
        finding.command = `node ${worktreeScript} delete ${branch} --merged-pr ${task.pr}`;
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
        fix: `node ${join(import.meta.dirname, "factory.mjs")} ${file} --task ${task.id} --workers '${JSON.stringify({ [role]: { status: "closed" } })}'`,
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
    const at = result && (Date.parse(result.updated_at) || (await stat(file)).mtimeMs);
    const finished = result?.outcome === "complete" && (!rule.last_run_at || at > Date.parse(rule.last_run_at));
    if (!finished) {
      checkMissing(worker, { kind: "worker-missing", rule: rule.id, role: "rule", worktree: null });
      continue;
    }
    const window = worker.window ? openWindows().find((id) => sameId(id, worker.window)) : undefined;
    if (window || worker.status === "running") {
      findings.push({ kind: "rule-worker-done", rule: rule.id, window: window ?? null, result: worker.result });
    }
  }

  if (missing.length > 0 && rex()?.sessionGone) {
    findings.push({ kind: "rex-session-missing", session: factory.rex_session, workers: missing.length });
  }
  findings.push(...missing);

  return { findings, errors };
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "default-branch": { type: "string", default: "main" },
      "blocked-after": { type: "string", default: "24h" },
    },
  });
  if (positionals.length !== 1) throw new Error(usage);
  let blockedAfter;
  try {
    blockedAfter = intervalMs(values["blocked-after"]);
  } catch {
    throw new Error(`--blocked-after must look like 30m, 24h, or 2d, not ${JSON.stringify(values["blocked-after"])}.`);
  }
  console.log(JSON.stringify(await reconcile(positionals[0], values["default-branch"], blockedAfter), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
