const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { mkdtemp, readFile, readdir, rm, stat, writeFile } = require("node:fs/promises");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");

const script = join(__dirname, "handoff.mjs");
const example = JSON.parse(readFileSync(join(__dirname, "handoff.example.json"), "utf8"));

async function fixture(t, data = example, now) {
  const directory = await mkdtemp(join(tmpdir(), "coordinator-handoff-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "project-coordinator.json");
  if (data !== null) await writeFile(file, JSON.stringify(data));
  const nodeArgs = now === undefined ? [] : [
    "--import", `data:text/javascript,${encodeURIComponent(`
      import { mock } from "node:test";
      mock.timers.enable({ apis: ["Date"], now: ${Date.parse(now)} });
    `)}`,
  ];
  return {
    directory,
    file,
    read: async () => JSON.parse(await readFile(file, "utf8")),
    run: (...args) => spawnSync(process.execPath, [...nodeArgs, script, file, ...args], { encoding: "utf8" }),
  };
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

const createArgs = [
  "--project", "owner/repository",
  "--role", "coordinator",
  "--run-goal", "Coordinate work",
];

test("creates private handoffs from flags and validates the root project and role", async (t) => {
  const f = await fixture(t, null);
  const started = Date.now();
  success(f.run(...createArgs));
  const data = await f.read();
  assert.equal(data.id, "project-coordinator");
  assert.equal(data.project, "owner/repository");
  assert.equal(data.role, "coordinator");
  assert.equal(data.goal, "Coordinate work");
  assert.equal(data.status, "active");
  assert.deepEqual(data.tasks, []);
  assert.ok(Date.parse(data.updated_at) >= started, data.updated_at);
  assert.ok(Date.parse(data.updated_at) <= Date.now(), data.updated_at);
  const { validate } = await import("./board-data.mjs");
  validate(data);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(f.directory), ["project-coordinator.json"]);
});

test("adds and updates tasks without repeating the handoff project or losing task data", async (t) => {
  const f = await fixture(t);
  const original = await f.read();
  const started = Date.now();
  success(f.run(
    "--task", "task-1",
    "--status", "running",
    "--worker", "block:123",
    "--details", '{"mode":"continuous"}',
  ));
  success(f.run(
    "--task", "new",
    "--goal", "New work",
    "--status", "pending",
    "--next-action", "Assign",
  ));
  const data = await f.read();
  assert.equal(data.project, "owner/repository");
  assert.equal(data.tasks.length, 2);
  assert.equal(data.tasks[0].repository, undefined);
  assert.equal(data.tasks[0].status, "running");
  assert.equal(data.tasks[0].worker, "block:123");
  assert.deepEqual(data.tasks[0].details, { ...original.tasks[0].details, mode: "continuous" });
  assert.deepEqual(data.tasks[1], {
    id: "new",
    goal: "New work",
    status: "pending",
    next_action: "Assign",
    updated_at: data.tasks[1].updated_at,
  });
  assert.ok(Date.parse(data.tasks[1].updated_at) >= started, data.tasks[1].updated_at);
  assert.ok(Date.parse(data.tasks[1].updated_at) <= Date.now(), data.tasks[1].updated_at);
  assert.ok(Date.parse(data.updated_at) >= started, data.updated_at);
  const { validate } = await import("./board-data.mjs");
  validate(data);
});

test("adding a task removes only existing done tasks older than seven days and keeps artifact files", async (t) => {
  const initial = structuredClone(example);
  initial.tasks = [
    ["expired", "done", "2026-11-01T18:00:00Z"],
    ["expired-edge", "done", "2026-11-09T17:59:59.999Z"],
    ["cutoff", "done", "2026-11-09T15:00:00-03:00"],
    ["recent", "done", "2026-11-10T18:00:00Z"],
    ...["pending", "running", "verifying", "blocked"].map((status) => [
      status, status, "2026-11-01T18:00:00Z",
    ]),
  ].map(([id, status, updated_at]) => ({ ...example.tasks[0], id, status, updated_at }));
  initial.tasks[0].brief = "expired-brief.md";
  initial.tasks[0].result = "expired-result.json";
  const f = await fixture(t, initial, "2026-11-16T18:00:00Z");
  await writeFile(join(f.directory, "expired-brief.md"), "Saved brief");
  await writeFile(join(f.directory, "expired-result.json"), '{"evidence":"Saved result"}');
  success(f.run(
    "--task", "new",
    "--goal", "Backfill completed work",
    "--status", "done",
    "--next-action", "None",
    "--updated-at", "2000-01-01T00:00:00Z",
    "--task-updated-at", "2000-01-01T00:00:00Z",
  ));
  const data = await f.read();
  assert.deepEqual(data.tasks.map((task) => task.id), [
    "cutoff", "recent", "pending", "running", "verifying", "blocked", "new",
  ]);
  assert.deepEqual(data.tasks.slice(0, -1), initial.tasks.slice(2));
  assert.equal(data.tasks.at(-1).updated_at, "2000-01-01T00:00:00Z");
  assert.equal(await readFile(join(f.directory, "expired-brief.md"), "utf8"), "Saved brief");
  assert.equal(await readFile(join(f.directory, "expired-result.json"), "utf8"), '{"evidence":"Saved result"}');
});

test("task cleanup does not run on updates or failed additions and does not hide invalid saved tasks", async (t) => {
  const initial = structuredClone(example);
  initial.tasks[0].status = "done";
  const f = await fixture(t, initial, "2026-11-16T18:00:00Z");
  success(f.run("--run-status", "paused"));
  assert.deepEqual((await f.read()).tasks, initial.tasks);
  success(f.run(
    "--task", "task-1", "--goal", "Updated goal",
    "--task-updated-at", initial.tasks[0].updated_at,
  ));
  assert.deepEqual((await f.read()).tasks, [{ ...initial.tasks[0], goal: "Updated goal" }]);
  const original = await readFile(f.file, "utf8");
  const incomplete = f.run("--task", "new", "--goal", "Incomplete");
  assert.equal(incomplete.status, 1, incomplete.stderr);
  assert.equal(incomplete.stdout, "");
  assert.match(incomplete.stderr, /task.next_action/);
  assert.equal(await readFile(f.file, "utf8"), original);

  const corrupt = await f.read();
  corrupt.tasks[0].worker = "";
  const invalidState = JSON.stringify(corrupt);
  await writeFile(f.file, invalidState);
  const invalid = f.run("--task", "new", "--goal", "New work", "--status", "pending", "--next-action", "Assign");
  assert.equal(invalid.status, 1, invalid.stderr);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /task.worker/);
  assert.equal(await readFile(f.file, "utf8"), invalidState);
});

test("updates run fields, accepts explicit timestamps, and clears nullable task fields", async (t) => {
  const f = await fixture(t);
  success(f.run("--run-status", "paused", "--updated-at", "2026-11-06T08:00:00-03:00"));
  assert.equal((await f.read()).updated_at, "2026-11-06T08:00:00-03:00");
  success(f.run(
    "--task", "task-1",
    "--worker", "null",
    "--blocker", "null",
    "--task-updated-at", "2026-11-06T07:00:00-03:00",
  ));
  const data = await f.read();
  assert.equal(data.status, "paused");
  assert.notEqual(data.updated_at, "2026-11-06T08:00:00-03:00");
  assert.equal(data.tasks[0].worker, null);
  assert.equal(data.tasks[0].blocker, null);
  assert.equal(data.tasks[0].updated_at, "2026-11-06T07:00:00-03:00");
  success(f.run("--task", "task-1", "--details", '{"evidence":["first","second"]}'));
  assert.deepEqual((await f.read()).tasks[0].details.evidence, ["first", "second"]);
});

test("blocker text is allowed only while a task is blocked and must be cleared on transition", async (t) => {
  const f = await fixture(t);
  success(f.run("--task", "task-1", "--status", "blocked", "--blocker", "Needs approval"));
  const blocked = await readFile(f.file, "utf8");
  for (const status of ["pending", "running", "verifying", "done"]) {
    const result = f.run("--task", "task-1", "--status", status);
    assert.equal(result.status, 1, JSON.stringify({ taskStatus: status, ...result }));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /task-1.*blocker.*blocked/);
    assert.equal(await readFile(f.file, "utf8"), blocked);
  }
  success(f.run("--task", "task-1", "--status", "running", "--blocker", "null"));
  const data = await f.read();
  assert.equal(data.tasks[0].status, "running");
  assert.equal(data.tasks[0].blocker, null);
});

test("saves multiple issue and PR links, preserves omitted links, and replaces or clears them", async (t) => {
  const f = await fixture(t);
  const links = [
    "https://github.com/owner/repository/issues/42",
    "https://github.com/owner/repository/pull/43",
    "https://github.com/other/repository/issues/7",
  ];
  success(f.run("--task", "task-1", "--links", JSON.stringify(links)));
  assert.deepEqual((await f.read()).tasks[0].links, links);
  success(f.run("--task", "task-1", "--status", "running", "--pr", links[1]));
  const data = await f.read();
  assert.deepEqual(data.tasks[0].links, links);
  assert.equal(data.tasks[0].pr, links[1]);
  success(f.run("--task", "task-1", "--links", JSON.stringify([links[2]])));
  assert.deepEqual((await f.read()).tasks[0].links, [links[2]]);
  success(f.run("--task", "task-1", "--links", "[]"));
  assert.deepEqual((await f.read()).tasks[0].links, []);
});

test("rejects invalid flags without changing the saved file", async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.file, "utf8");
  const cases = [
    [["--task", "task-1", "--worker", ""], /task.worker must be a non-empty string/],
    [["--task", "task-1", "--blocker", ""], /task.blocker must be a non-empty string/],
    [["--task", "task-1", "--blocker", "Needs approval"], /task-1.*blocker.*blocked/],
    [["--task", "task-1", "--status", "idle"], /Unknown status/],
    [["--task", "task-1", "--brief", "/absolute/brief.md"], /filename in the state directory/],
    [["--task", "task-1", "--pr", "https://example.com/o/r/pull/1"], /pr must be an HTTPS GitHub issue or pull request URL/],
    [["--task", "task-1", "--pr", "https://github.com/o/r/issues/1"], /pr must be an HTTPS GitHub pull request URL/],
    [["--task", "task-1", "--links", "{}"], /task.links must be an array/],
    [["--task", "task-1", "--links", "["], /JSON/],
    [["--task", "task-1", "--links", '["javascript:alert(1)"]'], /HTTPS GitHub issue or pull request URL/],
    [["--task", "task-1", "--links", '["https://github.com/o/r/issues/no-number"]'], /HTTPS GitHub issue or pull request URL/],
    [["--task", "task-1", "--links", '["https://github.com/o/r/commit/123"]'], /HTTPS GitHub issue or pull request URL/],
    [["--task", "task-1", "--links", '["https://user@github.com/o/r/issues/1"]'], /HTTPS GitHub issue or pull request URL/],
    [["--task", "task-1", "--links", "[42]"], /task.links\[\] must be a non-empty string/],
    [["--task", "task-1", "--details", "[]"], /--details must be a JSON object/],
    [["--task", "new", "--goal", "Incomplete"], /task.next_action must be a non-empty string/],
    [["--goal", "No task ID"], /Task options require --task ID/],
  ];
  for (const [args, error] of cases) {
    const result = f.run(...args);
    assert.equal(result.status, args[0] === "--goal" ? 2 : 1, JSON.stringify({ args, ...result }));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, error);
    assert.equal(await readFile(f.file, "utf8"), original);
    assert.deepEqual(await readdir(f.directory), ["project-coordinator.json"]);
  }
});

test("requires complete fields when creating a handoff or task", async (t) => {
  const f = await fixture(t, null);
  for (const args of [
    ["--role", "coordinator", "--run-goal", "Goal"],
    ["--project", "owner/repo", "--run-goal", "Goal"],
    ["--project", "owner/repo", "--role", "coordinator"],
  ]) {
    const result = f.run(...args);
    assert.equal(result.status, 1, JSON.stringify({ args, ...result }));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /require --project, --role, and --run-goal/);
    assert.deepEqual(await readdir(f.directory), []);
  }
  success(f.run(...createArgs));
  const original = await readFile(f.file, "utf8");
  for (const args of [
    ["--task", "new"],
    ["--task", "new", "--goal", "Goal"],
    ["--task", "new", "--status", "pending"],
    ["--task", "new", "--next-action", "Assign"],
  ]) {
    const result = f.run(...args);
    assert.equal(result.status, 1, JSON.stringify({ args, ...result }));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /task\.(goal|status|next_action)/);
    assert.equal(await readFile(f.file, "utf8"), original);
  }
});

test("repairs an invalid worker without dropping other tasks; reads legacy task repositories", async (t) => {
  const initial = structuredClone(example);
  initial.tasks[0].worker = "";
  initial.tasks[0].repository = "legacy/repo";
  initial.tasks.push({ ...structuredClone(initial.tasks[0]), id: "other", worker: null });
  const f = await fixture(t, initial);
  success(f.run("--task", "task-1", "--worker", "null"));
  const data = await f.read();
  assert.equal(data.tasks[0].worker, null);
  assert.equal(data.tasks[0].repository, "legacy/repo");
  assert.equal(data.tasks[1].repository, "legacy/repo");
  assert.deepEqual(data.tasks[1].details, initial.tasks[1].details);
});

test("rejects corrupt and ambiguous saved state rather than replacing it", async (t) => {
  const f = await fixture(t, null);
  for (const content of [
    "{", "null", "[]",
    JSON.stringify({ ...example, tasks: null }),
    JSON.stringify({ ...example, project: undefined, tasks: [{ ...example.tasks[0], repository: undefined }] }),
    JSON.stringify({ ...example, tasks: [null] }),
    JSON.stringify({ ...example, tasks: [{ goal: "lost id" }] }),
    JSON.stringify({ ...example, tasks: [example.tasks[0], example.tasks[0]] }),
  ]) {
    await writeFile(f.file, content);
    const result = f.run("--run-goal", "New goal");
    assert.equal(result.status, 1, JSON.stringify({ content, ...result }));
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.startsWith(`${f.file}: `), result.stderr);
    assert.equal(await readFile(f.file, "utf8"), content);
    assert.deepEqual(await readdir(f.directory), ["project-coordinator.json"]);
  }
});

test("conflicts and publish failures preserve concurrent state and remove staged files", async (t) => {
  const replacement = JSON.stringify({ ...example, goal: "Concurrent work" });
  const cases = [
    { name: "changed", action: `await fs.writeFile(file, ${JSON.stringify(replacement)})`, expected: replacement },
    {
      name: "appeared",
      action: `await fs.writeFile(file, ${JSON.stringify(replacement)})`,
      expected: replacement,
      args: createArgs,
    },
    { name: "removed", action: "await fs.unlink(file)", expected: null },
    { name: "rename failed", expected: JSON.stringify(example) },
  ];
  for (const item of cases) {
    await t.test(item.name, async (t) => {
      const f = await fixture(t, item.name === "appeared" ? null : example);
      const hook = `
        import fs from "node:fs/promises";
        import { syncBuiltinESMExports } from "node:module";
        const file = process.argv[2];
        const read = fs.readFile;
        let reads = 0;
        ${item.action ? `
          fs.readFile = async (...args) => {
            if (args[0] === file && ++reads === 2) { ${item.action}; }
            return read(...args);
          };
        ` : `
          fs.rename = async () => { throw new Error("injected rename failure"); };
        `}
        syncBuiltinESMExports();
      `;
      const result = spawnSync(process.execPath, [
        "--import", `data:text/javascript,${encodeURIComponent(hook)}`, script, f.file,
        ...(item.args ?? ["--task", "task-1", "--status", "running"]),
      ], { encoding: "utf8" });
      assert.equal(result.status, 1, JSON.stringify(result));
      assert.equal(result.stdout, "");
      assert.match(result.stderr, item.action ? /changed during update/ : /injected rename failure/);
      if (item.expected === null) {
        assert.deepEqual(await readdir(f.directory), []);
      } else {
        assert.equal(await readFile(f.file, "utf8"), item.expected);
        assert.deepEqual(await readdir(f.directory), ["project-coordinator.json"]);
      }
    });
  }
});

test("CLI help, usage, missing files, and dash-prefixed paths have stable streams and exits", async (t) => {
  const f = await fixture(t, null);
  const invoke = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  for (const args of [["--help"], ["-h"]]) {
    const result = invoke(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--next-action VALUE/);
    assert.equal(result.stderr, "");
    assert.deepEqual(await readdir(f.directory), []);
  }
  for (const args of [[], [f.file], [f.file, "--unknown"], [f.file, "--task"]]) {
    const result = invoke(...args);
    assert.equal(result.status, 2, JSON.stringify({ args, ...result }));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /--help/);
    assert.deepEqual(await readdir(f.directory), []);
  }
  const withoutTask = invoke(f.file, "--links", "[]");
  assert.equal(withoutTask.status, 2, withoutTask.stderr);
  assert.equal(withoutTask.stdout, "");
  assert.match(withoutTask.stderr, /Task options require --task ID/);
  const missingPath = join(f.directory, "missing", "run.json");
  const missing = spawnSync(process.execPath, [
    script, missingPath, ...createArgs,
  ], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ENOENT/);
  const dashFile = join(f.directory, "-run.json");
  const dash = spawnSync(process.execPath, [script, ...createArgs, "--", dashFile], { encoding: "utf8" });
  success(dash);
  assert.equal((await readFile(dashFile, "utf8")).includes('"project": "owner/repository"'), true);
});
