import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

const script = join(import.meta.dirname, "factory.mjs");
const workerName = join(import.meta.dirname, "worker-name.mjs");

async function load() {
  return (await import(workerName)).workerName;
}

test("maps each role to its verb", async () => {
  const workerName = await load();
  const verbs = {
    investigation: "Investigate",
    implementation: "Implement",
    review: "Review",
    backlog: "Find work",
    improve: "Improve",
  };
  for (const [role, verb] of Object.entries(verbs)) {
    assert.equal(workerName({ role, ref: "#7", summary: "S" }), `${verb} #7: S`);
  }
});

test("keeps #N, owner/repo#N and task-ID refs, and reads a bare number as #N", async () => {
  const workerName = await load();
  assert.equal(workerName({ role: "review", ref: "#42", summary: "Fix login" }), "Review #42: Fix login");
  assert.equal(workerName({ role: "review", ref: "octo/api#9", summary: "Fix" }), "Review octo/api#9: Fix");
  assert.equal(workerName({ role: "review", ref: "42", summary: "Fix" }), "Review #42: Fix");
  assert.equal(
    workerName({ role: "implementation", ref: "favicon", summary: "Add a dashboard favicon" }),
    "Implement favicon: Add a dashboard favicon",
  );
});

test("omits the colon when the summary is empty", async () => {
  const workerName = await load();
  assert.equal(workerName({ role: "improve", ref: "improve-rule", summary: "  " }), "Improve improve-rule");
});

test("collapses whitespace and strips quotes", async () => {
  const workerName = await load();
  const name = workerName({ role: "implementation", ref: "#1", summary: "  Fix \"the\"\n  user's\t`bug` \u201Chere\u201D " });
  assert.equal(name, "Implement #1: Fix the users bug here");
});

test("truncates the summary to 100 characters with an ellipsis", async () => {
  const workerName = await load();
  const name = workerName({ role: "implementation", ref: "octo/api#123", summary: "x".repeat(300) });
  assert.equal(Array.from(name).length, 100);
  assert.ok(name.startsWith("Implement octo/api#123: x"));
  assert.ok(name.endsWith("x…"));
  const exact = workerName({ role: "review", ref: "#1", summary: "y".repeat(100 - "Review #1: ".length) });
  assert.equal(Array.from(exact).length, 100);
  assert.ok(!exact.endsWith("…"));
});

test("rejects an unknown role and a missing ref", async () => {
  const workerName = await load();
  assert.throws(() => workerName({ role: "deploy", ref: "#1" }), /unknown role/);
  assert.throws(() => workerName({ role: "review", ref: " " }), /ref is required/);
});

test("CLI prints the name", () => {
  const run = spawnSync(
    process.execPath,
    [script, "worker-name", "--role", "implementation", "--ref", "#42", "--summary", "Fix login redirect"],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "Implement #42: Fix login redirect\n");
});

test("CLI exits 1 with usage on a bad role", () => {
  const run = spawnSync(process.execPath, [script, "worker-name", "--role", "nope", "--ref", "#1"], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Usage:/);
});
