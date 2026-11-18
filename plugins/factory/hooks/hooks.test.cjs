const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const hooks = require("../hooks.json");
const [entry] = hooks.hooks.sessionStart;
const jq = spawnSync("sh", ["-c", "command -v jq"], { encoding: "utf8" }).stdout.trim();
const needsJq = { skip: jq ? false : "jq is not installed" };

async function fixture(t, { rex = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "hooks-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = join(directory, "calls");
  if (rex) {
    const stub = join(directory, "rex");
    await writeFile(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${calls}"\necho "ctx line"\n`);
    await chmod(stub, 0o755);
  }
  await symlink(jq, join(directory, "jq"));
  const run = (env) =>
    // macOS bash sources ~/.bashrc when stdin is a socket, which Node's default pipe is.
    spawnSync("/bin/bash", ["-c", entry.bash], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: directory, ...env },
    });
  return { calls, run };
}

test("hooks.json declares one sessionStart command that never enables naming", () => {
  assert.equal(hooks.version, 1);
  assert.equal(hooks.hooks.sessionStart.length, 1);
  assert.equal(entry.type, "command");
  assert.equal(typeof entry.bash, "string");
  assert.ok(entry.timeoutSec > 0 && entry.timeoutSec <= 30);
  assert.ok(entry.bash.includes("--feature-session-naming=false"));
  assert.ok(!entry.bash.includes("--feature-session-naming=true"));
});

test("prints rex output as additionalContext", needsJq, async (t) => {
  const { calls, run } = await fixture(t);
  const out = run({ REX_SESSION: "session:x" });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { additionalContext: "ctx line" });
  assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), [
    "__internal",
    "session-start",
    "--agent=copilot",
    "--feature-session-naming=false",
  ]);
});

test("is silent and skips rex when REX_SESSION is unset", needsJq, async (t) => {
  const { calls, run } = await fixture(t);
  const out = run({});
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, "");
  await assert.rejects(stat(calls), { code: "ENOENT" });
});

test("is silent when rex is not installed", needsJq, async (t) => {
  const { run } = await fixture(t, { rex: false });
  const out = run({ REX_SESSION: "session:x" });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, "");
  assert.equal(out.stderr, "");
});
