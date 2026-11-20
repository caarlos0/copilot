import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";

const script = join(import.meta.dirname, "archive.mjs");
const example = JSON.parse(readFileSync(join(import.meta.dirname, "factory.example.json"), "utf8"));
const resolvedTask = example.tasks.find((task: { state: string }) => task.state === "resolved");
const openTask = example.tasks.find((task: { state: string }) => task.state === "initial");
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

const task = (template: object, id: string, patch: Record<string, unknown> = {}) => ({ ...template, id, issue: null, pr: null, links: [], ...patch });
const resolved = (id: string, days: number, patch: Record<string, unknown> = {}) =>
  task(resolvedTask, id, { updated_at: daysAgo(days).toISOString(), ...patch });

async function fixture(t: TestContext, tasks: unknown[], archived: unknown[] = [], running: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "factory-archive-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "owner.repo-factory.json");
  await writeFile(file, JSON.stringify({
    ...example,
    tasks,
    rules: example.rules.map((rule: { id: string; worker: object }) => running.includes(rule.id)
      ? { ...rule, worker: { ...rule.worker, status: "running" } } : rule),
  }));
  if (archived.length) {
    const archive = join(directory, "owner.repo-factory-archive");
    await mkdir(archive);
    await writeFile(join(archive, "2026-01-01.json"), JSON.stringify({
      format: "factory-archive/v1", project: example.project, day: "2026-01-01", tasks: archived,
    }));
  }
  const put = async (name: string, age = 30) => {
    const path = join(directory, name);
    await writeFile(path, "x");
    await utimes(path, daysAgo(age), daysAgo(age));
    return path;
  };
  const clean = (...args: string[]) => {
    const result = spawnSync(process.execPath, [script, "clean", file, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const names = async () => (await readdir(directory)).sort();
  return { directory, put, clean, names };
}

const artifacts = (id: string) => [
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
  assert.deepEqual(result.delete.map((item: { path: string }) => item.path.split("/").pop()).sort(), artifacts("old").sort());
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
  assert.deepEqual(result.delete.map((item: { path: string }) => item.path.split("/").pop()), ["owner.repo-old-implementation-result.json"]);
  assert.deepEqual(result.kept.map((item: { reason: string }) => item.reason), ["modified in the last 24 hours"]);
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
  const big = async (name: string, age: number) => {
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
  assert.deepEqual(result["stale-large"].map((item: { path: string }) => item.path), [stale]);
  assert.ok((await f.names()).includes("staging-old.tmp"));
});

test("a large file named only by another factory file is not stale-large", async (t) => {
  const f = await fixture(t, [task(openTask, "open")]);
  const big = async (name: string) => {
    const path = await f.put(name, 10);
    await truncate(path, 101 * 1024 * 1024);
    await utimes(path, daysAgo(10), daysAgo(10));
    return path;
  };
  const stale = await big("unreferenced.tmp");
  await big("referenced.tmp");
  await writeFile(join(f.directory, "other.repo-factory.json"), JSON.stringify({ note: "referenced.tmp" }));
  assert.deepEqual(f.clean()["stale-large"].map((item: { path: string }) => item.path), [stale]);
});

const basename = (item: { path: string }) => item.path.split("/").pop();

test("lists rule briefs and results of rules with no running worker by file age", async (t) => {
  const f = await fixture(t, [task(openTask, "open")]);
  const old = [
    "owner.repo-find-more-brief.md",
    "owner.repo-find-more-brief.3f2a.md",
    "owner.repo-find-more-result.json",
    "owner.repo-find-more-result.3f2a.json",
    "owner.repo-self-improve-result.json",
  ];
  for (const name of old) await f.put(name, 20);
  await f.put("owner.repo-find-more-brief.9.md", 3);
  await f.put("owner.repo-find-more-metrics.json", 20);
  await f.put("owner.repo-find-more-1-implementation-brief.md", 20);
  const before = await f.names();
  const dry = f.clean();
  assert.deepEqual(dry.delete.map(basename).sort(), old.sort());
  assert.deepEqual(dry.rules, ["find-more", "self-improve"]);
  assert.deepEqual(dry.counts, { rule: 5 });
  assert.deepEqual(await f.names(), before);
  assert.deepEqual(f.clean("--older-than", "2d", "--run").counts, { rule: 6 });
  const left = await f.names();
  assert.ok(left.includes("owner.repo-find-more-metrics.json"));
  assert.ok(left.includes("owner.repo-find-more-1-implementation-brief.md"));
  assert.ok(!left.includes("owner.repo-find-more-brief.9.md"));
});

test("keeps the files of a rule with a running worker", async (t) => {
  const f = await fixture(t, [task(openTask, "open")], [], ["find-more"]);
  await f.put("owner.repo-find-more-result.json", 20);
  await f.put("owner.repo-find-more-brief.md", 20);
  await f.put("owner.repo-self-improve-brief.md", 20);
  const result = f.clean("--run");
  assert.deepEqual(result.delete.map(basename), ["owner.repo-self-improve-brief.md"]);
  assert.deepEqual((await f.names()).filter((name) => name.includes("find-more")), [
    "owner.repo-find-more-brief.md",
    "owner.repo-find-more-result.json",
  ]);
});

test("a worker scratch file that an open task names is kept", async (t) => {
  const f = await fixture(t, [task(openTask, "open", { details: { evidence: "completion1-1-named.json" } })]);
  await f.put("completion1-1-named.json", 20);
  await f.put("completion1-1-other.json", 20);
  assert.deepEqual(f.clean().delete.map(basename), ["completion1-1-other.json"]);
  assert.equal(f.clean().kept[0].reason, "referenced by an open task");
});

test("lists worker scratch files by file age only", async (t) => {
  const f = await fixture(t, [task(openTask, "open")]);
  const old = [
    "completion86-1926-pr-12-capture.txt",
    "completion86-1926-pr-12-task-update-request.json",
    "completion86-1926-pr-12-task-update-receipt.json",
    "discovery-839c93b7-2026-11-15T19-43-17-358Z-39224-reviews-stdout.json",
    "discovery-839c93b7-2026-11-15T19-43-17-358Z-39224-reviews-stderr.txt",
    "queue-839c93b7-3-batch-4.json",
  ];
  for (const name of old) await f.put(name, 20);
  await f.put("completion86-1926-pr-13-capture.txt", 0.5);
  await f.put("completion86-1926-pr-14-capture.txt", 5);
  await f.put("owner.repo-factory-events.jsonl", 20);
  await f.put("dashboard-token", 20);
  await mkdir(join(f.directory, "discovery1-1-instructions"));
  const result = f.clean("--run");
  assert.deepEqual(result.delete.map(basename).sort(), old.sort());
  assert.deepEqual(result.counts, { worker: 6 });
  assert.deepEqual(result.kept, []);
  assert.deepEqual(await f.names(), [
    "completion86-1926-pr-13-capture.txt",
    "completion86-1926-pr-14-capture.txt",
    "dashboard-token",
    "discovery1-1-instructions",
    "owner.repo-factory-events.jsonl",
    "owner.repo-factory.json",
  ]);
});
