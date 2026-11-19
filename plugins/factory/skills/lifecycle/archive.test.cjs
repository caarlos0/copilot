const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { mkdir, mkdtemp, readdir, rm, truncate, utimes, writeFile } = require("node:fs/promises");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");

const script = join(__dirname, "archive.mjs");
const example = JSON.parse(readFileSync(join(__dirname, "factory.example.json"), "utf8"));
const resolvedTask = example.tasks.find((task) => task.state === "resolved");
const openTask = example.tasks.find((task) => task.state === "initial");
const daysAgo = (days) => new Date(Date.now() - days * 86_400_000);

const task = (template, id, patch = {}) => ({ ...template, id, issue: null, pr: null, links: [], ...patch });
const resolved = (id, days, patch = {}) =>
  task(resolvedTask, id, { updated_at: daysAgo(days).toISOString(), ...patch });

async function fixture(t, tasks, archived = []) {
  const directory = await mkdtemp(join(tmpdir(), "factory-archive-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "owner.repo-factory.json");
  await writeFile(file, JSON.stringify({ ...example, tasks }));
  if (archived.length) {
    const archive = join(directory, "owner.repo-factory-archive");
    await mkdir(archive);
    await writeFile(join(archive, "2026-01-01.json"), JSON.stringify({
      format: "factory-archive/v1", project: example.project, day: "2026-01-01", tasks: archived,
    }));
  }
  const put = async (name, age = 30) => {
    const path = join(directory, name);
    await writeFile(path, "x");
    await utimes(path, daysAgo(age), daysAgo(age));
    return path;
  };
  const clean = (...args) => {
    const result = spawnSync(process.execPath, [script, "clean", file, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const names = async () => (await readdir(directory)).sort();
  return { directory, put, clean, names };
}

const artifacts = (id) => [
  `owner.repo-${id}-investigation-brief.md`,
  `owner.repo-${id}-implementation-brief.md`,
  `owner.repo-${id}-implementation-brief.97447fb3.md`,
  `owner.repo-${id}-implementation-result.json`,
  `owner.repo-${id}-implementation-result.1f2b7f9d.json`,
];

test("dry run lists the artifacts of old resolved tasks and deletes nothing", async (t) => {
  const f = await fixture(t, [resolved("old", 20), resolved("fresh", 3)]);
  for (const name of [...artifacts("old"), ...artifacts("fresh")]) await f.put(name);
  const before = await f.names();
  const result = f.clean();
  assert.equal(result.run, false);
  assert.deepEqual(result.tasks, ["old"]);
  assert.deepEqual(result.delete.map((item) => item.path.split("/").pop()).sort(), artifacts("old").sort());
  assert.deepEqual(await f.names(), before);
});

test("--run deletes the files and the instructions directory of old tasks only", async (t) => {
  const f = await fixture(t, [resolved("old", 20), resolved("fresh", 3), resolved("old-2", 20)]);
  for (const name of [...artifacts("old"), ...artifacts("fresh")]) await f.put(name);
  for (const name of ["owner.repo-old-implementation-instructions", "owner.repo-fresh-implementation-instructions"]) {
    await mkdir(join(f.directory, name));
    await writeFile(join(f.directory, name, "AGENTS.md"), "rules");
    await utimes(join(f.directory, name), daysAgo(30), daysAgo(30));
  }
  await f.put("owner.repo-old-2-implementation-brief.md");
  await f.put("owner.repo-old-2x-implementation-brief.md");
  await f.put("owner.repo-factory-events.jsonl");
  await f.clean("--run");
  const left = await f.names();
  assert.deepEqual(left.filter((name) => name.includes("-old-implementation") || name.includes("-old-investigation")), []);
  assert.ok(artifacts("fresh").every((name) => left.includes(name)));
  assert.ok(left.includes("owner.repo-fresh-implementation-instructions"));
  assert.ok(left.includes("owner.repo-old-2x-implementation-brief.md"), "a longer task ID is a different task");
  assert.ok(!left.includes("owner.repo-old-2-implementation-brief.md"));
  assert.ok(left.includes("owner.repo-factory-events.jsonl"));
});

test("--older-than moves the threshold", async (t) => {
  const f = await fixture(t, [resolved("mid", 5)]);
  await f.put("owner.repo-mid-implementation-brief.md");
  assert.deepEqual(f.clean().tasks, []);
  assert.deepEqual(f.clean("--older-than", "3d").tasks, ["mid"]);
  assert.deepEqual(f.clean("--older-than", "96h").tasks, ["mid"]);
});

test("archived tasks are cleaned unless a live task has the same ID", async (t) => {
  const f = await fixture(t, [resolved("back", 1)], [resolved("gone", 40), resolved("back", 40)]);
  await f.put("owner.repo-gone-implementation-brief.md");
  await f.put("owner.repo-back-implementation-brief.md");
  assert.deepEqual(f.clean().tasks, ["gone"]);
});

test("protects open tasks, pending feedback, referenced files and recent files", async (t) => {
  const feedback = { id: "f1", acknowledged_id: null };
  const f = await fixture(t, [
    task(openTask, "open"),
    resolved("pending", 40, { feedback }),
    resolved("old", 40),
  ]);
  await f.put("owner.repo-open-implementation-brief.md");
  await f.put("owner.repo-pending-implementation-brief.md");
  await f.put("owner.repo-old-implementation-brief.md", 0.5);
  await f.put("owner.repo-old-implementation-result.json");
  const result = f.clean("--run");
  assert.deepEqual(result.delete.map((item) => item.path.split("/").pop()), ["owner.repo-old-implementation-result.json"]);
  assert.deepEqual(result.kept.map((item) => item.reason), ["modified in the last 24 hours"]);
  assert.deepEqual(await f.names().then((names) => names.filter((name) => name.endsWith(".md") || name.endsWith("result.json"))), [
    "owner.repo-old-implementation-brief.md",
    "owner.repo-open-implementation-brief.md",
    "owner.repo-pending-implementation-brief.md",
  ]);
});

test("an open task that references a file keeps it", async (t) => {
  const reference = "owner.repo-old-implementation-result.json";
  const f = await fixture(t, [
    task(openTask, "open", { details: { evidence: reference } }),
    resolved("old", 40),
  ]);
  await f.put(reference);
  const result = f.clean("--run");
  assert.deepEqual(result.delete, []);
  assert.equal(result.kept[0].reason, "referenced by an open task");
  assert.ok((await f.names()).includes(reference));
});

test("reports large unreferenced files as stale-large and never deletes them", async (t) => {
  const f = await fixture(t, [task(openTask, "open", { details: { evidence: "owner.repo-kept.bin" } })]);
  const big = async (name, age) => {
    const path = await f.put(name, age);
    await truncate(path, 101 * 1024 * 1024);
    await utimes(path, daysAgo(age), daysAgo(age));
    return path;
  };
  const stale = await big("staging-old.tmp", 10);
  await big("owner.repo-kept.bin", 10);
  await big("staging-new.tmp", 0.1);
  await f.put("small.tmp");
  const result = f.clean("--run");
  assert.deepEqual(result["stale-large"].map((item) => item.path), [stale]);
  assert.ok((await f.names()).includes("staging-old.tmp"));
});
