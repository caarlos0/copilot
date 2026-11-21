import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

const script = join(import.meta.dirname, "factory.mjs");
const run = (args: string[], input = "") => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", input });

async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "dispatcher-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

// Each command answers with its own module's text, so a wrong route fails here.
const commands: [string[], number, RegExp][] = [
  [["write", "--help"], 0, /Create or update a factory\.json/],
  [["broker", "--help"], 0, /Factory event broker/],
  [["reconcile"], 1, /Usage: node factory\.mjs reconcile/],
  [["serve", "--help"], 0, /Serve the factory dashboard/],
  [["worktree", "--help"], 0, /Usage:/],
  [["worker-name"], 1, /unknown role/],
  [["shot", "--help"], 0, /Screenshot the factory dashboard/],
  [["archive"], 2, /Usage: node factory\.mjs archive clean/],
  [["session-metrics", "--help"], 0, /Measure Copilot sessions/],
  [["migrate", "--help"], 0, /Migrate legacy coordinator handoffs/],
  [["pr-watch", "--help"], 0, /Usage: node factory\.mjs pr-watch/],
];

for (const [args, status, text] of commands) {
  test(`${args.join(" ")} runs its module`, () => {
    const { status: code, stdout, stderr } = run(args);
    assert.equal(code, status, stderr);
    assert.match(stdout + stderr, text);
  });
}

for (const hook of ["guard", "attention", "stop"]) {
  test(`hook ${hook} allows an empty payload`, () => {
    const { status, stdout, stderr } = run(["hook", hook], "{}");
    assert.equal(status, 0, stderr);
    assert.equal(stdout, "");
  });
}

test("an unknown hook exits 2", () => {
  const { status, stderr } = run(["hook", "nope"]);
  assert.equal(status, 2);
  assert.match(stderr, /Unknown hook "nope"/);
});

test("no command exits 2 and --help exits 0, both with the command list", () => {
  const none = run([]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /Commands:/);
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Commands:/);
});

test("write and the old FILE usage create the same factory", async (t) => {
  const dir = await directory(t);
  const options = ["--project", "owner/repo", "--run-goal", "Run the factory for owner/repo"];
  const named = join(dir, "owner.repo-factory.json");
  const legacy = join(dir, "other.repo-factory.json");
  assert.equal(run(["write", named, ...options]).status, 0);
  assert.equal(run([legacy, ...options.slice(0, 1), "other/repo", ...options.slice(2)]).status, 0);
  assert.equal(JSON.parse(await readFile(named, "utf8")).project, "owner/repo");
  assert.equal(JSON.parse(await readFile(legacy, "utf8")).project, "other/repo");
});

test("an old bundle can import update and ConflictError without running the dispatcher", async (t) => {
  const dir = await directory(t);
  const importer = join(dir, "importer.mjs");
  await writeFile(importer, `import { ConflictError, update } from ${JSON.stringify(script)};\nconsole.log(typeof update, typeof ConflictError);\n`);
  const { status, stdout, stderr } = spawnSync(process.execPath, [importer, "--help"], { encoding: "utf8" });
  assert.equal(status, 0, stderr);
  assert.equal(stdout, "function function\n");
});

test("armed counts a waiter that runs as factory.mjs broker wait", async (t) => {
  const psWorks = spawnSync("ps", ["-o", "command=", "-p", String(process.pid)]).status === 0;
  if (!psWorks) return t.skip("ps is not usable here");
  const dir = await directory(t);
  const file = join(dir, "owner.repo-factory.json");
  await writeFile(file, JSON.stringify({ status: "active", tasks: [] }));
  const waiter = (...args: string[]) => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", ...args], { stdio: "ignore" });
    t.after(() => child.kill());
    return child.pid;
  };
  await writeFile(join(dir, "owner.repo-factory-waiter.pid"), `${waiter("factory.mjs", "broker", "wait")}\n`);
  assert.equal(run(["broker", "armed", file]).status, 0);
  await writeFile(join(dir, "owner.repo-factory-waiter.pid"), `${waiter("factory.mjs", "broker", "emit")}\n`);
  assert.equal(run(["broker", "armed", file]).status, 1);
});
