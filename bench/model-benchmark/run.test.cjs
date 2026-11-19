const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");

const load = () => import("./run.mjs");
const lifecycle = join(__dirname, "../../plugins/factory/skills/lifecycle");
// The pinned factory tools run main() only when argv[1] is the real path, so tests need a resolved temp root too.
const scratch = (name) => mkdtempSync(join(realpathSync(tmpdir()), `bench-${name}-`));
const git = (repo, ...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

test("deny flags match the launch rules in the lifecycle SKILL.md", async () => {
  const { denyPatterns } = await load();
  const skill = readFileSync(join(lifecycle, "SKILL.md"), "utf8");
  const documented = [...skill.matchAll(/--deny-tool='shell\(([^)]+)\)'/g)].map((match) => match[1]);
  assert.deepEqual(denyPatterns, documented);
});

test("the run order is shuffled but repeatable and complete", async () => {
  const { buildRuns } = await load();
  const input = { models: ["a", "b"], tasks: [{ id: "T1" }, { id: "T2" }], reps: 3, seed: 7 };
  const first = buildRuns(input);
  assert.equal(first.length, 12);
  assert.deepEqual(buildRuns(input), first);
  assert.notDeepEqual(buildRuns({ ...input, seed: 8 }), first);
  assert.equal(new Set(first.map((run) => `${run.model}/${run.task.id}/${run.rep}`)).size, 12);
});

test("the copilot command is headless, capped, and logged", async () => {
  const { copilotArguments } = await load();
  const argv = copilotArguments({
    model: "m", effort: "medium", agent: "coding:caarlos0", aic: 100, paths: { brief: "/s/brief.md" },
    logs: "/o/logs", usage: "/o/usage.json", transcript: "/o/transcript.md",
  });
  const after = (flag) => argv[argv.indexOf(flag) + 1];
  assert.equal(after("--model"), "m");
  assert.equal(after("--max-ai-credits"), "100");
  assert.equal(after("--usage-output-file"), "/o/usage.json");
  assert.equal(after("--output-format"), "json");
  assert.equal(after("-p"), "Read /s/brief.md and do it.");
  for (const flag of ["--yolo", "--sandbox", "--no-ask-user"]) assert.ok(argv.includes(flag), flag);
  assert.ok(argv.includes("--deny-tool=shell(git stash)"));
});

test("usage converts nano AI units and flags a mixed-model run", async () => {
  const { extractUsage } = await load();
  assert.equal(extractUsage(null, "m"), null);
  const usage = { totalNanoAiu: 12_500_000_000, modelMetrics: { m: {}, haiku: {} }, agentMetrics: [{ name: "explore" }] };
  assert.deepEqual(extractUsage(usage, "m"), { aic: 12.5, premium_requests: null, models: ["m", "haiku"], agents: ["explore"], mixed_model: true });
  assert.equal(extractUsage({ ...usage, modelMetrics: [{ model: "m" }] }, "m").mixed_model, false);
});

test("tool stats split edits from all calls", async () => {
  const { toolStats } = await load();
  const tools = { bash: { calls: 10, failures: 2 }, edit: { calls: 4, failures: 1 }, create: { calls: 1, failures: 0 } };
  assert.deepEqual(toolStats(tools), { tool_calls: 15, tool_failures: 3, edit_calls: 5, edit_failures: 1 });
});

test("infra failures need a failing exit, no result, and a known message", async () => {
  const { isInfra } = await load();
  const base = { exitCode: 1, timedOut: false, hasResult: false, text: "Error: 429 rate limit" };
  assert.equal(isInfra(base), true);
  assert.equal(isInfra({ ...base, hasResult: true }), false);
  assert.equal(isInfra({ ...base, timedOut: true }), false);
  assert.equal(isInfra({ ...base, exitCode: 0 }), false);
  assert.equal(isInfra({ ...base, text: "tests failed" }), false);
});

test("the session is found by its cwd, newest first, and old ones are skipped", async () => {
  const { findSession } = await load();
  const root = scratch("sessions");
  try {
    const work = join(root, "work");
    mkdirSync(work);
    const session = (name, cwd, ageSeconds) => {
      mkdirSync(join(root, "store", name), { recursive: true });
      const file = join(root, "store", name, "workspace.yaml");
      writeFileSync(file, `id: ${name}\ncwd: ${cwd}\n`);
      const time = new Date(Date.now() - ageSeconds * 1000);
      utimesSync(file, time, time);
    };
    session("old", work, 3600);
    session("a", work, 20);
    session("b", work, 10);
    session("other", join(root, "elsewhere"), 5);
    assert.deepEqual(findSession(join(root, "store"), realpathSync(work), Date.now() - 60_000), ["b", "a"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("options reject bad input", async () => {
  const { parseOptions } = await load();
  const { loadTasks } = await import("./score.mjs");
  const tasks = loadTasks();
  assert.deepEqual(parseOptions([], tasks).models, [tasks.defaults.baseline]);
  assert.equal(parseOptions(["--tasks", "IMPL-1"], tasks).taskIds.length, 1);
  assert.throws(() => parseOptions(["--tasks", "NOPE"], tasks), /Unknown task: NOPE/);
  assert.throws(() => parseOptions(["--max-aic", "10"], tasks), /at least 30/);
  assert.throws(() => parseOptions(["--reps", "0"], tasks), /at least 1/);
  assert.throws(() => parseOptions(["--models", "bad model"], tasks), /--models/);
});

test("--dry-run prints the plan and writes nothing", () => {
  const out = join(scratch("dry"), "out");
  try {
    const run = spawnSync(process.execPath, [join(__dirname, "run.mjs"), "--models", "a-model,b-model", "--tasks", "IMPL-1,INV-1", "--max-aic", "100", "--dry-run", "--out", out], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /4 runs, sequential/);
    assert.match(run.stdout, /--model a-model/);
    assert.match(run.stdout, /--max-ai-credits 100/);
    assert.equal(existsSync(out), false);
    const bad = spawnSync(process.execPath, [join(__dirname, "run.mjs"), "--tasks", "NOPE", "--dry-run"], { encoding: "utf8" });
    assert.equal(bad.status, 2);
  } finally {
    rmSync(dirname(out), { recursive: true, force: true });
  }
});

// The scratch factory must accept the exact emit command from the brief.
test("prepare builds a scratch the worker contract works in", async () => {
  const { prepare, scratchPaths } = await import("./prepare.mjs");
  const { checkProtocol, factoryTaskId } = await import("./score.mjs");
  const root = scratch("prepare");
  try {
    const repo = join(root, "repo");
    mkdirSync(join(repo, "plugins/factory/skills"), { recursive: true });
    cpSync(lifecycle, join(repo, "plugins/factory/skills/lifecycle"), { recursive: true, filter: (source) => !source.endsWith(".test.cjs") });
    writeFileSync(join(repo, "README.md"), "base\n");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    const sha = git(repo, "rev-parse", "HEAD");
    const task = { id: "IMPL-9", role: "implementation", title: "Test task", brief: "Do the thing.", base: sha };
    const paths = scratchPaths(join(root, "scratch"), task, "plugins/factory/skills/lifecycle");
    prepare(task, { repo, toolsRef: sha, toolsPath: "plugins/factory/skills/lifecycle", paths });

    assert.equal(git(paths.work, "rev-list", "--count", "HEAD"), "1");
    assert.equal(git(paths.work, "rev-parse", "--abbrev-ref", "HEAD"), "bench/impl-9");
    assert.equal(git(paths.work, "rev-parse", "bench-base"), git(paths.work, "rev-parse", "main"));
    assert.equal(statSync(join(paths.tools, "broker.mjs")).mode & 0o222, 0);

    const head = git(paths.work, "rev-parse", "HEAD");
    const result = { task: factoryTaskId(task), role: "implementation", updated_at: new Date().toISOString(), outcome: "complete", feedback_id: null, summary: "done", head, evidence: {} };
    writeFileSync(paths.result, JSON.stringify(result));
    const emit = readFileSync(paths.brief, "utf8").split("\n").find((line) => line.startsWith("node ") && line.includes("broker.mjs emit"));
    assert.ok(emit, "brief has the emit command");
    const run = spawnSync("sh", ["-c", emit.replace("FULL SHA", head)], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);

    const events = readFileSync(paths.events, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(checkProtocol(task, result, events, statSync(paths.result).mtimeMs), { ok: true, reasons: [] });

    const wrong = spawnSync("sh", ["-c", emit.replace("FULL SHA", "0".repeat(40))], { encoding: "utf8" });
    assert.notEqual(wrong.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
