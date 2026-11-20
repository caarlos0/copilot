import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const tasksFile = join(dirname(fileURLToPath(import.meta.url)), "tasks.json");

export type Json = Record<string, any>;
export type Role = "implementation" | "investigation";

type Common = { id: string; role: Role; slug: string; title: string; brief: string };

export type Investigation = Common & {
  role: "investigation";
  export_at: string;
  trap?: boolean;
  expected_verdict: string;
  facts: { id: string; all: string[] }[];
  forbidden: { verdicts: string[]; patterns: string[] };
  base?: undefined;
  tip?: undefined;
};

export type Implementation = Common & {
  role: "implementation";
  base: string;
  tip: string;
  difficulty: string;
  hidden: { files: string[]; name_pattern: string | null; min_tests: number };
  regression: { dir: string; exclude: string[] };
  rubric: { id: string; file: string; changed?: boolean; pattern?: string }[];
  export_at?: undefined;
};

export type Task = Investigation | Implementation;

export type Tasks = {
  version: number;
  tools_ref: string;
  tools_path: string;
  defaults: { agent: string; reasoning_effort: string; baseline: string; kill_grace_seconds: number };
  caps: Record<Role, { max_ai_credits: number; wall_minutes: number }>;
  tasks: Task[];
};

// The task ID inside the scratch factory.
export const factoryTaskId = (task: Task) => `bench-${task.id.toLowerCase()}`;

export const loadTasks = (): Tasks => JSON.parse(readFileSync(tasksFile, "utf8"));

const testTimeoutMs = 10 * 60_000;

// Every string in a result, so a rubric matches text and not JSON escaping.
export function flatten(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (value && typeof value === "object") return Object.values(value).flatMap(flatten);
  return [];
}

const matches = (text: string, pattern: string) => new RegExp(pattern, "i").test(text);

// Pass = right verdict AND every required fact AND no forbidden claim.
export function scoreInvestigation(task: Investigation, result: any) {
  const text = flatten(result).join("\n");
  const facts = Object.fromEntries(task.facts.map((fact) => [fact.id, fact.all.every((pattern) => matches(text, pattern))]));
  const forbidden = [
    ...(task.forbidden.verdicts.includes(result?.verdict) ? [`verdict:${result.verdict}`] : []),
    ...task.forbidden.patterns.filter((pattern) => matches(text, pattern)).map((pattern) => `pattern:${pattern}`),
  ];
  const verdictOk = result?.verdict === task.expected_verdict;
  return { pass: verdictOk && Object.values(facts).every(Boolean) && forbidden.length === 0, verdict_ok: verdictOk, facts, forbidden };
}

const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

// The worker contract: a complete result with every field, and a worker.result
// event that the broker accepted after the result file was written.
export function checkProtocol(task: Task, result: any, events: Json[], resultMtimeMs: number) {
  const reasons: string[] = [];
  if (!isObject(result)) return { ok: false, reasons: ["result is not a JSON object"] };
  if (result.task !== factoryTaskId(task)) reasons.push(`task is ${JSON.stringify(result.task)}`);
  if (result.role !== task.role) reasons.push(`role is ${JSON.stringify(result.role)}`);
  if (result.outcome !== "complete") reasons.push(`outcome is ${JSON.stringify(result.outcome)}`);
  if (Number.isNaN(Date.parse(result.updated_at))) reasons.push("updated_at is not a time");
  if (!Object.hasOwn(result, "feedback_id")) reasons.push("feedback_id is missing");
  if (typeof result.summary !== "string" || result.summary === "") reasons.push("summary is empty");
  if (!isObject(result.evidence)) reasons.push("evidence is not an object");
  if (task.role === "investigation" && typeof result.verdict !== "string") reasons.push("verdict is missing");
  if (task.role === "implementation" && !/^[0-9a-f]{40}$/.test(result.head ?? "")) reasons.push("head is not a full SHA");
  const emitted = events.some((event) => event.type === "worker.result" && event.task === factoryTaskId(task) &&
    event.data?.role === task.role && event.data?.outcome === "complete" &&
    Date.parse(event.at) >= resultMtimeMs - 1000);
  if (!emitted) reasons.push("no worker.result event after the result write");
  return { ok: reasons.length === 0, reasons };
}

const contaminationPatterns = [
  /copilot-coordinator|copilot-factory/,
  /\.copilot\/session-state|session-state\//,
  /session_store_sql|chronicle/i,
];

// Tool calls that reach outside the scratch checkout: state dirs, the session store,
// the real repository, or the fix commit.
export function detectContamination(events: Json[], task: Task, { extra }: { extra?: string[] } = {}) {
  const patterns = [...contaminationPatterns, ...(extra ?? []).map((text) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))];
  if (task.tip) patterns.push(new RegExp(`\\b${task.tip.slice(0, 7)}`));
  const found: string[] = [];
  for (const event of events) {
    if (event.type !== "tool.execution_start") continue;
    const call = `${event.data?.toolName} ${JSON.stringify(event.data?.arguments ?? {})}`;
    const hit = patterns.find((pattern) => pattern.test(call));
    if (hit) found.push(call.slice(0, 160));
  }
  return found;
}

// git archive REF [-- PATHS] extracted into DEST. No worktree: the history stays behind.
export function exportTree(repo: string, ref: string, dest: string, paths: string[] = []) {
  mkdirSync(dest, { recursive: true });
  const tar = execFileSync("git", ["-C", repo, "archive", "--format=tar", ref, ...(paths.length ? ["--", ...paths] : [])], { maxBuffer: 1 << 30 });
  execFileSync("tar", ["-x", "-C", dest], { input: tar });
}

const withoutGit = (source: string) => !source.split("/").includes(".git");

function copyTree(from: string, to: string) {
  cpSync(from, to, { recursive: true, filter: withoutGit });
}

function parseTap(output: string) {
  const count = (name: string) => Number(output.match(new RegExp(`^# ${name} (\\d+)`, "m"))?.[1] ?? 0);
  return { tests: count("tests"), pass: count("pass"), fail: count("fail") };
}

// A parent test run or a proxy would change how the hidden tests behave.
const hermeticEnv = () => Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => key !== "NODE_TEST_CONTEXT" && !/^(?:all|https?)_proxy$|^NODE_USE_ENV_PROXY$/i.test(key)));

export function runTests(cwd: string, files: string[], { pattern = null }: { pattern?: string | null } = {}) {
  const env = hermeticEnv();
  const args = ["--test", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=${pattern}`] : []), ...files];
  const run = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout: testTimeoutMs, maxBuffer: 1 << 28 });
  return { ...parseTap(run.stdout ?? ""), status: run.status, tail: `${run.stdout ?? ""}${run.stderr ?? ""}`.slice(-2000) };
}

const testFiles = (root: string, { dir, exclude }: Implementation["regression"]) =>
  readdirSync(join(root, dir)).filter((name) => name.endsWith(".test.cjs") && !exclude.includes(name)).sort().map((name) => join(dir, name));

type Context = { repo: string; work: string };

// Red-to-green: the tip's tests over the worker's tree must pass, and the base's tests
// must still pass against the worker's code.
export function scoreHidden(task: Implementation, { repo, work, scratch }: Context & { scratch: string }) {
  const hiddenDir = join(scratch, "hidden");
  copyTree(work, hiddenDir);
  exportTree(repo, task.tip, hiddenDir, task.hidden.files);
  const hidden = runTests(hiddenDir, task.hidden.files, { pattern: task.hidden.name_pattern });
  const regressionDir = join(scratch, "regression");
  copyTree(work, regressionDir);
  exportTree(repo, task.base, regressionDir, task.hidden.files);
  const regression = runTests(regressionDir, testFiles(regressionDir, task.regression));
  const ok = (run: { status: number | null; fail: number; pass: number }, min: number) => run.status === 0 && run.fail === 0 && run.pass >= min;
  return {
    pass: ok(hidden, task.hidden.min_tests) && ok(regression, 1),
    hidden: { ...hidden, ok: ok(hidden, task.hidden.min_tests) },
    regression: { ...regression, ok: ok(regression, 1) },
  };
}

const readOrNull = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

// Informational only: docs and test edits do not decide pass or fail.
export function scoreRubric(task: Implementation, { repo, work }: Context) {
  return Object.fromEntries(task.rubric.map((item) => {
    const now = readOrNull(join(work, item.file));
    const before = execFileSync("git", ["-C", repo, "show", `${task.base}:${item.file}`], { encoding: "utf8" });
    const changed = now !== null && now !== before;
    const mentions = item.pattern === undefined || (now !== null && matches(now, item.pattern));
    return [item.id, (item.changed ? changed : true) && mentions];
  }));
}

export function scoreImplementation(task: Implementation, context: Context) {
  const scratch = mkdtempSync(join(tmpdir(), "bench-score-"));
  try {
    const hidden = scoreHidden(task, { ...context, scratch });
    return { ...hidden, rubric: scoreRubric(task, context) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      task: { type: "string" },
      work: { type: "string" },
      result: { type: "string" },
      repo: { type: "string", default: repoRoot },
    },
  });
  const task = loadTasks().tasks.find(({ id }) => id === values.task);
  if (!task || (task.role === "implementation" ? !values.work : !values.result)) {
    console.error("Usage: node score.mjs --task IMPL-1 --work DIR [--repo DIR]\n       node score.mjs --task INV-1 --result FILE");
    process.exitCode = 2;
    return;
  }
  const score = task.role === "implementation"
    ? scoreImplementation(task, { repo: values.repo!, work: resolve(values.work!) })
    : scoreInvestigation(task, JSON.parse(readFileSync(values.result!, "utf8")));
  console.log(JSON.stringify(score, null, 2));
  process.exitCode = score.pass ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
