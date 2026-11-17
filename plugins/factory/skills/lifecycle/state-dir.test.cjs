const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");

const example = readFileSync(join(__dirname, "factory.example.json"), "utf8");

async function home(t, ...dirs) {
  const directory = await mkdtemp(join(tmpdir(), "factory-state-dir-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const dir of dirs) await mkdir(join(directory, ".local/state", dir), { recursive: true });
  return directory;
}

const resolveIn = async (directory) => (await import("./state-dir.mjs")).stateDirectory(directory);

test("defaults to the new directory when neither exists", async (t) => {
  const directory = await home(t);
  assert.equal(await resolveIn(directory), join(directory, ".local/state/copilot-factory"));
});

test("falls back to the legacy directory when only it exists", async (t) => {
  const directory = await home(t, "copilot-coordinator");
  assert.equal(await resolveIn(directory), join(directory, ".local/state/copilot-coordinator"));
});

test("the new directory wins when both exist", async (t) => {
  const directory = await home(t, "copilot-coordinator", "copilot-factory");
  assert.equal(await resolveIn(directory), join(directory, ".local/state/copilot-factory"));
});

test("the dashboard lists factories from the legacy directory", async (t) => {
  const directory = await home(t, "copilot-coordinator");
  await writeFile(join(directory, ".local/state/copilot-coordinator/owner.repo-factory.json"), example);
  const child = spawn(process.execPath, [join(__dirname, "serve.mjs"), "--port", "0"], {
    env: { ...process.env, HOME: directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => {
    child.kill();
    await closed;
  });
  const url = await new Promise((resolve, reject) => {
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
  const listing = await (await fetch(new URL("/api/factories", url))).json();
  assert.deepEqual(listing.factories.map((item) => item.file), ["owner.repo-factory.json"]);
});
