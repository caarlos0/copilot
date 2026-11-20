import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { report as sessionReport } from "../../plugins/factory/skills/lifecycle/session-metrics.mjs";
import { prepare, scratchPaths } from "./prepare.mjs";
import type { Paths } from "./prepare.ts";
import { checkProtocol, detectContamination, loadTasks, repoRoot, scoreImplementation, scoreInvestigation } from "./score.mjs";
import type { Json, Task, Tasks } from "./score.ts";

type Run = { model: string; task: Task; rep: number };

type Options = {
  models: string[];
  taskIds: string[];
  reps: number;
  seed: number;
  maxAic?: number;
  wallMinutes?: number;
  effort: string;
  dryRun: boolean;
  keepScratch: boolean;
  out: string;
  repo: string;
};

type Context = Options & { tasks: Tasks; batch: string; scratchRoot: string; sessionDir: string };
type Item = ReturnType<typeof plan>;

// The worker deny flags from "Launch rules" in plugins/factory/skills/lifecycle/SKILL.md.
export const denyPatterns = ["git stash", ...["window", "block", "session", "new", "run", "split", "send", "send-key", "kill", "do", "api", "focus", "zoom", "move", "swap", "resize"].map((name) => `rex ${name}:*`)];

// The child must not look like a Rex pane or a factory worker.
export const unsetVariables = ["REX_SERVER", "REX_SESSION", "REX_BLOCK", "FACTORY_TASK", "FACTORY_ROLE", "FACTORY_FILE", "FACTORY_COORDINATOR"];

const editTools = ["edit", "create", "apply_patch"];
const infraPattern = /quota|rate.?limit|\b429\b|overloaded|ECONNRESET|ENOTFOUND|not available|unknown model|invalid model|model .*not (?:found|supported)/i;

export const defaultOut = () => process.env.BENCH_OUT ?? join(homedir(), ".local/state/copilot-coordinator/bench");

export function shellQuote(arg: string) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

// A small seeded generator keeps the run order random but repeatable.
export function shuffle<T>(list: T[], seed: number) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const result = [...list];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

// Every (model, task, rep) in one shuffled list, so repeats interleave across models.
export function buildRuns({ models, tasks, reps, seed }: { models: string[]; tasks: Task[]; reps: number; seed: number }) {
  const runs: Run[] = models.flatMap((model) => tasks.flatMap((task) => Array.from({ length: reps }, (_, index) => ({ model, task, rep: index + 1 }))));
  return shuffle(runs, seed);
}

type CopilotArguments = {
  model: string;
  effort: string;
  agent: string;
  aic: number;
  paths: Paths;
  logs: string;
  usage: string;
  transcript: string;
};

export function copilotArguments({ model, effort, agent, aic, paths, logs, usage, transcript }: CopilotArguments) {
  return [
    "--agent", agent, "--model", model, "--reasoning-effort", effort, "--yolo", "--sandbox",
    ...denyPatterns.map((pattern) => `--deny-tool=shell(${pattern})`),
    "--no-ask-user", "--max-ai-credits", String(aic), "--log-dir", logs, "--usage-output-file", usage,
    "--output-format", "json", "--share", transcript, "-p", `Read ${paths.brief} and do it.`,
  ];
}

export function plan(run: Run, context: Context & { number: number }) {
  const { task, model, rep } = run;
  const id = `${model}__${task.id}__r${rep}`;
  const dir = join(context.out, context.batch, id);
  const paths = scratchPaths(join(context.scratchRoot, `bench-${context.batch}-${context.number}`), task, context.tasks.tools_path);
  const cap = {
    aic: context.maxAic ?? context.tasks.caps[task.role].max_ai_credits,
    wallMinutes: context.wallMinutes ?? context.tasks.caps[task.role].wall_minutes,
  };
  const files = { dir, logs: join(dir, "logs"), usage: join(dir, "usage.json"), transcript: join(dir, "transcript.md") };
  const argv = copilotArguments({ model, effort: context.effort, agent: context.tasks.defaults.agent, aic: cap.aic, paths, ...files });
  return { id, run, paths, cap, files, argv };
}

export function describe(item: Item, context: Context) {
  const { task } = item.run;
  const ref = (task.base ?? task.export_at)!.slice(0, 7);
  const env = unsetVariables.map((name) => `-u ${name}`).join(" ");
  return [
    `# ${item.id}  (cap ${item.cap.aic} AIC, ${item.cap.wallMinutes} min)`,
    `  scratch  ${item.paths.scratch}`,
    `  output   ${item.files.dir}`,
    `  1. git archive ${ref} | tar -x -C ${item.paths.work}; git init; one commit; tag bench-base${task.role === "implementation" ? `; branch ${item.paths.branch}` : ""}`,
    `  2. git archive ${context.tasks.tools_ref.slice(0, 7)} ${context.tasks.tools_path} | tar -x -C ${item.paths.scratch}/tools (read-only)`,
    `  3. factory.mjs ${item.paths.factory}: task bench-${task.id.toLowerCase()} in ${task.role}`,
    `  4. write ${item.paths.brief}`,
    `  5. cd ${item.paths.work} && env ${env} copilot ${item.argv.map(shellQuote).join(" ")}`,
    `  6. then: find the session by cwd, score, append to ${join(context.out, "ledger.jsonl")}, remove the scratch`,
  ].join("\n").replaceAll(context.scratchRoot, "$TMPDIR");
}

export function readEvents(file: string): Json[] {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

const readJSON = (file: string) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

// 1e9 nano AIU is one AI credit.
export function extractUsage(usage: any, model: string) {
  if (typeof usage?.totalNanoAiu !== "number") return null;
  const names = (metrics: any): string[] => (Array.isArray(metrics) ? metrics.map((item) => item.model ?? item.name) : Object.keys(metrics ?? {})).filter(Boolean);
  const models = names(usage.modelMetrics);
  return {
    aic: usage.totalNanoAiu / 1e9,
    premium_requests: usage.totalPremiumRequestCost ?? null,
    models,
    agents: names(usage.agentMetrics),
    mixed_model: models.some((name) => name !== model),
  };
}

// The session whose cwd is the unique scratch worktree, newest first.
export function findSession(directory: string, cwd: string, sinceMs: number) {
  const found: { id: string; mtimeMs: number }[] = [];
  for (const name of readdirSync(directory)) {
    const file = join(directory, name, "workspace.yaml");
    try {
      const { mtimeMs } = statSync(file);
      if (mtimeMs < sinceMs) continue;
      const value = readFileSync(file, "utf8").match(/^cwd:\s*(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, "");
      if (value && realpathSync(value) === cwd) found.push({ id: name, mtimeMs });
    } catch {
      continue;
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map(({ id }) => id);
}

export function toolStats(tools: Record<string, { calls?: number; failures?: number }>) {
  const sum = (names: string[], key: "calls" | "failures") => names.reduce((total, name) => total + (tools[name]?.[key] ?? 0), 0);
  const all = Object.keys(tools);
  return {
    tool_calls: sum(all, "calls"), tool_failures: sum(all, "failures"),
    edit_calls: sum(editTools, "calls"), edit_failures: sum(editTools, "failures"),
  };
}

export const isInfra = ({ exitCode, timedOut, hasResult, text }: { exitCode: number | null; timedOut: boolean; hasResult: boolean; text: string }) =>
  exitCode !== 0 && !timedOut && !hasResult && infraPattern.test(text);

const tail = (file: string) => {
  try {
    return readFileSync(file, "utf8").slice(-4000);
  } catch {
    return "";
  }
};

let current: ChildProcess | null = null;

function launch(item: Item, context: Context) {
  const { paths, files, cap } = item;
  const env = { ...process.env };
  for (const name of unsetVariables) delete env[name];
  return new Promise<Json>((done) => {
    const out = openSync(join(files.dir, "stdout.jsonl"), "w");
    const err = openSync(join(files.dir, "stderr.txt"), "w");
    const started = Date.now();
    const child = spawn("copilot", item.argv, { cwd: paths.work, env, stdio: ["ignore", out, err], detached: true });
    current = child;
    const stop = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        // The group is already gone.
      }
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
      setTimeout(() => stop("SIGKILL"), context.tasks.defaults.kill_grace_seconds * 1000).unref();
    }, cap.wallMinutes * 60_000);
    const finish = (extra: Json) => {
      clearTimeout(timer);
      closeSync(out);
      closeSync(err);
      current = null;
      done({ timed_out: timedOut, wall_seconds: Math.round((Date.now() - started) / 100) / 10, ...extra });
    };
    child.on("error", (error) => finish({ exit_code: null, spawn_error: error.message }));
    child.on("exit", (code, signal) => finish({ exit_code: code, signal }));
  });
}

function sessionDetails(sessionDir: string, id: string) {
  const events = readEvents(join(sessionDir, id, "events.jsonl"));
  const start = events.find((event) => event.type === "session.start")?.data ?? {};
  return {
    events,
    copilot_version: start.copilotVersion ?? null,
    session_model: start.selectedModel ?? null,
    session_effort: start.reasoningEffort ?? null,
  };
}

async function measureSession(item: Item, context: Context, since: number) {
  const [id] = findSession(context.sessionDir, realpathSync(item.paths.work), since);
  if (!id) return { session_id: null, events: [] };
  const { events, ...details } = sessionDetails(context.sessionDir, id);
  const metrics = (await sessionReport([{ id }], context.sessionDir)).sessions[0];
  return { session_id: id, events, ...details, session_wall_minutes: metrics?.wall_minutes ?? null, ...toolStats(metrics?.tools ?? {}) };
}

function scoreRun(item: Item, context: Context, events: Json[]) {
  const { task } = item.run;
  const resultTime = existsSync(item.paths.result) ? statSync(item.paths.result).mtimeMs : 0;
  const result = readJSON(item.paths.result);
  const protocol = checkProtocol(task, result, readEvents(item.paths.events), resultTime);
  const outcome = task.role === "implementation"
    ? scoreImplementation(task, { repo: context.repo, work: item.paths.work })
    : scoreInvestigation(task, result);
  const contamination = detectContamination(events, task, { extra: [context.repo] });
  return { ...outcome, protocol, contamination, has_result: result !== null };
}

function saveArtifacts(item: Item) {
  for (const [from, name] of [[item.paths.result, "result.json"], [item.paths.events, "events.jsonl"]]) {
    if (existsSync(from)) copyFileSync(from, join(item.files.dir, name));
  }
}

async function collect(item: Item, context: Context, launched: Json, since: number) {
  const { task, model, rep } = item.run;
  const session = await measureSession(item, context, since);
  const usage = extractUsage(readJSON(item.files.usage), model);
  const text = `${tail(join(item.files.dir, "stderr.txt"))}\n${tail(join(item.files.dir, "stdout.jsonl"))}`;
  const infra = Boolean(launched.spawn_error) || isInfra({ exitCode: launched.exit_code, timedOut: launched.timed_out, hasResult: existsSync(item.paths.result), text });
  const { events, ...fields } = session;
  const score = infra ? null : scoreRun(item, context, events);
  return {
    batch: context.batch, run_id: item.id, model, task: task.id, role: task.role, rep,
    effort: context.effort, cap_aic: item.cap.aic, ...launched, ...fields,
    usage_missing: usage === null, aic: usage?.aic ?? null, models: usage?.models ?? [], agents: usage?.agents ?? [], mixed_model: usage?.mixed_model ?? false,
    infra, excluded: score?.contamination.length ? "contamination" : infra ? "infra" : null, score,
  };
}

async function executeRun(item: Item, context: Context) {
  const since = Date.now() - 60_000;
  mkdirSync(item.files.logs, { recursive: true });
  try {
    prepare(item.run.task, { repo: context.repo, toolsRef: context.tasks.tools_ref, toolsPath: context.tasks.tools_path, paths: item.paths });
    const launched = await launch(item, context);
    const record = await collect(item, context, launched, since);
    saveArtifacts(item);
    writeFileSync(join(item.files.dir, "record.json"), `${JSON.stringify(record, null, 2)}\n`);
    appendFileSync(join(context.out, "ledger.jsonl"), `${JSON.stringify(record)}\n`);
    return record;
  } finally {
    if (!context.keepScratch) rmSync(item.paths.scratch, { recursive: true, force: true });
  }
}

const summary = (record: Json) => {
  const state = record.excluded ?? (record.score?.pass ? "pass" : "fail");
  return `${state.padEnd(13)} ${record.run_id}  ${record.aic === null ? "n/a" : record.aic.toFixed(1)} AIC  ${record.wall_seconds}s  protocol ${record.score?.protocol.ok ? "ok" : "no"}`;
};

const usageText = `Run the model benchmark: one headless worker per (model, task, rep).

Usage: node run.mjs --models a,b,c [--tasks ID,...] [--reps N] [--dry-run]
       [--effort LEVEL] [--max-aic N] [--wall-min N] [--seed N] [--out DIR] [--keep-scratch]

--models        comma-separated model names (default: the baseline model)
--tasks         task IDs from tasks.json (default: all)
--reps          repeats per model and task (default 1)
--dry-run       print what would run; write nothing
--effort        reasoning effort for every model (default from tasks.json)
--max-aic       per-run AI-credit cap (min 30; default from tasks.json, by role)
--wall-min      per-run wall cap in minutes (default from tasks.json, by role)
--seed          shuffle seed (default 1)
--out           output directory (default $BENCH_OUT, else ~/.local/state/copilot-coordinator/bench)
--keep-scratch  keep the scratch directory for debugging
Exit: 0 success, 2 usage.`;

export function parseOptions(argv: string[], tasks: Tasks): Options | { help: true } {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" }, models: { type: "string" }, tasks: { type: "string" }, reps: { type: "string", default: "1" },
      "dry-run": { type: "boolean" }, effort: { type: "string" }, "max-aic": { type: "string" }, "wall-min": { type: "string" },
      seed: { type: "string", default: "1" }, out: { type: "string" }, "keep-scratch": { type: "boolean" }, repo: { type: "string" },
    },
  });
  if (values.help) return { help: true };
  const models = (values.models ?? tasks.defaults.baseline).split(",").map((name) => name.trim()).filter(Boolean);
  if (!models.length || models.some((name) => !/^[a-z0-9][a-z0-9.-]*$/.test(name))) throw new Error("--models needs model names like claude-sonnet-5.5.");
  const ids = values.tasks === undefined ? tasks.tasks.map(({ id }) => id) : values.tasks.split(",").map((id) => id.trim());
  const unknown = ids.filter((id) => !tasks.tasks.some((task) => task.id === id));
  if (unknown.length) throw new Error(`Unknown task: ${unknown.join(", ")}. Known: ${tasks.tasks.map(({ id }) => id).join(", ")}.`);
  const number = (name: "reps" | "seed" | "max-aic" | "wall-min", minimum: number) => {
    const value = values[name] === undefined ? undefined : Number(values[name]);
    if (value !== undefined && !(Number.isInteger(value) && value >= minimum)) throw new Error(`--${name} must be an integer of at least ${minimum}.`);
    return value;
  };
  return {
    models, taskIds: ids, reps: number("reps", 1)!, seed: number("seed", 0)!, maxAic: number("max-aic", 30), wallMinutes: number("wall-min", 1),
    effort: values.effort ?? tasks.defaults.reasoning_effort, dryRun: Boolean(values["dry-run"]), keepScratch: Boolean(values["keep-scratch"]),
    out: resolve(values.out ?? defaultOut()), repo: resolve(values.repo ?? repoRoot),
  };
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");

async function main() {
  const tasks: Tasks = loadTasks();
  let options: Options | { help: true };
  try {
    options = parseOptions(process.argv.slice(2), tasks);
  } catch (error) {
    console.error(`${(error as Error).message}\nRun with --help for usage.`);
    process.exitCode = 2;
    return;
  }
  if ("help" in options) {
    console.log(usageText);
    return;
  }
  const context: Context = {
    ...options, tasks, batch: stamp(), scratchRoot: realpathSync(tmpdir()), sessionDir: join(homedir(), ".copilot", "session-state"),
  };
  const selected = options.taskIds.map((id) => tasks.tasks.find((task) => task.id === id)!);
  const items = buildRuns({ models: options.models, tasks: selected, reps: options.reps, seed: options.seed })
    .map((run, index) => plan(run, { ...context, number: index + 1 }));
  if (options.dryRun) {
    console.log(`batch ${context.batch}: ${items.length} runs, sequential\n`);
    for (const item of items) console.log(`${describe(item, context)}\n`);
    return;
  }
  mkdirSync(options.out, { recursive: true });
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      stopping = true;
      if (current) process.kill(-current.pid!, "SIGTERM");
      else process.exit(1);
    });
  }
  for (const item of items) {
    if (stopping) break;
    console.log(summary(await executeRun(item, context)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
