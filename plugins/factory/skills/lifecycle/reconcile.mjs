import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const usage = "Usage: node reconcile.mjs FACTORY_FILE [--default-branch NAME]";

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

function liveWindows(session) {
  const out = execFileSync("rex", ["window", "ls", "-s", session, "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out).windows.map((window) => window.window_id);
}

// Rex may record short IDs; a short ID is the tail of the full one.
const bare = (id) => id.replace(/^window:/, "");
const sameWindow = (a, b) => bare(a).endsWith(bare(b)) || bare(b).endsWith(bare(a));

async function reconcile(file, defaultBranch = "main") {
  const factory = JSON.parse(await readFile(file, "utf8"));
  const directory = dirname(file);
  const findings = [];
  const errors = [];
  const open = factory.tasks.filter((task) => task.state !== "resolved");

  for (const task of open) {
    for (const [role, worker] of Object.entries(task.workers ?? {})) {
      if (!worker?.result) continue;
      const result = await readJSON(join(directory, worker.result));
      if (result?.outcome === "complete" && Date.parse(result.updated_at) > Date.parse(task.updated_at)) {
        findings.push({
          kind: "unprocessed-result",
          task: task.id,
          state: task.state,
          role,
          result: worker.result,
          head: result.head ?? null,
        });
      }
    }

    if (!task.worktree?.path) continue;
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
    } catch (error) {
      errors.push(`${task.id}: cannot read worktree ${task.worktree.path}.`);
    }
  }

  const resolved = factory.tasks.filter((task) => task.state === "resolved");
  if (factory.rex_session && resolved.some((task) => Object.values(task.workers ?? {}).some((w) => w?.window))) {
    try {
      const windows = liveWindows(factory.rex_session);
      for (const task of resolved) {
        for (const [role, worker] of Object.entries(task.workers ?? {})) {
          const window = windows.find((id) => worker?.window && sameWindow(id, worker.window));
          if (window) findings.push({ kind: "open-window", task: task.id, role, window });
        }
      }
    } catch (error) {
      errors.push(`rex: ${error.message.split("\n")[0]}`);
    }
  }

  return { findings, errors };
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "default-branch": { type: "string", default: "main" } },
  });
  if (positionals.length !== 1) throw new Error(usage);
  console.log(JSON.stringify(await reconcile(positionals[0], values["default-branch"]), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
