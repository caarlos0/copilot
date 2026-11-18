const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { mkdtemp, mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");

const example = readFileSync(join(__dirname, "factory.example.json"), "utf8");
const factoryFile = "owner.repo-factory.json";

async function home(t, ...dirs) {
  const directory = await mkdtemp(join(tmpdir(), "factory-state-dir-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const dir of dirs) await mkdir(join(directory, ".local/state", dir), { recursive: true });
  return directory;
}

const state = (directory, dir) => join(directory, ".local/state", dir);
const stateDir = () => import("./state-dir.mjs");

test("lists only the new directory when neither exists", async (t) => {
  const directory = await home(t);
  assert.deepEqual((await stateDir()).stateDirectories(directory), [state(directory, "copilot-factory")]);
});

test("lists only the legacy directory when only it exists", async (t) => {
  const directory = await home(t, "copilot-coordinator");
  assert.deepEqual((await stateDir()).stateDirectories(directory), [state(directory, "copilot-coordinator")]);
});

test("lists the new directory first when both exist", async (t) => {
  const directory = await home(t, "copilot-coordinator", "copilot-factory");
  assert.deepEqual((await stateDir()).stateDirectories(directory),
    [state(directory, "copilot-factory"), state(directory, "copilot-coordinator")]);
});

test("a file only in the legacy directory resolves there", async (t) => {
  const directory = await home(t, "copilot-coordinator", "copilot-factory");
  await writeFile(join(state(directory, "copilot-coordinator"), factoryFile), example);
  assert.equal((await stateDir()).stateFile(factoryFile, directory), join(state(directory, "copilot-coordinator"), factoryFile));
});

test("a file only in the new directory resolves there", async (t) => {
  const directory = await home(t, "copilot-coordinator", "copilot-factory");
  await writeFile(join(state(directory, "copilot-factory"), factoryFile), example);
  assert.equal((await stateDir()).stateFile(factoryFile, directory), join(state(directory, "copilot-factory"), factoryFile));
});

test("the new directory wins for a file in both", async (t) => {
  const directory = await home(t, "copilot-coordinator", "copilot-factory");
  for (const dir of ["copilot-coordinator", "copilot-factory"]) {
    await writeFile(join(state(directory, dir), factoryFile), example);
  }
  assert.equal((await stateDir()).stateFile(factoryFile, directory), join(state(directory, "copilot-factory"), factoryFile));
});

test("a new file belongs in the new directory", async (t) => {
  const directory = await home(t, "copilot-coordinator");
  assert.equal((await stateDir()).stateFile(factoryFile, directory), join(state(directory, "copilot-factory"), factoryFile));
});

async function dashboard(t, directory) {
  const child = spawn(process.execPath, [join(__dirname, "serve.mjs"), "--port", "0"], {
    env: { ...process.env, HOME: directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => {
    child.kill();
    await closed;
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) resolve(match[0]);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (code) => reject(new Error(`Server exited ${code}: ${stderr}`)));
  });
}

const withProject = (project) => JSON.stringify({ ...JSON.parse(example), project });

test("the dashboard lists the factories of both directories, the new one winning a clash", async (t) => {
  const directory = await home(t, "copilot-coordinator", "copilot-factory");
  const legacy = state(directory, "copilot-coordinator");
  const current = state(directory, "copilot-factory");
  await writeFile(join(legacy, "legacy.repo-factory.json"), withProject("legacy/repo"));
  await writeFile(join(legacy, factoryFile), withProject("legacy/clash"));
  await writeFile(join(current, factoryFile), withProject("new/clash"));
  await writeFile(join(current, "new.repo-factory.json"), withProject("new/repo"));
  const url = await dashboard(t, directory);
  const listing = await (await fetch(new URL("/api/factories", url))).json();
  assert.deepEqual(listing.factories.map((item) => item.file).sort(),
    ["legacy.repo-factory.json", "new.repo-factory.json", factoryFile]);
  assert.equal(listing.factories.find((item) => item.file === factoryFile).project, "new/clash");
  assert.equal(listing.errors.length, 0);
  const served = await (await fetch(new URL(`/api/factory?file=${factoryFile}`, url))).json();
  assert.equal(served.project, "new/clash");
});

test("the dashboard serves and writes a factory that lives in the legacy directory", async (t) => {
  const directory = await home(t, "copilot-coordinator", "copilot-factory");
  const file = join(state(directory, "copilot-coordinator"), factoryFile);
  await writeFile(file, example);
  await writeFile(join(state(directory, "copilot-coordinator"), "owner.repo-issue-9-implementation-brief.md"), "# The brief\n");
  const url = await dashboard(t, directory);
  const served = await fetch(new URL(`/api/factory?file=${factoryFile}`, url));
  assert.equal(served.status, 200);
  assert.equal((await served.json()).project, "owner/repo");
  const artifact = await fetch(new URL("/api/artifact?file=" + factoryFile + "&name=owner.repo-issue-9-implementation-brief.md", url));
  assert.equal(await artifact.text(), "# The brief\n");
  const moved = await fetch(new URL(`/api/move?file=${factoryFile}`, url), {
    method: "POST",
    headers: { Origin: new URL(url).origin, "Content-Type": "application/json" },
    body: JSON.stringify({ task: "issue-5", state: "initial", comment: "This is now unblocked.", revision: 0 }),
  });
  assert.equal(moved.status, 200);
  const written = JSON.parse(await readFile(file, "utf8"));
  assert.equal(written.tasks.find((task) => task.id === "issue-5").state, "initial");
  await assert.rejects(readFile(join(state(directory, "copilot-factory"), factoryFile)), { code: "ENOENT" });
});

test("the cached factory follows the file when it moves between directories", async (t) => {
  const directory = await home(t, "copilot-coordinator", "copilot-factory");
  const legacy = join(state(directory, "copilot-coordinator"), factoryFile);
  const current = join(state(directory, "copilot-factory"), factoryFile);
  await writeFile(legacy, withProject("legacy/repo"));
  const url = await dashboard(t, directory);
  const path = `/api/factory?file=${factoryFile}`;
  const first = await fetch(new URL(path, url));
  const tag = first.headers.get("etag");
  assert.equal((await first.json()).project, "legacy/repo");
  assert.equal((await fetch(new URL(path, url), { headers: { "If-None-Match": tag } })).status, 304);

  await writeFile(current, withProject("new/repo"));
  const moved = await fetch(new URL(path, url), { headers: { "If-None-Match": tag } });
  assert.equal(moved.status, 200);
  assert.notEqual(moved.headers.get("etag"), tag);
  assert.equal((await moved.json()).project, "new/repo");

  await rm(current);
  const back = await fetch(new URL(path, url));
  assert.equal((await back.json()).project, "legacy/repo");
});
