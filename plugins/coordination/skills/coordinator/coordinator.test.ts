import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const run = (...args: string[]) => spawnSync(process.execPath, args, { encoding: "utf8" });
const coordinator = join(import.meta.dirname, "coordinator.mjs");

for (const command of ["handoff", "serve", "wait"]) {
  test(`coordinator ${command} --help prints the usage`, () => {
    const result = run(coordinator, command, "--help");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Usage: node coordinator\\.mjs ${command}`));
    assert.equal(result.stderr, "");
  });
}

test("coordinator handoff writes the handoff file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coordinator-dispatcher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "project-coordinator.json");
  const result = run(coordinator, "handoff", file, "--project", "owner/repository", "--role", "implementer",
    "--run-goal", "Implement work");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(file, "utf8")).project, "owner/repository");
});

test("coordinator rejects a missing or unknown command with exit 2", () => {
  for (const args of [[], ["unknown"], ["constructor"]]) {
    const result = run(coordinator, ...args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage: node coordinator\.mjs/);
  }
});
