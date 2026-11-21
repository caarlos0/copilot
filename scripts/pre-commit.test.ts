import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

const hook = join(import.meta.dirname, "..", ".githooks", "pre-commit");

// A repository with one plugin. A fake `bun` copies each .ts file to the .mjs file beside it and logs the call.
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pre-commit-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(join(repo, ".githooks"), { recursive: true });
  mkdirSync(join(repo, "plugins/demo/node_modules"), { recursive: true });
  mkdirSync(bin);
  copyFileSync(hook, join(repo, ".githooks/pre-commit"));
  chmodSync(join(repo, ".githooks/pre-commit"), 0o755);
  writeFileSync(join(repo, "plugins/demo/package.json"), "{}\n");
  writeFileSync(join(repo, "plugins/demo/a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "plugins/demo/a.test.ts"), "// test\n");
  writeFileSync(join(repo, "README.md"), "hello\n");
  writeFileSync(
    join(bin, "bun"),
    `#!/bin/sh\necho "$@" >> "${root}/bun.log"\ncp "$3/a.ts" "$3/a.mjs"\n`,
  );
  chmodSync(join(bin, "bun"), 0o755);

  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    HOME: root,
    TMPDIR: tmpdir(),
  };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    return { status: result.status, out: result.stdout, err: result.stderr };
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "core.hooksPath", ".githooks");
  git("add", ".");
  git("commit", "-q", "--no-verify", "-m", "init");
  const calls = () => (existsSync(join(root, "bun.log")) ? readFileSync(join(root, "bun.log"), "utf8") : "");
  return { repo, root, bin, git, calls, env };
}

test("a staged source file rebuilds its bundle into the same commit", (t) => {
  const { repo, git, calls } = fixture(t);
  writeFileSync(join(repo, "plugins/demo/a.ts"), "export const a = 2;\n");
  git("add", "plugins/demo/a.ts");
  const commit = git("commit", "-s", "-m", "feat: change a");
  assert.equal(commit.status, 0, commit.err);
  assert.equal(calls(), "run --cwd plugins/demo build\n");
  assert.equal(git("show", "--name-only", "--format=", "HEAD").out.trim().split("\n").sort().join(","), "plugins/demo/a.mjs,plugins/demo/a.ts");
  assert.equal(git("show", "HEAD:plugins/demo/a.mjs").out, "export const a = 2;\n");
  assert.equal(git("status", "--porcelain").out, "");
});

test("a commit with no build input does not run the build", (t) => {
  const { repo, git, calls } = fixture(t);
  writeFileSync(join(repo, "README.md"), "changed\n");
  writeFileSync(join(repo, "plugins/demo/a.test.ts"), "// changed\n");
  git("add", ".");
  const commit = git("commit", "-m", "docs: change readme");
  assert.equal(commit.status, 0, commit.err);
  assert.equal(calls(), "");
});

test("a missing Bun fails the commit with a message", (t) => {
  const { repo, bin, git } = fixture(t);
  rmSync(join(bin, "bun"));
  writeFileSync(join(repo, "plugins/demo/a.ts"), "export const a = 3;\n");
  git("add", "plugins/demo/a.ts");
  const commit = git("commit", "-m", "feat: change a");
  assert.notEqual(commit.status, 0);
  assert.match(commit.err, /bun is not installed/);
  assert.equal(git("rev-list", "--count", "HEAD").out.trim(), "1");
});

test("unstaged source changes fail the commit", (t) => {
  const { repo, git, calls } = fixture(t);
  writeFileSync(join(repo, "plugins/demo/a.ts"), "export const a = 4;\n");
  git("add", "plugins/demo/a.ts");
  writeFileSync(join(repo, "plugins/demo/a.ts"), "export const a = 5;\n");
  const commit = git("commit", "-m", "feat: change a");
  assert.notEqual(commit.status, 0);
  assert.match(commit.err, /unstaged changes/);
  assert.equal(calls(), "");
});
