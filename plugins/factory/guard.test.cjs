const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync, symlinkSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { after, test } = require("node:test");

const hooks = require("./hooks.json");
const guard = join(__dirname, "hooks", "guard.mjs");

const home = mkdtempSync(join(tmpdir(), "guard-home-"));
const scratch = mkdtempSync(join(tmpdir(), "guard-tmp-"));
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});
mkdirSync(join(home, ".local/state/copilot-coordinator"), { recursive: true });
mkdirSync(join(home, ".local/state/copilot-factory"), { recursive: true });
symlinkSync(join(home, ".local"), join(scratch, "link-to-state"));

const env = { PATH: process.env.PATH, HOME: home, TMPDIR: scratch };

function run(payload) {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const out = spawnSync("node", [guard], { input, encoding: "utf8", env });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout ? JSON.parse(out.stdout) : null;
}

const bash = (command) => run({ toolName: "bash", toolArgs: { command }, cwd: home });
const write = (toolName, path) => run({ toolName, toolArgs: { path, file_text: "x" }, cwd: home });

function denied(out, rule) {
  assert.equal(out?.permissionDecision, "deny", JSON.stringify(out));
  assert.match(out.permissionDecisionReason, new RegExp(`^factory guard rule ${rule}:`));
}

test("denies subagent and workflow tools", () => {
  for (const toolName of ["task", "read_agent", "write_agent", "run_dynamic_workflow"]) {
    denied(run({ toolName, toolArgs: {}, cwd: home }), "no-subagents");
  }
  assert.equal(run({ toolName: "list_agents", toolArgs: {}, cwd: home }), null);
});

test("denies bash rule breaks and names the rule", () => {
  const cases = [
    ["gh pr merge 12 --squash", "gh-pr-merge"],
    ["gh -R o/r pr merge 12", "gh-pr-merge"],
    ["git merge feature", "git-merge-ff-only"],
    ["git -C /repo merge --no-ff feature", "git-merge-ff-only"],
    ["git merge --ff-only a && git merge b", "git-merge-ff-only"],
    ["rex new", "rex-session"],
    ["rex session rename x", "rex-session"],
    ["copilot --autopilot -i 'Read b and do it.'", "copilot-autopilot"],
    ["copilot --model claude-sonnet-5.5 --autopilot -i 'x'", "copilot-autopilot"],
    ["copilot --yolo -i 'Read b and do it.'", "copilot-model"],
    ["copilot --model claude-opus-5.5 -i 'x'", "copilot-model"],
    ["rex window new -s s --json T -- copilot --yolo -i 'x'", "copilot-model"],
    ["rex window new -s s -- sh -c 'cd w && copilot -i x'", "copilot-model"],
    ["rex window new -s s -- copilot --model claude-sonnet-5.5 --autopilot -i 'x'", "copilot-autopilot"],
    ["bash -c 'gh pr merge 1'", "gh-pr-merge"],
  ];
  for (const [command, rule] of cases) denied(bash(command), rule);
});

test("allows near misses", () => {
  const allowed = [
    "gh pr view 12",
    "gh pr list --json number",
    "gh pr checks 12",
    "git merge --ff-only feature",
    "git -C /repo merge --ff-only feature",
    "git merge-base main feature",
    "git log --oneline",
    "git commit -m 'merge things'",
    "rex ls --json",
    "rex session ls",
    "rex window new -s s --focus=false --json T -- copilot --model claude-sonnet-5.5 -i 'Read b and do it.'",
    "copilot --model=claude-sonnet-5.5 -i 'x'",
    "copilot instruction list",
    "copilot --version",
    "rex window new -s s -- copilot --agent coding:caarlos0 --model claude-sonnet-5.5 --yolo --sandbox -i 'x'",
    "echo gh pr merge is forbidden",
    "ls",
  ];
  for (const command of allowed) assert.equal(bash(command), null, command);
});

test("denies edits outside the state directories and $TMPDIR", () => {
  for (const toolName of ["edit", "create"]) {
    denied(write(toolName, join(home, "repo/src/a.js")), "write-boundary");
    denied(write(toolName, "relative.js"), "write-boundary");
    denied(write(toolName, join(scratch, "../escape.js")), "write-boundary");
    denied(write(toolName, join(home, ".local/state/copilot-factory/../../x")), "write-boundary");
    denied(write(toolName, join(home, ".local/state/other/x")), "write-boundary");
  }
  denied(
    run({ toolName: "apply_patch", toolArgs: { input: "*** Begin Patch\n*** Update File: /etc/hosts\n" }, cwd: home }),
    "write-boundary",
  );
});

test("allows edits inside the state directories and $TMPDIR", () => {
  for (const toolName of ["edit", "create"]) {
    assert.equal(write(toolName, join(home, ".local/state/copilot-coordinator/briefs/b.md")), null);
    assert.equal(write(toolName, join(home, ".local/state/copilot-factory/x-factory.json")), null);
    assert.equal(write(toolName, join(scratch, "new/dir/file")), null);
    assert.equal(write(toolName, "~/.local/state/copilot-factory/y.md"), null);
    assert.equal(write(toolName, join(scratch, "link-to-state/state/copilot-factory/z")), null);
  }
  assert.equal(
    run({ toolName: "apply_patch", toolArgs: { input: `*** Update File: ${scratch}/a\n` }, cwd: home }),
    null,
  );
});

test("allows unrelated tools and fails open on bad input", () => {
  assert.equal(run({ toolName: "view", toolArgs: { path: "/etc/hosts" }, cwd: home }), null);
  assert.equal(run({ toolName: "bash", toolArgs: {}, cwd: home }), null);
  assert.equal(run("not json"), null);
  assert.equal(run(""), null);
  assert.equal(run({ toolName: "bash", toolArgs: "{broken", cwd: home }), null);
});

const [entry] = hooks.hooks.preToolUse;

function hook(envOverride, payload) {
  return spawnSync("/bin/bash", ["-c", entry.bash], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: scratch, ...envOverride },
  });
}

const merge = { toolName: "bash", toolArgs: { command: "gh pr merge 1" }, cwd: home };

test("hooks.json gates the guard on FACTORY_COORDINATOR=1", () => {
  assert.ok(entry.timeoutSec > 0 && entry.timeoutSec <= 30);
  const root = { PLUGIN_ROOT: __dirname };
  for (const gate of [{}, { FACTORY_COORDINATOR: "0" }, { FACTORY_COORDINATOR: "" }]) {
    const out = hook({ ...root, ...gate }, merge);
    assert.equal(out.status, 0);
    assert.equal(out.stdout, "");
  }
  const out = hook({ ...root, FACTORY_COORDINATOR: "1" }, merge);
  assert.equal(out.status, 0, out.stderr);
  denied(JSON.parse(out.stdout), "gh-pr-merge");
});

test("hooks.json allows when the plugin root is unknown", () => {
  const out = hook({ FACTORY_COORDINATOR: "1" }, merge);
  assert.equal(out.status, 0);
  assert.equal(out.stdout, "");
  assert.match(out.stderr, /plugin root not found/);
});
