import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import hooks from "../hooks.json" with { type: "json" };
const [entry] = hooks.hooks.sessionStart;
const jq = spawnSync("sh", ["-c", "command -v jq"], { encoding: "utf8" }).stdout.trim();
const needsJq = { skip: jq ? false : "jq is not installed" };

async function fixture(t: TestContext, { rex = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "hooks-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = join(directory, "calls");
  if (rex) {
    const stub = join(directory, "rex");
    await writeFile(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${calls}"\necho "ctx line"\n`);
    await chmod(stub, 0o755);
  }
  await symlink(jq, join(directory, "jq"));
  const run = (env: Record<string, string>) =>
    // macOS bash sources ~/.bashrc when stdin is a socket, which Node's default pipe is.
    spawnSync("/bin/bash", ["-c", entry.bash], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: directory, ...env },
    });
  return { calls, run };
}

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

test("every hook keeps the 25 second timeout", () => {
  // A busy host stalls a hook past 5 seconds; Copilot then reports the hook as failed.
  for (const [event, list] of Object.entries(hooks.hooks)) {
    for (const hook of list) assert.equal(hook.timeoutSec, 25, event);
  }
});

test("every hook script runs only after a file check", () => {
  // A missing bundle must fail open, so a hook never blocks a session.
  for (const [event, list] of Object.entries(hooks.hooks)) {
    for (const hook of list) {
      for (const [, script] of hook.bash.matchAll(/\$root\/(hooks\/[\w-]+\.mjs)/g)) {
        assert.ok(
          hook.bash.includes(`[ -f "$root/${script}" ] || `),
          `${event} runs ${script} without a -f guard`,
        );
      }
    }
  }
});

test("is silent when rex is not installed", needsJq, async (t) => {
  const { run } = await fixture(t, { rex: false });
  const out = run({ REX_SESSION: "session:x" });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, "");
  assert.equal(out.stderr, "");
});
