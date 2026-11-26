import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import hooks from "../hooks.json" with { type: "json" };

const factory = join(import.meta.dirname, "..", "skills", "lifecycle", "factory.mjs");

const home = mkdtempSync(join(tmpdir(), "guard-home-"));
const scratch = mkdtempSync(join(tmpdir(), "guard-tmp-"));
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});
mkdirSync(join(home, ".local/state/copilot-coordinator"), { recursive: true });
mkdirSync(join(home, ".local/state/copilot-factory"), { recursive: true });
symlinkSync(join(home, ".local"), join(scratch, "link-to-state"));

const env = { PATH: process.env.PATH, HOME: home, TMPDIR: scratch, FACTORY_COORDINATOR: "1" };

function run(payload: unknown) {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const out = spawnSync("node", [factory, "hook", "guard"], { input, encoding: "utf8", env });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout ? JSON.parse(out.stdout) : null;
}

const bash = (command: string) => run({ toolName: "bash", toolArgs: { command }, cwd: home });
const write = (toolName: string, path: string) => run({ toolName, toolArgs: { path, file_text: "x" }, cwd: home });

function denied(out: any, rule: string) {
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
    ["rex window new -s s -- copilot --model claude-sonnet-5.5 --autopilot -i 'x'", "copilot-autopilot"],
    ["bash -c 'gh pr merge 1'", "gh-pr-merge"],
    ["copilot --model claude-sonnet-5.5 --deny-tool='shell(git stash)' --autopilot -i x", "copilot-autopilot"],
    [`echo "$(gh pr merge 1)"`, "gh-pr-merge"],
    ["echo `gh pr merge 1`", "gh-pr-merge"],
    ["node /p/factory.mjs broker wait /f.json --since 1 &", "waiter-async-bash"],
    ["node /p/factory.mjs broker wait /f.json --since 1 2>&1 &", "waiter-async-bash"],
    ["cd /r && node /p/factory.mjs broker wait /f.json & disown", "waiter-async-bash"],
    ["nohup node /p/factory.mjs broker wait /f.json", "waiter-async-bash"],
    ["setsid node /p/factory.mjs broker wait /f.json", "waiter-async-bash"],
    ["node /p/factory.mjs broker wait /f.json > /dev/null", "waiter-async-bash"],
    ["node /p/factory.mjs broker wait /f.json >$TMPDIR/w.json 2>&1", "waiter-async-bash"],
    ["node /p/factory.mjs broker wait /f.json &> out.txt", "waiter-async-bash"],
    ["sh -c 'node /p/factory.mjs broker wait /f.json &'", "waiter-async-bash"],
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
    "copilot --yolo -i 'Read b and do it.'",
    "copilot --model claude-opus-5.5 --reasoning-effort high -i 'x'",
    "rex window new -s s --json T -- copilot --yolo -i 'x'",
    "rex window new -s s -- sh -c 'cd w && copilot -i x'",
    "copilot instruction list",
    "copilot --version",
    "rex window new -s s -- copilot --agent coding:caarlos0 --model claude-sonnet-5.5 --yolo --sandbox -i 'x'",
    "copilot --model claude-sonnet-5.5 --deny-tool='shell(git stash)' --deny-tool='shell(rex window:*)' -i 'x'",
    `rex window new -c "$(echo "$WT" | jq -r .path)" -- env FACTORY_TASK=x copilot --model claude-sonnet-5.5 --yolo -i "b"`,
    "echo gh pr merge is forbidden",
    "node /p/factory.mjs broker wait /f.json --since 1 --exclude-source coordinator --due",
    "node /p/factory.mjs broker wait /f.json 2>&1",
    "node /p/factory.mjs broker wait /f.json 2>/dev/null",
    "node /p/factory.mjs broker wait /f.json --since 1 --due",
    "node /p/factory.mjs broker emit /f.json worker.result & node /p/factory.mjs broker armed /f.json",
    "node /p/factory.mjs broker cursor /f.json > $TMPDIR/c.json",
    "git status && node /p/factory.mjs broker armed /f.json",
    "echo nohup node /p/factory.mjs broker wait",
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

function hook(envOverride: Record<string, string>, payload: unknown) {
  return spawnSync("/bin/bash", ["-c", entry.bash], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: scratch, ...envOverride },
  });
}

const merge = { toolName: "bash", toolArgs: { command: "gh pr merge 1" }, cwd: home };

const lockDir = join(scratch, "owner.repo-factory.lock");
const factoryEnv = { PLUGIN_ROOT: join(import.meta.dirname, ".."), FACTORY_FILE: join(scratch, "owner.repo-factory.json") };
const owned = { ...merge, sessionId: "coordinator-session" };

test("hooks.json runs the guard unless FACTORY_COORDINATOR=0", () => {
  assert.ok(entry.timeoutSec > 0 && entry.timeoutSec <= 30);
  const off = hook({ ...factoryEnv, FACTORY_COORDINATOR: "0", PATH: "/nonexistent" }, merge);
  assert.equal(off.status, 0);
  assert.equal(off.stdout, "");
  const on = hook({ ...factoryEnv, FACTORY_COORDINATOR: "1" }, merge);
  assert.equal(on.status, 0, on.stderr);
  denied(JSON.parse(on.stdout), "gh-pr-merge");
});

test("without the variable, only the session recorded in the owner lock is guarded", () => {
  const guarded = (payload: unknown, extra: Record<string, string> = {}) => {
    const out = hook({ ...factoryEnv, ...extra }, payload);
    assert.equal(out.status, 0, out.stderr);
    return out.stdout ? JSON.parse(out.stdout) : null;
  };
  assert.equal(guarded(owned), null, "no lock");
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ copilot_session: "coordinator-session" }));
  denied(guarded(owned), "gh-pr-merge");
  denied(guarded({ ...merge, session_id: "coordinator-session" }), "gh-pr-merge");
  assert.equal(guarded({ ...merge, sessionId: "other-session" }), null, "lock of another session");
  assert.equal(guarded(merge), null, "payload without a session");
  assert.equal(guarded(owned, { FACTORY_COORDINATOR: "0" }), null, "explicit off");
  denied(guarded({ ...merge, sessionId: "other-session" }, { FACTORY_COORDINATOR: "1" }), "gh-pr-merge");
  rmSync(lockDir, { recursive: true });
});

test("reads the plain-text owner file of an older lock", () => {
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, "owner"), "session coordinator-session pane block:1\n");
  const out = hook(factoryEnv, owned);
  assert.equal(out.status, 0, out.stderr);
  denied(JSON.parse(out.stdout), "gh-pr-merge");
  rmSync(lockDir, { recursive: true });
});

test("hooks.json allows when the plugin root is unknown", () => {
  const out = hook({ FACTORY_COORDINATOR: "1" }, merge);
  assert.equal(out.status, 0);
  assert.equal(out.stdout, "");
  assert.match(out.stderr, /plugin root not found/);
});

const worktree = join(home, "worktrees", "task-a");
mkdirSync(join(worktree, "plugins/factory/skills/lifecycle"), { recursive: true });
mkdirSync(join(worktree, "plugins/coding"), { recursive: true });

function runWith(extraEnv: Record<string, string>, payload: unknown) {
  const out = spawnSync("node", [factory, "hook", "guard"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: scratch, ...extraEnv },
  });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout ? JSON.parse(out.stdout) : null;
}

function deniedWithPath(out: any, expectedPath: string) {
  denied(out, "no-relative-escape");
  assert.ok(
    out.permissionDecisionReason.endsWith(`Use the absolute path ${expectedPath} instead.`),
    `expected reason to end with absolute path ${expectedPath}, got: ${out.permissionDecisionReason}`,
  );
}

test("no-relative-escape allows paths inside cwd and plain absolute paths", () => {
  const workerEnv = { FACTORY_TASK: "task-a", FACTORY_ROLE: "implementation" };
  const allowedTools = [
    { toolName: "view", toolArgs: { path: "plugins/factory/../coding/README.md" } },
    { toolName: "view", toolArgs: { path: `${worktree}/plugins/factory/../coding/README.md` } },
    { toolName: "view", toolArgs: { path: "/etc/hosts" } },
    { toolName: "view", toolArgs: { path: join(scratch, "out.diff") } },
    { toolName: "view", toolArgs: { path: "$TMPDIR/out.diff" } },
    { toolName: "view", toolArgs: { path: "$TMPDIR_OTHER/a/../b" } },
    { toolName: "edit", toolArgs: { path: "plugins/factory/../coding/README.md" } },
    { toolName: "create", toolArgs: { path: "a/b/../c.ts" } },
    { toolName: "grep", toolArgs: { paths: ["plugins/factory/../coding", join(scratch, "logs")] } },
    { toolName: "glob", toolArgs: { paths: "plugins/factory/../coding" } },
    { toolName: "apply_patch", toolArgs: { input: "*** Update File: plugins/factory/../coding/a.ts\n" } },
  ];
  for (const call of allowedTools) {
    assert.equal(runWith(workerEnv, { ...call, cwd: worktree }), null, JSON.stringify(call));
  }

  // When TMPDIR itself is inside cwd, $TMPDIR/a/../b stays inside cwd.
  assert.equal(
    runWith(
      { ...workerEnv, TMPDIR: join(worktree, "tmp") },
      { toolName: "view", toolArgs: { path: "$TMPDIR/a/../b" }, cwd: worktree },
    ),
    null,
  );

  const allowedBash = [
    "cat plugins/factory/../coding/README.md",
    "ls a/b/../c",
    `cat ${join(scratch, "out.diff")}`,
    'cat "$TMPDIR/out.diff"',
    "git diff main..HEAD",
    "git log origin/main...HEAD -- plugins/factory",
    'git commit -s -m "fix(factory): stop ../../foo escapes"',
    'gh pr create --title "Deny ../ escapes" --body "Stops ../../foo paths"',
    "rg '../' plugins/factory",
    "rg -e '../' plugins/factory",
    "jq --arg msg '../foo' '.x = $msg' file.json",
    'echo "Wrong: ../../../../$TMPDIR/out.diff"',
    "git status # never use ../..",
    `cat <<'EOF' > "$TMPDIR/brief.md"\nWrong: ../../../../$TMPDIR/out.diff\n$(cat ../outside)\nRight: /var/folders/xx/T/out.diff\nEOF`,
    "cd plugins/factory && bun run build",
  ];
  for (const command of allowedBash) {
    assert.equal(
      runWith(workerEnv, { toolName: "bash", toolArgs: { command }, cwd: worktree }),
      null,
      command,
    );
  }
});

test("no-relative-escape denies escaping paths and names the absolute path", () => {
  const workerEnv = { FACTORY_TASK: "task-a", FACTORY_ROLE: "implementation" };
  const resolvedScratch = resolve(scratch);

  const fileCases: Array<[unknown, string]> = [
    [{ toolName: "view", toolArgs: { path: "../other/file.ts" } }, resolve(worktree, "../other/file.ts")],
    [{ toolName: "view", toolArgs: { path: ".." } }, resolve(worktree, "..")],
    [
      { toolName: "view", toolArgs: { path: `${worktree}/../../../../../../var/folders` } },
      resolve(worktree, "../../../../../../var/folders"),
    ],
    [
      { toolName: "view", toolArgs: { path: "/Users/carlos/.copilot/session-state/abc/../../../../../..$TMPDIR/engine-settings.diff" } },
      resolve(resolvedScratch, "engine-settings.diff"),
    ],
    [{ toolName: "edit", toolArgs: { path: "../other/file.ts" } }, resolve(worktree, "../other/file.ts")],
    [{ toolName: "create", toolArgs: { path: "../../../../$TMPDIR/out.diff" } }, resolve(resolvedScratch, "out.diff")],
    [{ toolName: "view", toolArgs: { path: "../../../../${TMPDIR}/out.diff" } }, resolve(resolvedScratch, "out.diff")],
    [{ toolName: "view", toolArgs: { path: "..$TMPDIR/out.diff" } }, resolve(resolvedScratch, "out.diff")],
    [{ toolName: "view", toolArgs: { path: "$TMPDIR/a/../b" } }, resolve(resolvedScratch, "b")],
    [{ toolName: "view", toolArgs: { path: "$HOME/../shared/x" } }, resolve(home, "../shared/x")],
    [{ toolName: "grep", toolArgs: { paths: ["plugins/factory", "../other"] } }, resolve(worktree, "../other")],
    [{ toolName: "glob", toolArgs: { paths: "../other" } }, resolve(worktree, "../other")],
    [
      { toolName: "apply_patch", toolArgs: { input: "*** Update File: ../other/a.ts\n" } },
      resolve(worktree, "../other/a.ts"),
    ],
    [
      { toolName: "apply_patch", toolArgs: { input: "*** Update File: src/a.ts\n*** Move to: ../other/a.ts\n" } },
      resolve(worktree, "../other/a.ts"),
    ],
  ];
  for (const [call, expected] of fileCases) {
    deniedWithPath(runWith(workerEnv, { ...(call as object), cwd: worktree }), expected);
  }

  const bashCases: Array<[string, string]> = [
    ["cd ..", resolve(worktree, "..")],
    ["(cd ..)", resolve(worktree, "..")],
    ["(cd plugins); cat ../outside", resolve(worktree, "../outside")],
    ["../other/check.sh", resolve(worktree, "../other/check.sh")],
    ["cd plugins/factory/skills/lifecycle && cd ../../../..", worktree],
    ['cd "$TMPDIR" && cd gt && cd ..', resolvedScratch],
    ['cat "../../../../$TMPDIR/out.diff"', resolve(resolvedScratch, "out.diff")],
    ["cat ../../../../${TMPDIR}/out.diff", resolve(resolvedScratch, "out.diff")],
    ["git -C ../.. status", resolve(worktree, "../..")],
    ["git -C../outside status", resolve(worktree, "../outside")],
    ["cp -t ../out file", resolve(worktree, "../out")],
    ["cp -p ../src dst", resolve(worktree, "../src")],
    ["rg -q needle ../outside", resolve(worktree, "../outside")],
    ["rg --files ../outside", resolve(worktree, "../outside")],
    ["echo hi > ../out.txt", resolve(worktree, "../out.txt")],
    ["echo hi >| ../out.txt", resolve(worktree, "../out.txt")],
    ["cat < ../in.txt", resolve(worktree, "../in.txt")],
    ["sh -c 'cat ../secret'", resolve(worktree, "../secret")],
    ['echo "$(cat ../secret)"', resolve(worktree, "../secret")],
    [`cat <<EOF\n$(cat ../outside)\nEOF`, resolve(worktree, "../outside")],
  ];
  for (const [command, expected] of bashCases) {
    deniedWithPath(runWith(workerEnv, { toolName: "bash", toolArgs: { command }, cwd: worktree }), expected);
  }

  // Coordinator also gets no-relative-escape (before write-boundary for $TMPDIR via ..).
  deniedWithPath(
    run({ toolName: "create", toolArgs: { path: "../../../../$TMPDIR/note.txt" }, cwd: worktree }),
    resolve(resolvedScratch, "note.txt"),
  );
  deniedWithPath(
    run({ toolName: "bash", toolArgs: { command: "git -C ../../../.. rev-parse" }, cwd: worktree }),
    resolve(worktree, "../../../.."),
  );
});

test("guard applies only no-relative-escape to factory workers and skips unrelated sessions", () => {
  const file = join(scratch, "worker-gate-factory.json");
  writeFileSync(
    file,
    JSON.stringify({
      tasks: [{ id: "t1", workers: { implementation: { session: "worker-session-1" } } }],
      rules: [{ id: "r1", worker: { session: "rule-worker-session-1" } }],
    }),
  );
  const baseEnv = { PLUGIN_ROOT: join(import.meta.dirname, ".."), FACTORY_FILE: file };
  const callHook = (extra: Record<string, string>, payload: unknown) => {
    const out = hook({ ...baseEnv, ...extra }, payload);
    assert.equal(out.status, 0, out.stderr);
    return out.stdout ? JSON.parse(out.stdout) : null;
  };

  const escapeBash = { toolName: "bash", toolArgs: { command: "cd .." }, cwd: worktree };
  const workerMerge = { toolName: "bash", toolArgs: { command: "gh pr merge 1" }, cwd: worktree };
  const workerSubagent = { toolName: "task", toolArgs: {}, cwd: worktree };
  const workerEdit = { toolName: "edit", toolArgs: { path: "src/a.ts" }, cwd: worktree };

  // Worker via FACTORY_TASK / FACTORY_ROLE: gets no-relative-escape only.
  const workerEnvs: Record<string, string>[] = [{ FACTORY_TASK: "t1" }, { FACTORY_ROLE: "implementation" }];
  for (const extra of workerEnvs) {
    deniedWithPath(callHook(extra, escapeBash), resolve(worktree, ".."));
    assert.equal(callHook(extra, workerMerge), null, "workers can run gh pr merge");
    assert.equal(callHook(extra, workerSubagent), null, "workers can use subagents");
    assert.equal(callHook(extra, workerEdit), null, "workers can edit product files");
  }

  // Worker via workers.*.session or rules[].worker.session (both sessionId and session_id).
  for (const key of ["sessionId", "session_id"]) {
    for (const sid of ["worker-session-1", "rule-worker-session-1"]) {
      deniedWithPath(callHook({}, { ...escapeBash, [key]: sid }), resolve(worktree, ".."));
      assert.equal(callHook({}, { ...workerMerge, [key]: sid }), null);
      assert.equal(callHook({}, { ...workerEdit, [key]: sid }), null);
    }
  }

  // FACTORY_COORDINATOR=0 disables guard for workers too; =1 enables coordinator rules.
  assert.equal(callHook({ FACTORY_ROLE: "implementation", FACTORY_COORDINATOR: "0" }, escapeBash), null);
  denied(callHook({ FACTORY_ROLE: "implementation", FACTORY_COORDINATOR: "1" }, workerMerge), "gh-pr-merge");

  // Unrelated session outside factory is untouched.
  assert.equal(callHook({}, { ...escapeBash, sessionId: "unrelated-session" }), null);
  assert.equal(callHook({}, escapeBash), null);
});
