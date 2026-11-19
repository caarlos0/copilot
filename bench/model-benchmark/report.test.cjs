const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const load = () => import("./report.mjs");

function record(model, pass, overrides = {}) {
  return {
    batch: "b1", model, role: "implementation", task: "IMPL-1", excluded: null, aic: 100, wall_seconds: 600,
    tool_calls: 100, tool_failures: 2, edit_calls: 10, edit_failures: 0, mixed_model: false, usage_missing: false,
    score: { pass, protocol: { ok: true } }, ...overrides,
  };
}

const many = (model, passes, total, overrides) =>
  Array.from({ length: total }, (_, index) => record(model, index < passes, overrides));

test("wilson interval matches known values", async () => {
  const { wilson } = await load();
  const [low, high] = wilson(5, 5);
  assert.ok(Math.abs(low - 0.5655) < 0.001, `low ${low}`);
  assert.equal(high, 1);
  assert.deepEqual(wilson(0, 0), [null, null]);
});

test("percentile interpolates", async () => {
  const { percentile } = await load();
  assert.equal(percentile([10, 20, 30, 40], 0.5), 25);
  assert.equal(percentile([5], 0.9), 5);
  assert.equal(percentile([], 0.5), null);
});

test("a cheaper model with equal quality is kept", async () => {
  const { aggregate } = await load();
  const rows = aggregate([...many("base", 15, 15), ...many("cheap", 15, 15, { aic: 60, wall_seconds: 700 })], "base");
  const cheap = rows.find((row) => row.model === "cheap");
  assert.equal(cheap.verdict, "keep", cheap.failed.join());
  assert.equal(rows.find((row) => row.model === "base").verdict, "baseline");
  assert.equal(cheap.aic_per_pass, 60);
});

test("cost is per passing run, so failures make a model dearer", async () => {
  const { aggregate } = await load();
  const rows = aggregate([...many("base", 15, 15), ...many("cheap", 12, 15, { aic: 60 })], "base");
  const cheap = rows.find((row) => row.model === "cheap");
  assert.equal(cheap.aic_per_pass, 75);
  assert.equal(cheap.verdict, "reject");
  assert.ok(cheap.failed.includes("pass_rate"));
});

test("each line of the keep bar can reject alone", async () => {
  const { aggregate } = await load();
  const base = many("base", 15, 15);
  const cases = {
    cost: many("x", 15, 15, { aic: 90 }),
    wall: many("x", 15, 15, { aic: 50, wall_seconds: 1000 }),
    tool_failures: many("x", 15, 15, { aic: 50, tool_failures: 9 }),
    protocol: many("x", 15, 15, { aic: 50, score: { pass: true, protocol: { ok: false } } }),
  };
  for (const [name, records] of Object.entries(cases)) {
    const row = aggregate([...base, ...records], "base").find((item) => item.model === "x");
    assert.deepEqual(row.failed, [name]);
  }
});

test("excluded runs leave the rates and are counted apart", async () => {
  const { aggregate } = await load();
  const rows = aggregate([...many("base", 15, 15), ...many("x", 15, 15, { aic: 50 }), record("x", false, { excluded: "infra" }), record("x", false, { excluded: "contamination" })], "base");
  const row = rows.find((item) => item.model === "x");
  assert.equal(row.n, 15);
  assert.equal(row.infra, 1);
  assert.equal(row.contaminated, 1);
  assert.equal(row.verdict, "reject");
  assert.ok(row.failed.includes("protocol"));
});

test("without a baseline the verdict says so", async () => {
  const { aggregate } = await load();
  assert.equal(aggregate(many("x", 15, 15), "base")[0].verdict, "no-baseline");
});

test("cli prints a table and writes json", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-report-"));
  try {
    const ledger = [...many("claude-sonnet-5.5", 15, 15), ...many("gemini-4-argon", 15, 15, { aic: 50 })];
    writeFileSync(join(dir, "ledger.jsonl"), `${ledger.map((item) => JSON.stringify(item)).join("\n")}\n`);
    const run = spawnSync(process.execPath, [join(__dirname, "report.mjs"), "--dir", dir], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /gemini-4-argon .*keep/);
    assert.match(run.stdout, /baseline/);
    assert.ok(JSON.parse(require("node:fs").readFileSync(join(dir, "report.json"), "utf8")).rows.length === 2);
    const empty = spawnSync(process.execPath, [join(__dirname, "report.mjs"), "--dir", dir, "--batch", "nope"], { encoding: "utf8" });
    assert.equal(empty.status, 1);
    assert.equal(spawnSync(process.execPath, [join(__dirname, "report.mjs"), "--bogus"], { encoding: "utf8" }).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
