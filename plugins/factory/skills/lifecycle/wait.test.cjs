const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdtemp, readFile, rename, rm, unlink, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const script = join(__dirname, "wait.mjs");

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "coordinator-wait-test-"));
  const children = [];
  t.after(async () => {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.all(children.map(({ finished }) => finished));
    await rm(directory, { recursive: true, force: true });
  });
  const cursor = join(directory, "cursor.json");
  const first = join(directory, "first-result.json");
  const second = join(directory, "second-result.json");
  async function replace(file, content) {
    const temporary = `${file}.next`;
    await writeFile(temporary, content);
    await rename(temporary, file);
  }
  async function start(files = [first, second]) {
    const child = spawn(process.execPath, [script, "--cursor", cursor, ...files], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const finished = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    children.push({ child, finished });
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (stderr.includes("Watching result files.\n")) resolve();
      });
      child.once("error", reject);
      child.once("close", (code) => reject(new Error(`Waiter exited ${code}: ${stderr}`)));
    });
    return async () => {
      const result = await finished;
      assert.equal(result.code, 0, JSON.stringify(result));
      assert.equal(result.signal, null, JSON.stringify(result));
      assert.equal(result.stderr, "Watching result files.\n");
      return JSON.parse(result.stdout);
    };
  }
  return { directory, cursor, first, second, replace, start };
}

test("collects changes made before arming and persists their exact content hashes",
  { timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    await f.replace(f.first, '{"pr":"created"}');
    await f.replace(f.second, '{"review":"published"}');
    const finish = await f.start();
    assert.deepEqual(await finish(), { changed: [f.first, f.second] });
    const cursor = JSON.parse(await readFile(f.cursor, "utf8"));
    assert.deepEqual(cursor, {
      [f.first]: createHash("sha256").update('{"pr":"created"}').digest("hex"),
      [f.second]: createHash("sha256").update('{"review":"published"}').digest("hex"),
    });
  });

test("wakes on atomic creation and replacement, ignores unchanged contents, and catches rearm gaps",
  { timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    let finish = await f.start();
    await f.replace(f.first, '{"pr":"created"}');
    assert.deepEqual(await finish(), { changed: [f.first] });

    finish = await f.start();
    await f.replace(f.first, '{"pr":"created"}');
    await f.replace(f.second, '{"review":"published"}');
    assert.deepEqual(await finish(), { changed: [f.second] });

    await f.replace(f.first, '{"pr":"created","merged":true}');
    finish = await f.start();
    assert.deepEqual(await finish(), { changed: [f.first] });

    finish = await f.start();
    await f.replace(f.first, '{"pr":"created","merged":true,"verified":true}');
    assert.deepEqual(await finish(), { changed: [f.first] });
  });

test("reports deletion once and detects recreation with the same contents",
  { timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    await f.replace(f.first, "published");
    let finish = await f.start();
    await finish();

    finish = await f.start();
    await unlink(f.first);
    assert.deepEqual(await finish(), { changed: [f.first] });
    assert.equal(JSON.parse(await readFile(f.cursor, "utf8"))[f.first], null);

    finish = await f.start();
    await f.replace(f.second, "another worker");
    assert.deepEqual(await finish(), { changed: [f.second] });

    finish = await f.start();
    await f.replace(f.first, "published");
    assert.deepEqual(await finish(), { changed: [f.first] });
  });

test("help and invalid usage have distinct stdout, stderr, and exit contracts", () => {
  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: node wait\.mjs --cursor FILE RESULT/);
  assert.equal(help.stderr, "");
  for (const args of [[], ["--unknown"], ["--cursor"], ["--cursor", "same", "same"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2, JSON.stringify({ args, ...result }));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Run with --help for usage/);
  }
});

test("cursor, watch, result-read, and cursor-write failures exit without a success event",
  { timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    const cases = [
      { cursor: f.cursor, file: join(f.directory, "missing", "result.json"), error: /ENOENT/ },
      { cursor: f.cursor, file: f.directory, error: /EISDIR/ },
      { cursor: f.cursor, file: f.first, content: "[]", error: /expected an object/ },
      { cursor: f.cursor, file: f.first, content: "{", error: /JSON|property name/ },
      { cursor: join(f.directory, "missing", "cursor.json"), file: f.first, error: /ENOENT/ },
    ];
    await f.replace(f.first, "published");
    for (const item of cases) {
      await f.replace(f.cursor, item.content ?? "{}");
      const result = spawnSync(process.execPath,
        [script, "--cursor", item.cursor, item.file],
        { encoding: "utf8", timeout: 2000 });
      assert.equal(result.status, 1, JSON.stringify({ item, ...result }));
      assert.equal(result.stdout, "");
      assert.match(result.stderr, item.error);
    }
  });
