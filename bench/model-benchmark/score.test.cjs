const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const load = () => import("./score.mjs");

const git = (repo, ...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

function put(root, file, text) {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), text);
}

const baseTest = `const test = require("node:test");
const assert = require("node:assert/strict");
const { add } = require("./lib.cjs");
test("zero", () => assert.equal(add(0, 0), 0));
`;
const tipTest = `${baseTest}test("add sums", () => assert.equal(add(2, 3), 5));
`;

// A repo whose base has a bug and whose tip fixes it, with a test for the fix.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bench-score-test-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  put(repo, "pkg/lib.cjs", "exports.add = (a, b) => a - b;\n");
  put(repo, "pkg/lib.test.cjs", baseTest);
  put(repo, "pkg/README.md", "# lib\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  put(repo, "pkg/lib.cjs", "exports.add = (a, b) => a + b;\n");
  put(repo, "pkg/lib.test.cjs", tipTest);
  put(repo, "pkg/README.md", "# lib\nadd sums two numbers.\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "tip");
  const tip = git(repo, "rev-parse", "HEAD");
  const task = {
    id: "IMPL-9", role: "implementation", base, tip,
    hidden: { files: ["pkg/lib.test.cjs"], name_pattern: "add sums", min_tests: 1 },
    regression: { dir: "pkg", exclude: [] },
    rubric: [{ id: "readme", file: "pkg/README.md", changed: true, pattern: "sums" }],
  };
  const tree = (ref, name) => {
    const dest = join(root, name);
    git(repo, "archive", "--format=tar", "-o", join(root, `${name}.tar`), ref);
    mkdirSync(dest);
    execFileSync("tar", ["-xf", join(root, `${name}.tar`), "-C", dest]);
    return dest;
  };
  return { root, repo, task, gold: tree(tip, "gold"), none: tree(base, "none") };
}

test("a tree with the fix passes and the base tree fails", async () => {
  const { scoreImplementation } = await load();
  const { root, repo, task, gold, none } = fixture();
  try {
    const good = scoreImplementation(task, { repo, work: gold });
    assert.equal(good.pass, true, JSON.stringify(good));
    assert.deepEqual(good.rubric, { readme: true });
    const bad = scoreImplementation(task, { repo, work: none });
    assert.equal(bad.pass, false);
    assert.equal(bad.hidden.ok, false);
    assert.equal(bad.regression.ok, true);
    assert.deepEqual(bad.rubric, { readme: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a worker cannot pass by deleting or rewriting the hidden test", async () => {
  const { scoreImplementation } = await load();
  const { root, repo, task, none } = fixture();
  try {
    put(none, "pkg/lib.test.cjs", `const test = require("node:test");\ntest("add sums", () => {});\n`);
    assert.equal(scoreImplementation(task, { repo, work: none }).pass, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fix that breaks an old test fails the regression step", async () => {
  const { scoreImplementation } = await load();
  const { root, repo, task, gold } = fixture();
  try {
    put(gold, "pkg/lib.cjs", "exports.add = (a, b) => (a === 0 ? 1 : a + b);\n");
    const score = scoreImplementation(task, { repo, work: gold });
    assert.equal(score.hidden.ok, true);
    assert.equal(score.regression.ok, false);
    assert.equal(score.pass, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the name pattern must match enough tests", async () => {
  const { scoreImplementation } = await load();
  const { root, repo, task, gold } = fixture();
  try {
    const score = scoreImplementation({ ...task, hidden: { ...task.hidden, name_pattern: "no such test", min_tests: 1 } }, { repo, work: gold });
    assert.equal(score.hidden.ok, true);
    const strict = scoreImplementation({ ...task, hidden: { ...task.hidden, name_pattern: "add sums", min_tests: 2 } }, { repo, work: gold });
    assert.equal(strict.pass, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const investigation = {
  id: "INV-9", role: "investigation", expected_verdict: "implement",
  facts: [{ id: "cause", all: ["alpha", "beta"] }],
  forbidden: { verdicts: ["already-fixed"], patterns: ["gamma"] },
};

const good = { verdict: "implement", summary: "Alpha is wrong.", evidence: { notes: ["the BETA path"] } };

test("investigation needs verdict, every fact, and no forbidden claim", async () => {
  const { scoreInvestigation } = await load();
  assert.equal(scoreInvestigation(investigation, good).pass, true);
  assert.equal(scoreInvestigation(investigation, { ...good, verdict: "already-fixed" }).pass, false);
  assert.deepEqual(scoreInvestigation(investigation, { ...good, verdict: "already-fixed" }).forbidden, ["verdict:already-fixed"]);
  assert.equal(scoreInvestigation(investigation, { ...good, evidence: {} }).facts.cause, false);
  assert.equal(scoreInvestigation(investigation, { ...good, summary: "alpha gamma" }).pass, false);
  assert.equal(scoreInvestigation(investigation, null).pass, false);
});

const stamp = new Date().toISOString();
const mtime = Date.parse(stamp);
const complete = { task: "bench-inv-9", role: "investigation", outcome: "complete", updated_at: stamp, feedback_id: null, summary: "done", evidence: {}, verdict: "implement" };
const emitted = { type: "worker.result", task: "bench-inv-9", at: stamp, data: { role: "investigation", outcome: "complete" } };

test("protocol accepts a complete result with an emitted event", async () => {
  const { checkProtocol } = await load();
  assert.deepEqual(checkProtocol(investigation, complete, [emitted], mtime), { ok: true, reasons: [] });
});

test("protocol names each broken part", async () => {
  const { checkProtocol } = await load();
  const reasons = (result, events = [emitted]) => checkProtocol(investigation, result, events, mtime).reasons.join("|");
  assert.match(reasons(null), /not a JSON object/);
  assert.match(reasons({ ...complete, task: "other" }), /task is/);
  assert.match(reasons({ ...complete, outcome: "blocked" }), /outcome is/);
  const { feedback_id: _omitted, ...withoutFeedback } = complete;
  assert.match(reasons(withoutFeedback), /feedback_id/);
  assert.match(reasons({ ...complete, summary: "" }), /summary/);
  assert.match(reasons(complete, []), /no worker.result event/);
  const stale = { ...emitted, at: new Date(mtime - 60_000).toISOString() };
  assert.match(reasons(complete, [stale]), /no worker.result event/);
  const implementation = { id: "IMPL-9", role: "implementation" };
  const result = { ...complete, task: "bench-impl-9", role: "implementation", head: "abc" };
  const event = { ...emitted, task: "bench-impl-9", data: { role: "implementation", outcome: "complete" } };
  assert.match(checkProtocol(implementation, result, [event], mtime).reasons.join("|"), /head is not a full SHA/);
  assert.equal(checkProtocol(implementation, { ...result, head: "a".repeat(40) }, [event], mtime).ok, true);
});

test("contamination flags state dirs, the session store, the real repo, and the fix SHA", async () => {
  const { detectContamination } = await load();
  const call = (toolName, args) => ({ type: "tool.execution_start", data: { toolName, arguments: args } });
  const task = { tip: "1234567890abcdef1234567890abcdef12345678" };
  const events = [
    call("bash", { command: "ls src" }),
    call("bash", { command: "cat ~/.local/state/copilot-coordinator/x.json" }),
    call("bash", { command: "ls ~/.copilot/session-state" }),
    call("session_store_sql", { query: "select 1" }),
    call("bash", { command: "git show 1234567" }),
    call("view", { path: "/home/me/real-repo/a.txt" }),
    { type: "assistant.message", data: { content: "copilot-coordinator" } },
  ];
  assert.equal(detectContamination(events, task, { extra: ["/home/me/real-repo"] }).length, 5);
  assert.equal(detectContamination(events.slice(0, 1), task).length, 0);
});

test("tasks.json is complete and every task is well formed", async () => {
  const { loadTasks } = await load();
  const data = loadTasks();
  assert.deepEqual(data.tasks.map((task) => task.id), ["INV-1", "INV-2", "INV-3", "IMPL-1", "IMPL-2", "IMPL-3"]);
  assert.match(data.tools_ref, /^[0-9a-f]{40}$/);
  for (const task of data.tasks) {
    assert.ok(task.brief.length > 0, task.id);
    assert.ok(data.caps[task.role], task.id);
    if (task.role === "investigation") {
      assert.match(task.export_at, /^[0-9a-f]{40}$/);
      assert.ok(task.facts.length > 0 && task.expected_verdict, task.id);
      assert.ok(task.forbidden.verdicts && task.forbidden.patterns, task.id);
    } else {
      assert.match(task.base, /^[0-9a-f]{40}$/);
      assert.match(task.tip, /^[0-9a-f]{40}$/);
      assert.ok(task.hidden.files.length > 0 && task.hidden.min_tests > 0, task.id);
    }
  }
});
