const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { appendFile, chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } = require("node:fs/promises");
const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const { delimiter, join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");
const vm = require("node:vm");

const html = readFileSync(join(__dirname, "dashboard.html"), "utf8");
const example = JSON.parse(readFileSync(join(__dirname, "factory.example.json"), "utf8"));
const factoryFile = "owner.repo-factory.json";

async function server(t, env = {}) {
  const directory = await mkdtemp(join(tmpdir(), "factory-dashboard-test-"));
  const outside = await mkdtemp(join(tmpdir(), "factory-dashboard-outside-"));
  await writeFile(join(directory, factoryFile), JSON.stringify(example));
  await writeFile(join(directory, "owner.repo-issue-9-implementation-brief.md"), "# The brief\n");
  await writeFile(join(directory, "unrelated-notes.md"), "private\n");
  await writeFile(join(outside, "secret.md"), "secret\n");
  await symlink(join(outside, "secret.md"), join(directory, "owner.repo-issue-9-investigation-brief.md"));
  const child = spawn(process.execPath, [join(__dirname, "serve.mjs"), "--directory", directory, "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => {
    child.kill();
    await closed;
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
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
  return { directory, outside, url };
}

const get = async (base, path, init) => fetch(new URL(path, base), init);
const move = (url, body, file = factoryFile, headers = {}) => get(url, `/api/move?file=${encodeURIComponent(file)}`, {
  method: "POST",
  headers: { Origin: new URL(url).origin, "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const settings = (url, body, file = factoryFile, headers = {}) => get(url, `/api/settings?file=${encodeURIComponent(file)}`, {
  method: "POST",
  headers: { Origin: new URL(url).origin, "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const unblocked = { task: "issue-5", state: "initial", comment: "This is now unblocked.", revision: 0 };

test("serves the dashboard and the shared data module without caching", async (t) => {
  const { url } = await server(t);
  const page = await get(url, "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await page.text(), html);
  const data = await get(url, "/factory-data.mjs");
  assert.match(data.headers.get("content-type"), /text\/javascript/);
  assert.match(await data.text(), /export const states/);
});

test("lists valid factories with counts and reports invalid ones separately", async (t) => {
  const { url, directory, outside } = await server(t);
  await writeFile(join(directory, "broken.repo-factory.json"), "{bad");
  await writeFile(join(directory, "old-handoff.json"), JSON.stringify(example));
  await writeFile(join(outside, "outside.json"), JSON.stringify(example));
  await symlink(join(outside, "outside.json"), join(directory, "linked.repo-factory.json"));
  const listing = await (await get(url, "/api/factories")).json();
  assert.deepEqual(listing.factories.map((item) => item.file), [factoryFile]);
  assert.equal(listing.factories[0].project, "owner/repo");
  assert.equal(listing.factories[0].task_count, 5);
  assert.deepEqual(listing.factories[0].counts, {
    initial: 1, investigation: 0, implementation: 1, review: 1, blocked: 1, resolved: 1,
  });
  assert.deepEqual(listing.errors.map((item) => item.file), ["broken.repo-factory.json", "linked.repo-factory.json"]);
});

test("serves one validated factory and rejects other files", async (t) => {
  const { url, directory } = await server(t);
  const ok = await get(url, `/api/factory?file=${factoryFile}`);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).project, "owner/repo");
  for (const file of ["../owner.repo-factory.json", "unrelated-notes.md", "old-handoff.json", "missing.repo-factory.json", ""]) {
    const response = await get(url, `/api/factory?file=${encodeURIComponent(file)}`);
    assert.ok([400, 403, 404].includes(response.status), `${file}: ${response.status}`);
  }
  await writeFile(join(directory, "bad.repo-factory.json"), JSON.stringify({ ...example, tasks: [{ id: "x" }] }));
  assert.equal((await get(url, "/api/factory?file=bad.repo-factory.json")).status, 400);
});

test("an unchanged factory answers 304 without a body, and a write brings a new tag", async (t) => {
  const { url } = await server(t);
  const path = `/api/factory?file=${factoryFile}`;
  const first = await get(url, path);
  const tag = first.headers.get("etag");
  assert.match(tag, /^"[\w-]+"$/);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal((await first.json()).project, "owner/repo");

  const same = await get(url, path, { headers: { "If-None-Match": tag } });
  assert.equal(same.status, 304);
  assert.equal(same.headers.get("etag"), tag);
  assert.equal(same.headers.get("cache-control"), "no-store");
  assert.equal(await same.text(), "");

  assert.equal((await get(url, path, { headers: { "If-None-Match": '"other", ' + tag } })).status, 304);
  assert.equal((await get(url, path, { headers: { "If-None-Match": '"other"' } })).status, 200);

  assert.equal((await move(url, unblocked)).status, 200);
  const changed = await get(url, path, { headers: { "If-None-Match": tag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("etag"), tag);
  assert.equal((await changed.json()).tasks.find((task) => task.id === "issue-5").state, "initial");
});

test("the listing answers 304 until any file changes, and a broken file never poisons the cache", async (t) => {
  const { url, directory } = await server(t);
  const listed = () => get(url, "/api/factories");
  const conditional = (tag) => get(url, "/api/factories", { headers: { "If-None-Match": tag } });
  const first = await listed();
  const tag = first.headers.get("etag");
  assert.ok(tag);
  assert.equal((await conditional(tag)).status, 304);

  await writeFile(join(directory, "broken.repo-factory.json"), "{bad");
  const broken = await conditional(tag);
  assert.equal(broken.status, 200);
  const brokenTag = broken.headers.get("etag");
  assert.deepEqual((await broken.json()).errors.map((item) => item.file), ["broken.repo-factory.json"]);
  assert.equal((await conditional(brokenTag)).status, 304);
  assert.equal((await get(url, "/api/factory?file=broken.repo-factory.json")).status, 400);

  await writeFile(join(directory, "broken.repo-factory.json"), JSON.stringify({ ...example, project: "fixed/repo" }));
  const fixed = await conditional(brokenTag);
  assert.equal(fixed.status, 200);
  const listing = await fixed.json();
  assert.deepEqual(listing.errors, []);
  assert.deepEqual(listing.factories.map((item) => item.project).sort(), ["fixed/repo", "owner/repo"]);
  const served = await get(url, "/api/factory?file=broken.repo-factory.json");
  assert.equal(served.status, 200);
  assert.equal((await served.json()).project, "fixed/repo");
});

test("serves only artifacts that the selected factory references, inside the state directory", async (t) => {
  const { url } = await server(t);
  const artifact = (name) => get(url, `/api/artifact?file=${factoryFile}&name=${encodeURIComponent(name)}`);
  const ok = await artifact("owner.repo-issue-9-implementation-brief.md");
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "# The brief\n");
  const referenced = await artifact("owner.repo-find-more-result.json");
  assert.equal(referenced.status, 404, "A rule worker result is referenced; only the missing file fails.");
  assert.equal((await artifact("unrelated-notes.md")).status, 403);
  assert.equal((await artifact("../etc/passwd")).status, 403);
  const escaped = await artifact("owner.repo-issue-9-investigation-brief.md");
  assert.equal(escaped.status, 403);
  assert.doesNotMatch(await escaped.text(), /secret/);
});

test("moving back persists the comment, keeps worker context, and rejects a stale browser", async (t) => {
  const { url, directory } = await server(t);
  const response = await move(url, unblocked);
  assert.equal(response.status, 200, await response.clone().text());
  const data = await response.json();
  const task = data.tasks.find((item) => item.id === unblocked.task);
  assert.equal(task.state, "initial");
  assert.equal(task.blocker, null);
  assert.equal(task.revision, 1);
  assert.deepEqual(task.history.at(-1), {
    state: "initial", at: task.updated_at, note: unblocked.comment,
    source: "dashboard", feedback_id: task.feedback.id,
  });
  assert.equal(task.feedback.acknowledged_id, null);
  assert.deepEqual(JSON.parse(await readFile(join(directory, factoryFile), "utf8")), data);
  assert.deepEqual(await (await get(url, `/api/factory?file=${factoryFile}`)).json(), { ...data, attention: [] });
  const stale = await move(url, unblocked);
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /changed since it was read/);
  const review = example.tasks.find((item) => item.state === "review");
  const returned = await move(url, { ...unblocked, task: review.id, state: "investigation" });
  assert.equal(returned.status, 200, await returned.clone().text());
  const updated = (await returned.json()).tasks.find((item) => item.id === review.id);
  assert.deepEqual(updated.workers, review.workers);
  assert.deepEqual(updated.worktree, review.worktree);
  assert.equal(updated.pr, review.pr);
  assert.equal(updated.merge, null);
  assert.deepEqual((await readdir(directory)).sort(),
    [factoryFile, "owner.repo-factory-events.jsonl", "owner.repo-issue-9-implementation-brief.md", "owner.repo-issue-9-investigation-brief.md", "unrelated-notes.md"].sort());
});

test("the dashboard can resolve a task directly from every open state", async (t) => {
  const { update } = await import("./factory.mjs");
  for (const [state, outcome] of [
    ["initial", "completed"], ["investigation", "already-fixed"], ["implementation", "duplicate"],
    ["review", "invalid"], ["blocked", "cancelled"],
  ]) {
    await t.test(state, async (t) => {
      const { url, directory } = await server(t);
      const file = join(directory, factoryFile);
      let before = example.tasks.find((task) => task.state === (state === "investigation" ? "initial" : state));
      if (state === "investigation") {
        const data = await update(file, { task: before.id, state });
        before = data.tasks.find((task) => task.id === before.id);
      }
      const comment = `Resolve as ${outcome}; no further work is needed.`;
      const response = await move(url, {
        task: before.id, state: "resolved", resolution: outcome, comment, revision: before.revision ?? 0,
      });
      assert.equal(response.status, 200, await response.clone().text());
      const data = await response.json();
      const task = data.tasks.find((item) => item.id === before.id);
      assert.equal(task.state, "resolved");
      assert.equal(task.blocker, null);
      assert.deepEqual(task.resolution, { outcome, note: comment, at: task.updated_at });
      assert.equal(task.history.at(-1).note, comment);
      assert.equal(task.feedback.acknowledged_id, null);
      const closed = Object.fromEntries(Object.entries(before.workers).map(
        ([role, worker]) => [role, worker && { ...worker, status: "closed" }]));
      assert.deepEqual(task.workers, closed);
      assert.equal(task.pr, before.pr);
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), data);
    });
  }
});

test("CLI and dashboard share the write lock; overlapping moves cannot overwrite each other", async (t) => {
  const { url, directory } = await server(t);
  const file = join(directory, factoryFile);
  const original = await readFile(file, "utf8");
  await writeFile(`${file}.write.lock`, "", { flag: "wx" });
  const locked = await move(url, unblocked);
  assert.equal(locked.status, 409);
  const cli = spawnSync(process.execPath, [join(__dirname, "factory.mjs"), file,
    "--task", unblocked.task, "--state", "initial"], { encoding: "utf8" });
  assert.equal(cli.status, 1, cli.stderr);
  assert.match(cli.stderr, /write is locked/);
  assert.equal(await readFile(file, "utf8"), original);
  await rm(`${file}.write.lock`);
  const results = await Promise.all([move(url, unblocked), move(url, { ...unblocked, comment: "A competing direction" })]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const data = JSON.parse(await readFile(file, "utf8"));
  const task = data.tasks.find((item) => item.id === unblocked.task);
  assert.equal(task.history.filter((item) => item.source === "dashboard").length, 1);
  assert.equal(task.revision, 1);
});

test("move endpoint rejects foreign pages, invalid moves and unconfined files without writes", async (t) => {
  const { url, directory } = await server(t);
  const file = join(directory, factoryFile);
  const original = await readFile(file, "utf8");
  const cases = [
    { headers: { Origin: "https://evil.example" }, status: 403 },
    { headers: { Origin: "null" }, status: 403 },
    { headers: { "Sec-Fetch-Site": "cross-site" }, status: 403 },
    { headers: { "Content-Type": "text/plain" }, status: 415 },
    { body: { ...unblocked, comment: "x".repeat(20000) }, status: 413 },
    { body: { ...unblocked, comment: " " }, status: 400 },
    { body: { ...unblocked, revision: -1 }, status: 400 },
    { body: { ...unblocked, workers: {} }, status: 400 },
    { body: { ...unblocked, task: "missing" }, status: 404 },
    { body: { ...unblocked, state: "review" }, status: 400 },
    { body: { ...unblocked, state: "resolved" }, status: 400 },
    { body: { ...unblocked, state: "resolved", resolution: "unknown" }, status: 400 },
    { body: { ...unblocked, state: "resolved", resolution: "merged" }, status: 400 },
    { body: { ...unblocked, resolution: "completed" }, status: 400 },
    { body: { ...unblocked, task: "issue-3" }, status: 400 },
    { file: "../owner.repo-factory.json", status: 400 },
    { file: "unrelated-notes.md", status: 400 },
  ];
  for (const item of cases) {
    const response = await move(url, item.body ?? unblocked, item.file, item.headers);
    assert.equal(response.status, item.status, JSON.stringify({ item, body: await response.text() }));
    assert.equal(await readFile(file, "utf8"), original);
  }
});

const seen = {
  budget: 10,
  limits: { investigation: 3, implementation: 3 },
  lever: { spend: null, autonomy_cap: null },
};

test("the settings endpoint saves every section, returns the factory, and emits dashboard events", async (t) => {
  const { url, directory } = await server(t);
  const file = join(directory, factoryFile);
  const response = await settings(url, {
    set: { budget: 4, limits: { investigation: 2, implementation: 5 }, lever: { spend: "high", autonomy_cap: "L2" } },
    expected: seen,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const data = await response.json();
  assert.deepEqual(data.budget, { max_parallel_workers: 4 });
  assert.deepEqual(data.limits, { investigation: 2, implementation: 5 });
  assert.deepEqual(data.lever, { spend: "high", autonomy_cap: "L2" });
  assert.deepEqual(data.tasks, example.tasks);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), data);
  const events = (await readFile(join(directory, "owner.repo-factory-events.jsonl"), "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(events.map(({ type, task, source, data }) => [type, task, source, data]), [
    ["budget.updated", null, "dashboard", { max_parallel_workers: 4 }],
    ["limits.updated", null, "dashboard", { investigation: 2, implementation: 5 }],
    ["lever.updated", null, "dashboard", { spend: "high", autonomy_cap: "L2" }],
  ]);
  const cleared = await settings(url, {
    set: { lever: { spend: null } }, expected: { lever: { spend: "high" } },
  });
  assert.equal(cleared.status, 200, await cleared.clone().text());
  assert.deepEqual((await cleared.json()).lever, { spend: null, autonomy_cap: "L2" });
  const one = await settings(url, { set: { limits: { implementation: 1 } }, expected: { limits: { implementation: 5 } } });
  assert.deepEqual((await one.json()).limits, { investigation: 2, implementation: 1 });
});

test("each settings section reports a stale read as a conflict, and old files still save", async (t) => {
  const { url, directory } = await server(t);
  const file = join(directory, factoryFile);
  const original = await readFile(file, "utf8");
  const stale = [
    [{ budget: 5 }, { budget: 9 }, /Budget changed since it was read/],
    [{ limits: { investigation: 1 } }, { limits: { investigation: 2 } }, /limits changed since it was read/],
    [{ lever: { spend: "max" } }, { lever: { spend: "high" } }, /lever changed since it was read/],
  ];
  for (const [set, expected, message] of stale) {
    const response = await settings(url, { set, expected });
    assert.equal(response.status, 409, await response.clone().text());
    assert.match((await response.json()).error, message);
    assert.equal(await readFile(file, "utf8"), original);
  }
  const { budget: _, ...old } = example;
  await writeFile(file, JSON.stringify(old));
  assert.equal((await settings(url, { set: { budget: 5 }, expected: { budget: 4 } })).status, 409);
  const added = await settings(url, { set: { budget: 5, lever: { autonomy_cap: "L0" } }, expected: { budget: null, lever: { autonomy_cap: null } } });
  assert.equal(added.status, 200, await added.clone().text());
  const data = await added.json();
  assert.deepEqual(data.budget, { max_parallel_workers: 5 });
  assert.deepEqual(data.lever, { autonomy_cap: "L0" });
});

test("settings endpoint rejects foreign pages and bad input without writes", async (t) => {
  const { url, directory } = await server(t);
  const file = join(directory, factoryFile);
  const original = await readFile(file, "utf8");
  const good = { set: { budget: 4 }, expected: seen };
  const withSet = (set, expected = seen) => ({ set, expected });
  const cases = [
    { headers: { Origin: "https://evil.example" }, status: 403 },
    { headers: { "Sec-Fetch-Site": "cross-site" }, status: 403 },
    { headers: { "Content-Type": "text/plain" }, status: 415 },
    { body: { ...good, padding: "x".repeat(20000) }, status: 413 },
    { body: withSet({ budget: 0 }), status: 400 },
    { body: withSet({ budget: 101 }), status: 400 },
    { body: withSet({ budget: 1.5 }), status: 400 },
    { body: withSet({ budget: "4" }), status: 400 },
    { body: withSet({ limits: { investigation: 0 } }), status: 400 },
    { body: withSet({ limits: { implementation: 101 } }), status: 400 },
    { body: withSet({ limits: { investigation: 1.5 } }), status: 400 },
    { body: withSet({ limits: { review: 2 } }), status: 400 },
    { body: withSet({ limits: {} }), status: 400 },
    { body: withSet({ lever: { spend: "unlimited" } }), status: 400 },
    { body: withSet({ lever: { autonomy_cap: "L6" } }), status: 400 },
    { body: withSet({ lever: { autonomy_level: "L5" } }), status: 400 },
    { body: withSet({ lever: { grants: [] } }), status: 400 },
    { body: withSet({ autonomy_level: "L5" }), status: 400 },
    { body: withSet({ status: "active" }), status: 400 },
    { body: withSet({ rules: [] }), status: 400 },
    { body: withSet({}), status: 400 },
    { body: { expected: seen }, status: 400 },
    { body: { set: { budget: 4 } }, status: 400 },
    { body: withSet({ limits: { investigation: 1 } }, { limits: {} }), status: 400 },
    { body: withSet({ budget: 4 }, { budget: -1 }), status: 400 },
    { body: { ...good, max_parallel_workers: 4 }, status: 400 },
    { body: { max_parallel_workers: 4, expected: 10 }, status: 400 },
    { body: null, status: 400 },
    { file: "../owner.repo-factory.json", status: 400 },
    { file: "unrelated-notes.md", status: 400 },
  ];
  for (const item of cases) {
    const response = await settings(url, "body" in item ? item.body : good, item.file, item.headers);
    assert.equal(response.status, item.status, JSON.stringify({ item, body: await response.text() }));
    assert.equal(await readFile(file, "utf8"), original);
  }
});

test("the CLI and the dashboard share the write lock for settings writes", async (t) => {
  const { url, directory } = await server(t);
  const file = join(directory, factoryFile);
  const original = await readFile(file, "utf8");
  await writeFile(`${file}.write.lock`, "", { flag: "wx" });
  assert.equal((await settings(url, { set: { budget: 4 }, expected: seen })).status, 409);
  const cli = spawnSync(process.execPath, [join(__dirname, "factory.mjs"), file,
    "--budget", '{"max_parallel_workers":4}'], { encoding: "utf8" });
  assert.equal(cli.status, 1, cli.stderr);
  assert.match(cli.stderr, /write is locked/);
  assert.equal(await readFile(file, "utf8"), original);
});

test("a dashboard move emits an event the factory waiter wakes on", async (t) => {
  const { url, directory } = await server(t);
  const file = join(directory, factoryFile);
  const response = await move(url, unblocked);
  assert.equal(response.status, 200, await response.clone().text());
  const waited = spawnSync(process.execPath, [join(__dirname, "broker.mjs"), "wait", file,
    "--since", "0", "--exclude-source", "coordinator", "--timeout", "5"], { encoding: "utf8" });
  assert.equal(waited.status, 0, waited.stderr);
  const { events } = JSON.parse(waited.stdout);
  assert.ok(events.length > 0 && events.every((event) => event.source === "dashboard"), waited.stdout);
});

test("accepts only GET on loopback host names", async (t) => {
  const { url } = await server(t);
  assert.equal((await get(url, "/", { method: "POST" })).status, 405);
  assert.equal((await get(url, "/nope")).status, 404);
  const status = await new Promise((resolve, reject) => {
    const target = new URL(url);
    // A fresh agent ignores NODE_USE_ENV_PROXY, so the forged Host reaches the server.
    http.get({ agent: new http.Agent(), host: target.hostname, port: target.port, path: "/", headers: { Host: "evil.example" } },
      (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
  }).catch((error) => {
    // A sandbox can block direct loopback connections; any other error still fails.
    if (error.code === "EPERM" || error.code === "EACCES") return null;
    throw error;
  });
  if (status === null) return t.skip("The sandbox blocks direct loopback connections.");
  assert.equal(status, 403);
});

test("a 304 skips load and redraw", async (t) => {
  const answers = [];
  const ui = await dashboard(t, {
    fetchRequest: async (path, _, request) => {
      const response = await request();
      answers.push([path.split("?")[0], response.status]);
      return response;
    },
  });
  ui.run("let loads = 0; const original = load; load = (...args) => { loads += 1; return original(...args); }");
  answers.length = 0;

  await ui.run("refresh()");
  assert.deepEqual(answers, [["/api/factories", 304], ["/api/factory", 304]]);
  assert.equal(ui.run("loads"), 0);
  assert.equal(ui.get("factories").children.length, 1, "the sidebar keeps its last listing");

  const data = structuredClone(example);
  data.tasks.find((task) => task.id === "issue-5").title = "Changed title";
  await writeFile(join(ui.directory, factoryFile), JSON.stringify(data));
  answers.length = 0;
  await ui.run("refresh()");
  assert.deepEqual(answers, [["/api/factories", 200], ["/api/factory", 200]]);
  assert.equal(ui.run("loads"), 1);
  assert.equal(ui.run("snapshot.tasks.find((task) => task.id === 'issue-5').title"), "Changed title");

  answers.length = 0;
  await ui.run("refresh()");
  assert.deepEqual(answers, [["/api/factories", 304], ["/api/factory", 304]]);
  assert.equal(ui.run("loads"), 1);
});

test("a 304 still redraws the Find work countdowns", async (t) => {
  const ui = await dashboard(t, { now: Date.parse("2026-05-01T11:35:00Z") });
  const source = ui.get("flow").querySelector(".source");
  assert.equal(source.querySelector(".sub").textContent, "next in 25m");
  await source.fire("click");
  assert.match(ui.get("rule-list").children[0].textContent, /last run 5m ago, next in 25m/);

  ui.setNow(Date.parse("2026-05-01T12:05:00Z"));
  ui.run("let loads = 0; const original = load; load = (...args) => { loads += 1; return original(...args); }");
  await ui.run("refresh()");
  assert.equal(ui.run("loads"), 0, "the answer was a 304");
  assert.equal(source.querySelector(".sub").textContent, "due now");
  assert.match(ui.get("rule-list").children[0].textContent, /last run 35m ago, due now/);
});

test("the page script parses, never renders data as HTML, and finds its elements", () => {
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^\s*import .+;\s*/m, "");
  new vm.Script(script);
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|outerHTML/);
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  for (const [, id] of script.matchAll(/getElementById\("([^"]+)"\)/g)) {
    assert.ok(ids.has(id), `Missing element #${id}`);
  }
});

// Model only the DOM operations used by the task list; HTTP and the page script are real.
async function dashboard(t, { reducedMotion = true, confirm = () => true, now = Date.now(), fetchRequest, phoneWidth = 0 } = {}) {
  const { url, directory } = await server(t);
  const elements = new Map();
  const document = {
    getElementById: (id) => elements.get(id),
    createElement: (tag) => new Element(tag),
    querySelectorAll: () => [],
    createElementNS: (_, tag) => new Element(tag),
    listeners: new Map(),
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    body: { closest: () => null },
  };
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.dataset = {};
      this.style = { setProperty() {} };
      this.listeners = new Map();
      this.getContext = () => ({});
      this.value = "";
      this.open = false;
      this.hidden = false;
      this.className = "";
      this.classList = {
        add: (name) => this.classList.toggle(name, true),
        remove: (name) => this.classList.toggle(name, false),
        toggle: (name, enabled) => {
          const names = new Set(this.className.split(" ").filter(Boolean));
          if (enabled ?? !names.has(name)) names.add(name);
          else names.delete(name);
          this.className = [...names].join(" ");
        },
      };
    }
    append(...children) {
      for (const child of children) if (child instanceof Element) child.parentNode = this;
      this.children.push(...children);
    }
    prepend(child) {
      child.parentNode = this;
      this.children.unshift(child);
    }
    replaceChildren(...children) {
      for (const child of this.children) if (child instanceof Element) child.parentNode = null;
      this.children = [];
      this.append(...children);
      if (this.tag === "select") this.value = children[0]?.value ?? "";
    }
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    }
    get textContent() { return this.children.map((child) => typeof child === "string" ? child : child.textContent).join(""); }
    set textContent(value) { this.children = [String(value)]; }
    get options() { return this.children.filter((child) => child.tag === "option"); }
    setAttribute(name, value) { this[name === "class" ? "className" : name] = value; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    async fire(name, event = {}) {
      const dispatched = { target: this, ...event, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      await this.listeners.get(name)?.(dispatched);
      return dispatched;
    }
    getBoundingClientRect() { return { left: 100, right: 900, top: 100, bottom: 700 }; }
    focus() { document.activeElement = this; }
    closest() { return ["input", "textarea", "select"].includes(this.tag) || this.editable ? this : null; }
    scrollIntoView(options) { this.scrolled = options; }
    requestSubmit() { this.submitted = this.fire("submit"); }
    showModal() { this.open = true; }
    close() { this.open = false; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    querySelectorAll(selector) {
      const match = /^([a-z][a-z0-9]*|\.[\w-]+)(?:\[(open|data-state)(?:="([^"]*)")?\])?$/.exec(selector);
      assert.ok(match, `Unsupported test selector: ${selector}`);
      const [, name, attribute, value] = match;
      return this.children.flatMap((child) => {
        if (!(child instanceof Element)) return [];
        const matches = name.startsWith(".") ? child.className.split(" ").includes(name.slice(1)) : child.tag === name;
        const attributeMatches = !attribute || (attribute === "open" ? child.open : child.dataset.state === value);
        return [
          ...(matches && attributeMatches ? [child] : []),
          ...child.querySelectorAll(selector),
        ];
      });
    }
  }
  for (const [markup, tag, id] of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = new Element(tag);
    node.hidden = /\shidden(?=[\s>])/.test(markup);
    elements.set(id, node);
  }
  elements.get("flow-wrap").clientWidth = phoneWidth;
  const resizeListeners = [];
  elements.get("detail").append(...["detail-title", "close-detail", "task-list", "detail-empty"]
    .map((id) => elements.get(id)));
  elements.get("settings-dialog").append(...["settings-title", "close-settings", "settings-body"].map((id) => elements.get(id)));
  elements.get("move-dialog").append(...["move-title", "close-move", "move-body"].map((id) => elements.get(id)));
  const location = new URL(`?file=${factoryFile}`, url);
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    ...await import("./factory-data.mjs"),
    document, location, URL, URLSearchParams, Date: ClockDate,
    history: { replaceState: (_, __, value) => { location.href = new URL(value, location).href; } },
    window: { addEventListener: (name, callback) => { if (name === "resize") resizeListeners.push(callback); }, confirm },
    matchMedia: (query) => ({ matches: /reduce/.test(query) ? reducedMotion : phoneWidth > 0 }),
    ResizeObserver: class { observe() {} },
    setTimeout() {}, clearTimeout() {}, setInterval() {},
    fetch: (path, options = {}) => {
      const init = {
        ...options,
        headers: { ...options.headers, ...(options.method === "POST" ? { Origin: new URL(url).origin } : {}) },
      };
      const request = () => get(url, path, init);
      return fetchRequest ? fetchRequest(path, init, request) : request();
    },
  });
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
    .replace(/^\s*import .+;\s*/m, "").replace(/\s*buildFlow\(\);\s*refresh\(\);\s*$/, "");
  vm.runInContext(script, context);
  vm.runInContext("buildFlow();", context);
  const run = (source) => vm.runInContext(source, context);
  await run("refresh()");
  const press = (key, event = {}) => {
    const pressed = { key, target: document.body, ...event, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    document.listeners.get("keydown")(pressed);
    return pressed;
  };
  return { run, document, directory, press, resize: (width) => { elements.get("flow-wrap").clientWidth = width; resizeListeners.forEach((callback) => callback()); }, get: (id) => elements.get(id), setNow: (value) => { now = value; } };
}

test("unchanged refresh updates elapsed labels without replacing expanded rows or move drafts", async (t) => {
  const ui = await dashboard(t, { now: Date.parse("2026-05-01T12:05:00Z") });
  const data = structuredClone(example);
  const review = data.tasks.find((task) => task.id === "issue-7");
  review.merge = structuredClone(data.tasks.find((task) => task.id === "issue-3").merge);
  review.merge.head = review.head;
  review.details = { verdict: "implement" };
  await writeFile(join(ui.directory, factoryFile), JSON.stringify(data));
  await ui.run("refresh()");
  ui.run("choose('review')");
  const row = ui.get("task-list").children[0];
  assert.equal(row.querySelector(".state").textContent, "review for 15m");
  assert.match(row.textContent, /20h 35m ago/);
  const details = row.querySelectorAll("details");
  details.forEach((detail) => { detail.open = true; });

  ui.setNow(Date.parse("2026-05-01T12:10:00Z"));
  await ui.run("refresh()");
  assert.equal(ui.get("task-list").children[0], row);
  assert.deepEqual(details.map((detail) => detail.open), [true, true]);
  assert.equal(row.querySelector(".state").textContent, "review for 20m");
  assert.match(row.textContent, /20h 40m ago/);

  await ui.get("close-detail").fire("click");
  ui.run("choose('initial')");
  await ui.get("task-list").querySelector(".move").fire("click");
  const comment = ui.get("move-body").querySelector("textarea");
  comment.value = "Keep this draft";
  await ui.run("refresh()");
  assert.equal(ui.get("move-dialog").open, true);
  assert.equal(ui.get("move-body").querySelector("textarea").value, "Keep this draft");
});

test("state selection opens a docked list that can close and reopen", async (t) => {
  const ui = await dashboard(t, { reducedMotion: false });
  assert.equal(ui.get("detail").hidden, true, "The panel starts closed.");
  ui.run("choose('blocked')");
  assert.equal(ui.get("detail").tag, "aside");
  assert.equal(ui.get("detail").hidden, false);
  assert.equal(ui.document.activeElement, ui.get("detail"), "Opening the list must not focus the close button.");
  assert.equal(ui.get("task-list").tag, "ul");
  assert.equal(ui.get("task-list").children.length, 1);
  assert.match(ui.get("task-list").textContent, /Docs build fails on a clean checkout/);
  assert.equal(ui.get("task-list").children[0].tag, "li");
  await ui.get("close-detail").fire("click");
  assert.equal(ui.get("detail").hidden, true);
  ui.run("choose('blocked')");
  assert.equal(ui.get("task-list").children.length, 1);
  ui.press("Enter");
  assert.equal(ui.get("detail").hidden, false, "Only Escape closes the panel.");
  ui.press("Escape");
  assert.equal(ui.get("detail").hidden, true);
  ui.run("choose('blocked')");
  await ui.get("detail").fire("pointerdown", { clientX: 10, clientY: 10 });
  await ui.get("detail").fire("click", { clientX: 10, clientY: 10 });
  assert.equal(ui.get("detail").hidden, false, "A click outside the panel must not close it.");
  ui.run("choose('investigation')");
  assert.equal(ui.get("detail").hidden, false, "Choosing another state keeps the panel open.");
  assert.equal(ui.get("detail").dataset.state, "investigation");
  assert.equal(ui.get("detail-empty").hidden, false);
  assert.equal(ui.get("task-list").children.length, 0);
});

test("the task list is docked on the right of the flow, and the flow shrinks or scrolls", () => {
  const layout = html.match(/<div class="layout">([\s\S]*?)<noscript>/)[1];
  assert.ok(layout.indexOf('id="factories"') < layout.indexOf("<main>")
    && layout.indexOf("</main>") < layout.indexOf('<aside id="detail"'));
  assert.equal(layout.split('id="detail"').length, 2, "The panel appears once.");
});

test("Escape leaves the task list open while a popup owns the key", async (t) => {
  const ui = await dashboard(t);
  ui.run("choose('blocked')");
  await ui.get("task-list").querySelector(".move").fire("click");
  assert.equal(ui.get("move-dialog").open, true);
  ui.press("Escape");
  assert.equal(ui.get("detail").hidden, false, "Escape in the move popup belongs to the popup.");
});

test("the sidebar lists every factory and blinks a dot on one that changed until it is selected", async (t) => {
  const ui = await dashboard(t);
  const other = "other.repo-factory.json";
  const write = (updated_at) => writeFile(join(ui.directory, other),
    JSON.stringify({ ...example, id: "other-factory", project: "other/repo", updated_at }));
  const items = () => ui.get("factories").querySelectorAll("button");
  const dots = () => ui.get("factories").querySelectorAll(".update-dot");
  await write("2026-05-01T12:00:00Z");
  await ui.run("refresh()");
  assert.deepEqual(items().map((item) => item.querySelector(".name").textContent), ["other/repo", "owner/repo"]);
  assert.equal(dots().length, 0, "The first sighting is a baseline, not an update.");

  await write("2026-05-01T13:00:00Z");
  await ui.run("refresh()");
  assert.equal(dots().length, 1);
  assert.equal(items()[0].querySelectorAll(".update-dot").length, 1, "The changed factory gets the dot.");
  assert.equal(items()[1]["aria-current"], "true");

  await items()[0].fire("click");
  assert.equal(dots().length, 0, "Selecting a factory clears its dot.");
  assert.match(ui.run("location.href"), /file=other\.repo-factory\.json/);
  assert.equal(ui.get("project-name").textContent, "other/repo");

  await write("2026-05-01T14:00:00Z");
  await ui.run("refresh()");
  assert.equal(dots().length, 0, "The selected factory never shows a dot.");
});

test("the sidebar groups factories into Active, Idle and Finished sections in a stable order", async (t) => {
  const ui = await dashboard(t);
  const write = (file, project, patch) => writeFile(join(ui.directory, file),
    JSON.stringify({ ...example, id: project, project, updated_at: "2026-05-01T12:00:00Z", ...patch }));
  await write("a.repo-factory.json", "a/finished", { status: "finished" });
  await write("b.repo-factory.json", "b/idle", { tasks: [] });
  await ui.run("refresh()");
  const factories = ui.get("factories");
  const groups = () => factories.querySelectorAll(".factory-section");
  assert.deepEqual(groups().map((group) => group.querySelector(".section-title").textContent), ["Active", "Idle", "Finished"]);
  assert.deepEqual(groups().map((group) => group["aria-label"]), ["Active", "Idle", "Finished"]);
  const names = () => factories.querySelectorAll("button").map((item) => item.querySelector(".name").textContent);
  assert.deepEqual(names(), ["owner/repo", "b/idle", "a/finished"]);
  assert.deepEqual(factories.querySelectorAll("button").map((item) => item.querySelector("kbd").textContent), ["1", "2", "3"]);
  assert.match(factories.querySelectorAll("button")[2].className, /\bfinished\b/);
  assert.equal(factories.querySelectorAll("button")[0].className.includes("finished"), false);

  await rm(join(ui.directory, "b.repo-factory.json"));
  await ui.run("refresh()");
  assert.deepEqual(groups().map((group) => group.querySelector(".section-title").textContent), ["Active", "Finished"]);
});

test("digits select the Nth sidebar factory and the first nine items show a kbd badge", async (t) => {
  const ui = await dashboard(t);
  const other = "other.repo-factory.json";
  await writeFile(join(ui.directory, other),
    JSON.stringify({ ...example, id: "other-factory", project: "other/repo", updated_at: "2026-05-01T12:00:00Z" }));
  await ui.run("refresh()");
  const items = () => ui.get("factories").querySelectorAll("button");
  assert.deepEqual(items().map((item) => item.querySelector("kbd").textContent), ["1", "2"]);
  assert.equal(items()[1]["aria-keyshortcuts"], "2");
  assert.equal(items()[1]["aria-current"], "true");

  const ignored = async (key, event) => {
    const before = ui.run("location.href");
    const dispatched = await ui.press(key, event);
    assert.equal(ui.run("location.href"), before);
    assert.equal(dispatched.defaultPrevented, false);
  };
  await ignored("3");
  await ignored("0");
  await ignored("a");
  await ignored("Enter");
  for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey"]) await ignored("1", { [modifier]: true });
  await ignored("1", { target: { closest: () => ({}) } });
  await ignored("1", { repeat: true });
  ui.get("move-dialog").open = true;
  await ignored("1");
  ui.get("move-dialog").open = false;

  const dispatched = await ui.press("1");
  assert.equal(dispatched.defaultPrevented, true);
  assert.match(ui.run("location.href"), /file=other\.repo-factory\.json/);
  assert.equal(items()[0]["aria-current"], "true");
});

test("only the first nine sidebar items get a kbd badge", async (t) => {
  const ui = await dashboard(t);
  for (let index = 0; index < 10; index += 1) {
    await writeFile(join(ui.directory, `f${index}.repo-factory.json`),
      JSON.stringify({ ...example, id: `f${index}`, project: `f${index}/repo` }));
  }
  await ui.run("refresh()");
  const items = ui.get("factories").querySelectorAll("button");
  assert.equal(items.length, 11);
  assert.equal(items.filter((item) => item.querySelector("kbd")).length, 9);
  assert.equal(items[9].querySelector("kbd"), null);
  assert.equal(items[0].querySelector("kbd").textContent, "1");
});

test("flow edges use only straight horizontal and vertical segments", async (t) => {
  const ui = await dashboard(t);
  const paths = ui.get("flow").querySelectorAll(".edge").map((edge) => edge.d);
  assert.equal(paths.length, 13);
  for (const path of paths) {
    assert.match(path, /^M[\d.,-]+( L[\d.,-]+)+$/, `Only M and L commands: ${path}`);
    const points = path.slice(1).split(" L").map((point) => point.split(",").map(Number));
    points.slice(1).forEach(([x, y], index) => {
      const [px, py] = points[index];
      assert.ok(x === px || y === py, `Diagonal segment in ${path}`);
    });
  }
});

test("the flow draws plain lines with a port at each end", async (t) => {
  const ui = await dashboard(t);
  const flow = ui.get("flow");
  assert.equal(flow.querySelectorAll(".edge").every((edge) => edge["marker-end"] === undefined), true);
  assert.equal(flow.querySelectorAll(".port").length, 26, "Each line has a port at both ends.");
});

test("both charts draw the same lines, and they are the allowed moves", async (t) => {
  const { transitions } = await import("./factory-data.mjs");
  const ui = await dashboard(t);
  const drawn = (width) => {
    ui.run(`buildFlow(${width})`);
    return ui.get("flow").querySelectorAll(".edge").map((edge) => edge.dataset.edge).sort();
  };
  const horizontal = drawn(0);
  assert.deepEqual(drawn(390), horizontal);
  assert.deepEqual(horizontal, [
    "implementation>blocked", "implementation>resolved", "implementation>review", "initial>blocked", "initial>investigation",
    "initial>resolved", "initial>review", "investigation>blocked", "investigation>implementation", "investigation>resolved",
    "review>blocked", "review>resolved", "source>initial",
  ]);
  const moves = { ...transitions, source: ["initial"], initial: [...transitions.initial, "review"] };
  for (const edge of horizontal) {
    const [from, to] = edge.split(">");
    assert.ok(moves[from].includes(to) || moves[to]?.includes(from), `${edge} is not an allowed move`);
  }
});

test("on a phone the flow is one column at the screen width, drawn at scale 1", async (t) => {
  const { states, outcomes } = await import("./factory-data.mjs");
  const ui = await dashboard(t, { phoneWidth: 390 });
  ui.run(`load(${JSON.stringify(example)}, ${JSON.stringify(factoryFile)})`);
  const flow = ui.get("flow");
  const classes = () => flow.className.split(" ");
  assert.ok(classes().includes("vertical"));
  const [, , width, height] = flow.viewBox.split(" ").map(Number);
  assert.equal(width, 390, "One chart unit is one screen pixel, so the text keeps its size.");

  const boxes = flow.querySelectorAll(".box").map((box) => ({ x: +box.x, y: +box.y, w: +box.width, h: +box.height }));
  assert.equal(boxes.length, states.length + 1);
  for (const box of boxes) {
    assert.ok(box.x >= 0 && box.x + box.w <= width, "No box leaves the screen.");
    assert.ok(box.w >= width - 80, "Boxes are full width, less the lanes.");
    assert.ok(box.y >= 0 && box.y + box.h <= height);
  }
  const rows = flow.querySelectorAll(".outcome").map((group) => group.children[0]).map((rect) => ({ y: +rect.y, h: +rect.height }));
  assert.equal(rows.length, outcomes.length);
  const stacked = [...boxes, ...rows.map((row) => ({ ...row, x: 0, w: width }))].sort((a, b) => a.y - b.y);
  stacked.slice(1).forEach((box, index) => assert.ok(box.y >= stacked[index].y + stacked[index].h, "Nothing overlaps."));

  const order = ["source", "initial", "investigation", "implementation", "review", "resolved", "blocked"];
  const topOf = (group) => +group.querySelector(".box").y;
  const tops = order.map((state) => topOf(state === "source" ? flow.querySelector(".source") : ui.run(`nodeOf('${state}')`)));
  assert.deepEqual(tops, [...tops].sort((a, b) => a - b), "States run top to bottom in flow order.");

  const points = flow.querySelectorAll(".edge").flatMap((edge) => edge.d.slice(1).split(" L").map((point) => point.split(",").map(Number)));
  assert.ok(points.every(([x, y]) => x >= 0 && x <= width && y >= 0 && y <= height), "Every line stays on the chart.");

  const segments = (edge) => {
    const route = edge.d.slice(1).split(" L").map((point) => point.split(",").map(Number));
    return route.slice(1).map(([x, y], index) => ({ edge: edge.dataset.edge, from: route[index], to: [x, y] }));
  };
  const all = flow.querySelectorAll(".edge").flatMap(segments);
  const between = (value, a, b) => value > Math.min(a, b) && value < Math.max(a, b);
  const crossings = new Set();
  for (const a of all.filter(({ from, to }) => from[1] === to[1])) {
    for (const b of all.filter(({ from, to }) => from[0] === to[0])) {
      if (between(b.from[0], a.from[0], a.to[0]) && between(a.from[1], b.from[1], b.to[1])) crossings.add([a.edge, b.edge].sort().join(" x "));
    }
  }
  assert.deepEqual([...crossings].sort(), [
    "implementation>resolved x initial>review",
    "initial>review x investigation>resolved",
  ], "Only the line from Initial to Review crosses others, where it lands.");

  ui.resize(430);
  assert.equal(flow.viewBox, `0 0 430 ${flow.viewBox.split(" ")[3]}`);
  assert.equal(ui.run("nodeOf('blocked')").querySelector(".count").textContent, "1", "A redraw after a resize keeps the live counts.");

  const desktop = await dashboard(t);
  assert.ok(!desktop.get("flow").className.split(" ").includes("vertical"));
  assert.equal(desktop.get("flow").viewBox, "0 0 1160 560");
});

test("no hover or reach rule gives a state square a blue border", () => {
  const rules = [...html.matchAll(/^\s*(\.node[^{\n]*)\{([^}]*)\}/gm)];
  const blue = rules.filter(([, selector, body]) => /:hover|\.reach/.test(selector) && /stroke:[^;]*--accent/.test(body));
  assert.deepEqual(blue.map(([, selector]) => selector.trim()), []);
});

for (const width of [0, 390]) test(`hovering or focusing a state lights only its direct moves and the states they reach (${width ? "vertical" : "horizontal"} chart)`, async (t) => {
  const { states, transitions } = await import("./factory-data.mjs");
  const ui = await dashboard(t);
  ui.run(`buildFlow(${width})`);
  const flow = ui.get("flow");
  const has = (node, name) => node.className.split(" ").includes(name);
  const lit = () => flow.querySelectorAll(".edge").filter((edge) => has(edge, "lit")).map((edge) => edge.dataset.edge).sort();
  const reached = () => flow.querySelectorAll(".node").filter((node) => has(node, "reach"))
    .map((node) => node.dataset.state).sort();
  const node = (state) => ui.run(`nodeOf('${state}')`);
  const edges = {
    initial: ["initial>blocked", "initial>investigation", "initial>resolved", "initial>review"],
    investigation: ["investigation>blocked", "investigation>implementation", "investigation>resolved"],
    implementation: ["implementation>blocked", "implementation>resolved", "implementation>review"],
    review: ["implementation>review", "review>blocked", "review>resolved"],
    blocked: ["implementation>blocked", "initial>blocked", "investigation>blocked", "review>blocked"],
    resolved: ["initial>resolved"],
  };

  assert.deepEqual(lit(), []);
  for (const state of states) {
    const targets = [...transitions[state], ...(state === "initial" ? ["review"] : [])].sort();
    await node(state).fire("mouseenter");
    assert.deepEqual(lit(), edges[state], `${state} lights only its own moves`);
    assert.deepEqual(reached(), targets, `${state} reaches only its targets`);
    assert.equal(flow.querySelectorAll(".port").filter((port) => has(port, "lit")).length, edges[state].length * 2);
    await node(state).fire("mouseleave");
    assert.deepEqual(lit(), []);
    assert.deepEqual(reached(), []);

    await node(state).fire("focus");
    assert.deepEqual(lit(), edges[state], `${state} lights the same on focus`);
    await node(state).fire("blur");
    assert.deepEqual(lit(), []);
  }

  await flow.querySelector(".source").fire("mouseenter");
  assert.deepEqual(lit(), ["source>initial"]);
  assert.deepEqual(reached(), ["initial"]);
  await flow.querySelector(".source").fire("mouseleave");
  assert.deepEqual(lit(), []);
});

test("rows show history, open references in a new tab, and highlight evidence", async (t) => {
  const ui = await dashboard(t);
  ui.run("choose('implementation')");
  const row = ui.get("task-list").children[0];
  const history = row.children.find((child) => child.tag === "ol");
  assert.ok(history, "History must be a direct, always-visible part of the row.");
  assert.equal(history.children.length, 3);
  const links = row.querySelectorAll("a").filter((node) => node.href?.startsWith("https://github.com/"));
  assert.ok(links.length > 0);
  for (const node of links) {
    assert.equal(node.target, "_blank", node.href);
    assert.equal(node.rel, "noopener noreferrer", node.href);
  }
  const section = row.querySelectorAll("details").find((node) => node.dataset.taskId === "issue-9");
  assert.equal(section.querySelector("pre"), null);
  section.open = true;
  await section.fire("toggle");
  const evidence = row.querySelector("pre");
  assert.equal(evidence.textContent, JSON.stringify(example.tasks.find((task) => task.id === "issue-9").details, null, 2));
  assert.equal(evidence.querySelector(".json-key").textContent, '"verdict"');
  const value = { note: 'say "a": 1', count: -2.5e3, ok: true, gone: null, list: [1, "x"] };
  const pre = ui.run(`highlightJSON(${JSON.stringify(value)})`);
  assert.equal(pre.textContent, JSON.stringify(value, null, 2));
  const tokens = (name) => pre.querySelectorAll(`.json-${name}`).map((node) => node.textContent);
  assert.deepEqual(tokens("key"), ['"note"', '"count"', '"ok"', '"gone"', '"list"']);
  assert.deepEqual(tokens("string"), ['"say \\"a\\": 1"', '"x"']);
  assert.deepEqual(tokens("literal"), ["-2500", "true", "null", "1"]);
});

test("evidence renders on first open, once, and stays open across a list rebuild", async (t) => {
  const ui = await dashboard(t);
  const data = structuredClone(example);
  data.tasks.find((task) => task.id === "issue-9").details = { notes: "x".repeat(5000), verdict: "implement" };
  await writeFile(join(ui.directory, factoryFile), JSON.stringify(data));
  await ui.run("refresh()");
  ui.run("choose('implementation')");
  const section = () => ui.get("task-list").querySelectorAll("details").find((node) => node.dataset.taskId === "issue-9");
  assert.equal(section().querySelector("pre"), null);
  assert.equal(section().querySelector(".json-key"), null);

  section().open = true;
  await section().fire("toggle");
  const pre = section().querySelector("pre");
  assert.equal(pre.textContent, JSON.stringify(data.tasks.find((task) => task.id === "issue-9").details, null, 2));
  await section().fire("toggle");
  assert.equal(section().querySelectorAll("pre").length, 1);

  const row = ui.get("task-list").children.find((node) => node.dataset.taskId === "issue-9");
  const issue9 = data.tasks.find((task) => task.id === "issue-9");
  issue9.revision = (issue9.revision ?? 0) + 1;
  await writeFile(join(ui.directory, factoryFile), JSON.stringify(data));
  await ui.run("refresh()");
  assert.notEqual(ui.get("task-list").children.find((node) => node.dataset.taskId === "issue-9"), row);
  assert.equal(section().open, true);
  assert.equal(section().querySelectorAll("pre").length, 1);
});

test("the list rebuilds only when a row's revision, update time or history changes", async (t) => {
  const ui = await dashboard(t);
  const data = structuredClone(example);
  await writeFile(join(ui.directory, factoryFile), JSON.stringify(data));
  ui.run("choose('implementation')");
  const first = () => ui.get("task-list").children[0];
  const row = first();
  const id = row.dataset.taskId;
  const task = data.tasks.find((item) => item.id === id);
  await ui.run("refresh()");
  assert.equal(first(), row);

  task.revision = (task.revision ?? 0) + 1;
  await writeFile(join(ui.directory, factoryFile), JSON.stringify(data));
  await ui.run("refresh()");
  const afterRevision = first();
  assert.notEqual(afterRevision, row);

  task.updated_at = "2026-05-02T00:00:00Z";
  await writeFile(join(ui.directory, factoryFile), JSON.stringify(data));
  await ui.run("refresh()");
  const afterUpdate = first();
  assert.notEqual(afterUpdate, afterRevision);

  task.history.push({ ...task.history.at(-1) });
  await writeFile(join(ui.directory, factoryFile), JSON.stringify(data));
  await ui.run("refresh()");
  assert.notEqual(first(), afterUpdate);
});

test("a row has the title and Move button in the head and the links on their own line", async (t) => {
  const ui = await dashboard(t);
  ui.run("choose('implementation')");
  const row = ui.get("task-list").children[0];
  const [head, links] = row.children;
  assert.deepEqual(head.children.map((child) => child.tag), ["h3", "button"]);
  assert.equal(head.children[1].className, "move");
  assert.equal(links.className, "links");
  assert.ok(links.children.length > 0);
  assert.equal(head.querySelectorAll("a").length, 0);
});

test("reference links get an issue or pull request glyph and show the bare number", async (t) => {
  const ui = await dashboard(t);
  const issue = ui.run(`reference("https://github.com/owner/repo/issues/12")`);
  const pull = ui.run(`reference("https://github.com/owner/repo/pull/21")`);
  assert.equal(issue.textContent, "12");
  assert.equal(pull.textContent, "21");
  assert.equal(issue.children[0].tag, "svg");
  assert.equal(issue.children[0]["aria-label"], "Issue");
  assert.equal(pull.children[0]["aria-label"], "Pull request");
  assert.notEqual(issue.children[0].children[0].d, pull.children[0].children[0].d);
});

test("a row lists issues first, then pull requests, each by ascending number, without duplicates", async (t) => {
  const ui = await dashboard(t);
  const url = (kind, number) => `https://github.com/owner/repo/${kind}/${number}`;
  const task = { ...example.tasks[0], issue: url("issues", 9), pr: url("pull", 30), links: [url("pull", 4), url("issues", 40), url("issues", 9)] };
  const row = ui.run(`taskRow(${JSON.stringify(task)}, new Set())`);
  assert.deepEqual(row.querySelector(".links").children.map((node) => node.href), [url("issues", 9), url("issues", 40), url("pull", 4), url("pull", 30)]);
});

test("a row without references has no links line", async (t) => {
  const ui = await dashboard(t);
  const task = { ...example.tasks[0], issue: null, pr: null, links: [] };
  const row = ui.run(`taskRow(${JSON.stringify(task)}, new Set())`);
  assert.equal(row.querySelector(".links"), null);
  assert.equal(row.children[0].className, "row-head");
});

test("history steps carry relative gaps, loop and operator markers", async (t) => {
  const ui = await dashboard(t);
  const history = [
    { state: "initial", at: "2026-05-01T10:00:00Z", note: null },
    { state: "implementation", at: "2026-05-01T10:02:00Z", note: "Started." },
    { state: "review", at: "2026-05-01T17:30:00Z", note: "PR opened." },
    { state: "implementation", at: "2026-05-01T17:31:00Z", note: "Changes requested." },
    { state: "blocked", at: "2026-05-01T17:31:00Z", note: "Need a decision.", source: "dashboard", feedback_id: "f1" },
    { state: "implementation", at: "2026-05-04T17:31:00Z", note: "Resumed." },
  ];
  const steps = JSON.parse(ui.run(`JSON.stringify(historySteps(${JSON.stringify(history)}))`));
  assert.deepEqual(steps.map((step) => step.state), history.map((item) => item.state));
  assert.deepEqual(steps.map((step) => step.gap), [null, "+2m", "+7h 28m", "+1m", "+0s", "+3d"]);
  assert.deepEqual(steps.map((step) => step.back), [null, null, null, "rework", null, "unblocked"]);
  assert.deepEqual(steps.map((step) => step.operator), [false, false, false, false, true, false]);
  assert.equal(steps[0].note, null);
});

test("history renders one flow step per entry, even for a single entry", async (t) => {
  const ui = await dashboard(t);
  for (const id of ["issue-12", "issue-7"]) {
    const task = example.tasks.find((item) => item.id === id);
    const row = ui.run(`taskRow(${JSON.stringify(task)}, new Set())`);
    const history = row.children.find((child) => child.tag === "ol");
    assert.equal(history.children.length, task.history.length, id);
    assert.deepEqual(history.querySelectorAll(".history-state").map((node) => node.textContent),
      task.history.map((item) => item.state));
    assert.equal(row.querySelector("h4").textContent, `History (${task.history.length})`);
    assert.equal(history.querySelectorAll(".history-gap").length, task.history.length - 1);
  }
  const loop = ui.run(`taskRow(${JSON.stringify(example.tasks.find((item) => item.id === "issue-7"))}, new Set())`);
  assert.equal(loop.querySelectorAll(".history-gap").filter((gap) => gap.textContent.includes("↩ rework")).length, 1);
});

test("history marks operator moves and keeps their note visible", async (t) => {
  const ui = await dashboard(t);
  const task = structuredClone(example.tasks.find((item) => item.id === "issue-9"));
  task.history.push({ state: "blocked", at: "2026-05-02T00:00:00Z", note: "Wait for the vendor.", source: "dashboard", feedback_id: "f1" });
  task.state = "blocked";
  const row = ui.run(`taskRow(${JSON.stringify(task)}, new Set())`);
  const nodes = row.querySelectorAll(".history-node");
  assert.equal(nodes.length, 4);
  assert.equal(nodes.filter((node) => node.className.split(" ").includes("operator")).length, 1);
  assert.equal(nodes.at(-1).querySelector(".history-badge").textContent, "operator");
  assert.equal(nodes.at(-1).querySelector(".history-note").textContent, "Wait for the vendor.");
  assert.match(nodes.at(-1).title, /Wait for the vendor\./);
});

test("long histories fold older steps and keep them reachable across refreshes", async (t) => {
  const ui = await dashboard(t);
  const task = structuredClone(example.tasks.find((item) => item.id === "issue-7"));
  while (task.history.length < 25) {
    const at = new Date(Date.parse(task.history.at(-1).at) + 60_000).toISOString();
    task.history.push({ state: task.history.length % 2 ? "implementation" : "review", at, note: `Step ${task.history.length}.` });
  }
  task.state = task.history.at(-1).state;
  const row = ui.run(`taskRow(${JSON.stringify(task)}, new Set())`);
  assert.equal(row.querySelector("h4").textContent, "History (25)");
  assert.deepEqual(row.querySelectorAll("ol").map((list) => list.children.length), [17, 8]);
  assert.equal(row.querySelectorAll(".history-node").length, 25);
  const folded = row.children.find((child) => child.className === "history-earlier");
  assert.equal(folded.open, false);
  assert.equal(folded.querySelector("summary").textContent, "Earlier steps (17)");
  assert.equal(folded.dataset.taskId, `${task.id}:history`);
  const reopened = ui.run(`taskRow(${JSON.stringify(task)}, new Set(["${task.id}:history"]))`);
  assert.equal(reopened.children.find((child) => child.className === "history-earlier").open, true);
});

test("resolved sublists count each outcome and open only matching tasks", async (t) => {
  const ui = await dashboard(t, { reducedMotion: false });
  const data = structuredClone(example);
  const { operatorOutcomes } = await import("./factory-data.mjs");
  for (const [index, outcome] of [...operatorOutcomes, "duplicate"].entries()) {
    const task = structuredClone(example.tasks.find((task) => task.state === "initial"));
    task.id = `resolution-${index}`;
    task.title = `${outcome} task ${index}`;
    task.issue = null;
    task.state = "resolved";
    task.resolution = { outcome, at: data.updated_at, note: "Resolved for this outcome." };
    task.history.push({ state: "resolved", at: data.updated_at });
    data.tasks.push(task);
  }
  await writeFile(join(ui.directory, factoryFile), JSON.stringify(data));
  await ui.run("refresh()");
  const outcomes = ui.get("flow").querySelectorAll(".outcome");
  assert.equal(outcomes.length, 6);
  assert.deepEqual(Object.fromEntries(outcomes.map((node) =>
    [node.dataset.outcome, Number(node.querySelector(".outcome-count").textContent)])), {
    merged: 1, "already-fixed": 1, duplicate: 2, invalid: 1, cancelled: 1, completed: 1,
  });
  const total = ui.run("nodeOf('resolved')");
  assert.equal(total.querySelector(".count").textContent, "7");
  const duplicate = outcomes.find((node) => node.dataset.outcome === "duplicate");
  assert.equal(duplicate["aria-label"], "Resolved: Duplicate, 2 tasks");
  await duplicate.fire("click");
  assert.equal(ui.run("location.hash"), "#resolved/duplicate");
  assert.match(ui.get("detail-title").textContent, /^Resolved: Duplicate/);
  assert.equal(ui.get("task-list").children.length, 2);
  assert.ok(ui.get("task-list").children.every((row) => row.textContent.includes("duplicate task")));
  await ui.run("refresh()");
  assert.equal(ui.get("task-list").children.length, 2);
  await outcomes.find((node) => node.dataset.outcome === "merged").fire("keydown", { key: "Enter" });
  assert.equal(ui.get("task-list").children.length, 1, "Changing the outcome must not fade the old sublist.");
  assert.equal(ui.get("task-list").querySelector(".move"), null);
  await outcomes.find((node) => node.dataset.outcome === "cancelled").fire("keydown", { key: " " });
  assert.equal(ui.get("task-list").children.length, 1);
  assert.match(ui.get("task-list").textContent, /cancelled task/);
  await total.fire("click");
  assert.equal(ui.run("location.hash"), "#resolved");
  assert.equal(ui.get("task-list").children.length, 7);
  await duplicate.fire("click");
  await ui.get("close-detail").fire("click");
  assert.equal(ui.get("detail").hidden, true, "Close must close the list.");
  assert.equal(ui.run("location.hash"), "");
});

test("resolution counts and sublists update when a task is resolved and reopened", async (t) => {
  const ui = await dashboard(t);
  const completed = ui.get("flow").querySelectorAll(".outcome")
    .find((node) => node.dataset.outcome === "completed");
  assert.ok(completed, "Completed must be listed even when its count is zero.");
  await completed.fire("click");
  assert.equal(completed.querySelector(".outcome-count").textContent, "0");
  assert.equal(ui.get("task-list").children.length, 0);
  assert.equal(ui.get("detail-empty").hidden, false);
  ui.press("Escape");
  assert.equal(ui.get("detail").hidden, true);
  ui.run("choose('initial')");
  await ui.get("task-list").querySelector(".move").fire("click");
  let form = ui.get("move-body").querySelector("form");
  form.querySelector("select").value = "resolved";
  await form.querySelector("select").fire("change");
  form.querySelector("textarea").value = "Work completed.";
  await form.fire("submit");
  assert.equal(completed.querySelector(".outcome-count").textContent, "1");
  await completed.fire("click");
  assert.equal(ui.get("task-list").children.length, 1);
  await ui.get("task-list").querySelector(".move").fire("click");
  form = ui.get("move-body").querySelector("form");
  form.querySelector("textarea").value = "Reopen for more work.";
  await form.fire("submit");
  assert.equal(completed.querySelector(".outcome-count").textContent, "0");
  assert.equal(ui.run("location.hash"), "#resolved/completed");
  assert.equal(ui.get("task-list").children.length, 0);
  assert.equal(ui.get("detail-empty").hidden, false);
});

test("Blocked has one line per state that never overlaps another", async (t) => {
  const ui = await dashboard(t);
  const edges = ui.get("flow").querySelectorAll(".edge");
  const keys = edges.map((edge) => edge.dataset.edge);
  const parse = (path) => path.slice(1).split(" L").map((point) => point.split(",").map(Number));
  const lanes = [];
  for (const state of ["initial", "investigation", "implementation", "review"]) {
    const key = `${state}>blocked`;
    const edge = edges.find((item) => item.dataset.edge === key);
    assert.ok(edge, `Missing edge ${key}`);
    const points = parse(edge.d);
    assert.equal(points.at(-1)[1], 430, `${key} meets the top of Blocked`);
    assert.equal(points[0][1], 320, `${key} meets the bottom of its state`);
    lanes.push({ key, points });
  }
  assert.equal(keys.some((key) => key.startsWith("blocked>") || key === "review>implementation"), false,
    "A line joins two states once, not once per direction.");
  assert.equal(new Set(keys).size, keys.length, "Edge keys are unique");

  const segments = (points) => points.slice(1).map(([x, y], index) => {
    const [px, py] = points[index];
    return { x1: Math.min(x, px), x2: Math.max(x, px), y1: Math.min(y, py), y2: Math.max(y, py) };
  });
  const touch = (a, b) => a.x1 <= b.x2 && b.x1 <= a.x2 && a.y1 <= b.y2 && b.y1 <= a.y2;
  lanes.forEach((a, index) => lanes.slice(index + 1).forEach((b) => {
    for (const first of segments(a.points)) {
      for (const second of segments(b.points)) {
        assert.equal(touch(first, second), false, `${a.key} touches ${b.key}`);
      }
    }
  }));
});

test("Find work lists rules, user links and skipped work without changing task states", async (t) => {
  const ui = await dashboard(t);
  const source = ui.get("flow").querySelector(".source");
  assert.equal(source["aria-label"], "Find work: 2 enabled rules");
  assert.equal(source.querySelector(".count").textContent, "2");
  assert.equal(source.querySelector(".sub").textContent, "due now");
  await source.fire("click");
  assert.equal(ui.run("location.hash"), "#producers");
  assert.equal(ui.get("detail").hidden, false, "Find work uses the docked panel.");
  assert.equal(ui.get("detail-title").textContent, "Find work");
  assert.equal(ui.get("task-view").hidden, true);
  assert.equal(ui.get("producers-view").hidden, false);
  assert.equal(ui.get("close-detail")["aria-label"], "Close find work");
  const rows = ui.get("rule-list").children;
  assert.deepEqual(rows.map((row) => row.querySelector("h3").textContent), ["new-bugs", "find-more", "User links"]);
  assert.match(rows[0].textContent, /search.*enabled.*Search: repo:owner\/repo is:issue.*Every 30m, last run .* ago, due now/);
  assert.match(rows[1].textContent, /backlog.*Prompt: Prefer flaky tests.*Every 1d.*Worker: closed, one-shot result/);
  assert.equal(rows[1].querySelectorAll("a").at(-1).href,
    `/api/artifact?file=${factoryFile}&name=owner.repo-find-more-result.json`);
  assert.equal(ui.get("ignored-list").children.length, 1);
  assert.equal(ui.get("improve-heading").hidden, false);
  assert.deepEqual(ui.get("improve-list").children.map((row) => row.querySelector("h3").textContent), ["self-improve"]);
  assert.match(ui.get("improve-list").children[0].textContent, /improve.*enabled.*Every 7d, last run .* ago, due now/);
  assert.match(ui.get("ignored-list").textContent, /2 2026-04-30: Archived duplicate/);
  assert.equal(ui.get("ignored-empty").hidden, true);
  assert.equal(ui.get("producers-note").textContent, "");
  await ui.get("close-detail").fire("click");
  assert.equal(ui.get("detail").hidden, true);
  assert.equal(ui.run("location.hash"), "");
  await source.fire("keydown", { key: "Enter" });
  assert.equal(ui.get("detail").hidden, false);
  ui.press("Escape");
  assert.equal(ui.get("detail").hidden, true);
  assert.equal(ui.run("location.hash"), "");
  await source.fire("click");
  ui.run("choose('blocked')");
  assert.equal(ui.get("producers-view").hidden, true, "A state replaces the Find work content.");
  assert.equal(ui.get("task-view").hidden, false);
  assert.equal(ui.get("close-detail")["aria-label"], "Close task list");
});

test("Find work shows a paused factory and disabled or unscheduled rules", async (t) => {
  const ui = await dashboard(t);
  const data = structuredClone(example);
  data.status = "paused";
  data.rules = [{ id: "legacy", description: "Old rule.", query: "is:issue", enabled: false, last_run_at: null }];
  data.ignored = [];
  await writeFile(join(ui.directory, factoryFile), JSON.stringify(data));
  await ui.run("refresh()");
  const source = ui.get("flow").querySelector(".source");
  assert.equal(source["aria-label"], "Find work: 0 enabled rules");
  assert.equal(source.querySelector(".sub").textContent, "on request");
  await source.fire("click");
  assert.equal(ui.get("producers-note").textContent, "Scheduled rules do not run while the factory is paused.");
  assert.match(ui.get("rule-list").children[0].textContent, /rule.*disabled.*No schedule: runs on start or when asked/);
  assert.equal(ui.get("improve-heading").hidden, true);
  assert.equal(ui.get("ignored-empty").hidden, false);
});

test("Unblock lists options, fills the comment verbatim and saves through the move path", async (t) => {
  const ui = await dashboard(t);
  ui.run("choose('blocked')");
  const row = ui.get("task-list").querySelector(".move");
  assert.equal(row.textContent, "Unblock");
  assert.match(ui.get("task-list").textContent, /Add the docs token to the CI secrets \(recommended\)/);
  await row.fire("click");
  assert.match(ui.get("move-title").textContent, /^Unblock: /);
  const form = ui.get("move-body").querySelector("form");
  const state = form.querySelector("select");
  const comment = form.querySelector("textarea");
  const context = form.querySelector(".unblock-context");
  assert.equal(context.children[0].textContent.startsWith("Blocked in investigation for "), true);
  const reason = context.querySelector(".unblock-reason");
  assert.equal(reason.textContent, "The docs build needs a token that the worker cannot read.");
  assert.equal(reason.tabIndex, 0);
  assert.equal(reason.role, "region");
  assert.doesNotMatch(context.textContent, /Next:|Ask the user for the docs token/);
  assert.match(context.querySelector(".unblock-notes").textContent, /blocked .*: Needs a token\./);
  assert.equal(comment.value, "");
  const choices = form.querySelectorAll(".option");
  assert.deepEqual(choices.map((choice) => choice.children[0]), ["Add the docs token to the CI secrets", "Skip the docs build in CI"]);
  assert.match(choices[0].textContent, /Recommended/);
  assert.doesNotMatch(choices[1].textContent, /Recommended/);
  await choices[0].fire("click");
  assert.equal(comment.value, "Add the docs token to the CI secrets");
  assert.equal(state.value, "implementation");
  await choices[1].fire("click");
  assert.equal(comment.value, "Skip the docs build in CI");
  assert.equal(state.value, "investigation");
  comment.value = "Use a custom token instead.";
  await form.fire("submit");
  const saved = JSON.parse(await readFile(join(ui.directory, factoryFile), "utf8")).tasks.find((task) => task.id === "issue-5");
  assert.equal(saved.state, "investigation");
  assert.equal(saved.blocker, null);
  assert.equal(saved.history.at(-1).note, "Use a custom token instead.");
  assert.equal(saved.history.at(-1).source, "dashboard");
  assert.equal(saved.history.at(-1).feedback_id, saved.feedback.id);
  assert.equal(saved.feedback.acknowledged_id, null);
});

test("the blocker class and owner show in the Unblock popup, and blocked tasks filter by class", async (t) => {
  const ui = await dashboard(t);
  const data = structuredClone(example);
  const base = data.tasks.find((item) => item.id === "issue-5");
  const extra = (id, blocker) => ({ ...structuredClone(base), id, title: id, issue: null, pr: null, blocker: { ...base.blocker, ...blocker } });
  const plain = extra("plain", { reason: "Old blocker" });
  delete plain.blocker.class;
  delete plain.blocker.owner;
  data.tasks.push(extra("infra", { class: "ci-infra", owner: "alice" }), plain);
  await writeFile(join(ui.directory, factoryFile), JSON.stringify(data));
  await ui.run("refresh()");
  ui.run("choose('blocked')");
  const filter = ui.get("blocker-filter");
  assert.equal(filter.hidden, false);
  assert.deepEqual(filter.options.map((option) => [option.value, option.textContent]), [
    ["", "All classes (3)"], ["outside-action", "outside-action (1)"], ["ci-infra", "ci-infra (1)"], ["none", "No class (1)"],
  ]);
  const ids = () => ui.get("task-list").children.map((row) => row.dataset.taskId).sort();
  assert.deepEqual(ids(), ["infra", "issue-5", "plain"]);
  assert.match(ui.get("task-list").textContent, /Class: ci-infra\. Owner: alice\./);
  filter.value = "ci-infra";
  await filter.fire("change");
  assert.deepEqual(ids(), ["infra"]);
  filter.value = "none";
  await filter.fire("change");
  assert.deepEqual(ids(), ["plain"]);
  assert.doesNotMatch(ui.get("task-list").textContent, /Class:|Owner:/);
  filter.value = "";
  await filter.fire("change");
  await ui.get("task-list").children.find((row) => row.dataset.taskId === "issue-5").querySelector(".move").fire("click");
  const context = ui.get("move-body").querySelector(".unblock-context");
  assert.equal(context.children[1].textContent, "Class: outside-action. Owner: operator.");
  ui.run("choose('initial')");
  assert.equal(filter.hidden, true);
});

test("Unblock without options shows only the state and the comment; other rows keep Move", async (t) => {
  const ui = await dashboard(t);
  const data = structuredClone(example);
  const task = data.tasks.find((item) => item.id === "issue-5");
  task.blocker = { from: "implementation", reason: "<b>Old</b> blocker", since: task.blocker.since };
  await writeFile(join(ui.directory, factoryFile), JSON.stringify(data));
  await ui.run("refresh()");
  ui.run("choose('blocked')");
  await ui.get("task-list").querySelector(".move").fire("click");
  const form = ui.get("move-body").querySelector("form");
  assert.equal(form.querySelector("select").value, "implementation");
  assert.equal(form.querySelectorAll(".option").length, 0);
  assert.equal(form.querySelector(".unblock-options").hidden, true);
  const reason = form.querySelector(".unblock-reason");
  assert.equal(reason.textContent, "<b>Old</b> blocker");
  assert.equal(reason.querySelectorAll("b").length, 0);
  assert.match(form.querySelector(".unblock-context").textContent, /^Blocked in implementation for /);
  await ui.get("close-move").fire("click");
  ui.run("choose('initial')");
  assert.equal(ui.get("task-list").querySelector(".move").textContent, "Move");
  await ui.get("task-list").querySelector(".move").fire("click");
  assert.equal(ui.get("move-body").querySelector(".unblock-context"), null);
});

test("Unblock shows a long reason in full and only the last three history notes, newest first", async (t) => {
  const ui = await dashboard(t);
  const data = structuredClone(example);
  const task = data.tasks.find((item) => item.id === "issue-5");
  const reason = `${"x".repeat(2500)}\n${"y".repeat(2500)}`;
  task.blocker.reason = reason;
  task.history = ["one", "two", "three", "four"].map((note, index) => ({
    state: index === 3 ? "blocked" : "investigation", at: `2026-05-01T0${index}:00:00Z`, note,
  }));
  await writeFile(join(ui.directory, factoryFile), JSON.stringify(data));
  await ui.run("refresh()");
  ui.run("choose('blocked')");
  await ui.get("task-list").querySelector(".move").fire("click");
  const context = ui.get("move-body").querySelector(".unblock-context");
  assert.equal(context.querySelector(".unblock-reason").textContent, reason);
  const notes = context.querySelector(".unblock-notes").children.map((item) => item.textContent.replace(/^.*: /, ""));
  assert.deepEqual(notes, ["four", "three", "two"]);
});

test("Reload task refreshes the blocker reason and keeps the comment draft", async (t) => {
  const ui = await dashboard(t);
  ui.run("choose('blocked')");
  await ui.get("task-list").querySelector(".move").fire("click");
  const form = ui.get("move-body").querySelector("form");
  form.querySelector("textarea").value = "My draft";
  const { update } = await import("./factory.mjs");
  await update(join(ui.directory, factoryFile), {
    task: "issue-5", blocker: JSON.stringify({ reason: "A new reason." }),
  });
  await form.fire("submit");
  await form.querySelectorAll("button").find((button) => button.textContent === "Reload task").fire("click");
  assert.equal(form.querySelector(".unblock-reason").textContent, "A new reason.");
  assert.equal(form.querySelector("textarea").value, "My draft");
});

test("Move opens a separate popup whose draft survives refresh and conflict", async (t) => {
  const ui = await dashboard(t);
  ui.run("choose('blocked')");
  const list = ui.get("task-list");
  await list.querySelector(".move").fire("click");
  assert.equal(ui.get("move-dialog").open, true);
  assert.equal(ui.get("detail").hidden, false);
  const form = ui.get("move-body").querySelector("form");
  const comment = form.querySelector("textarea");
  const state = form.querySelector("select");
  assert.equal(ui.document.activeElement, state, "Opening Move must focus the destination, not the title.");
  state.value = "initial";
  comment.value = "This is now unblocked.\nUse the new docs setup.";
  comment.focus();
  const file = join(ui.directory, factoryFile);
  const { update } = await import("./factory.mjs");
  await update(file, { task: "issue-5", "next-action": "An agent changed the task while editing" });
  await ui.run("refresh()");
  assert.equal(ui.get("move-body").querySelector("textarea"), comment);
  assert.equal(ui.document.activeElement, comment);
  assert.equal(state.value, "initial");
  await form.fire("submit");
  assert.match(form.querySelector(".save-error").textContent, /changed since it was read/);
  assert.equal(form.querySelector(".save-error").hidden, false);
  assert.equal(ui.get("move-dialog").open, true);
  assert.equal(comment.value, "This is now unblocked.\nUse the new docs setup.");
  assert.equal(JSON.parse(await readFile(file, "utf8")).tasks.find((task) => task.id === "issue-5").state, "blocked");
  const reload = form.querySelectorAll("button").find((button) => button.textContent === "Reload task");
  await reload.fire("click");
  assert.equal(comment.value, "This is now unblocked.\nUse the new docs setup.");
  await form.fire("submit");
  const saved = JSON.parse(await readFile(file, "utf8")).tasks.find((task) => task.id === "issue-5");
  assert.equal(saved.state, "initial");
  assert.equal(saved.history.at(-1).note, comment.value);
  assert.equal(saved.feedback.acknowledged_id, null);
  assert.equal(ui.get("move-dialog").open, false);
  assert.equal(ui.get("detail").hidden, false);
  assert.equal(ui.get("detail").dataset.state, "blocked", "The list must stay on the state it showed.");
  assert.equal(ui.get("task-list").children.length, 0);
  assert.equal(ui.document.activeElement, ui.get("detail"), "After saving, focus must stay in the task panel.");
});

test("a pending move response does not close another task's draft", async (t) => {
  let markMoveStarted;
  const moveStarted = new Promise((resolve) => { markMoveStarted = resolve; });
  let releaseMoveResponse;
  const moveResponseReleased = new Promise((resolve) => { releaseMoveResponse = resolve; });
  const ui = await dashboard(t, {
    fetchRequest: async (path, _, request) => {
      const response = await request();
      if (path.startsWith("/api/move")) {
        markMoveStarted();
        await moveResponseReleased;
      }
      return response;
    },
  });
  ui.run("choose('blocked')");
  await ui.get("task-list").querySelector(".move").fire("click");
  const formA = ui.get("move-body").querySelector("form");
  formA.querySelector("select").value = "initial";
  formA.querySelector("textarea").value = "Move task A.";
  const saveA = formA.fire("submit");
  await moveStarted;
  await ui.get("close-move").fire("click");
  await ui.get("task-list").querySelector(".move").fire("click");
  const formB = ui.get("move-body").querySelector("form");
  const commentB = formB.querySelector("textarea");
  commentB.value = "Keep task B's draft.";
  commentB.focus();

  releaseMoveResponse();
  await saveA;

  assert.equal(ui.get("move-dialog").open, true);
  assert.equal(ui.get("move-body").querySelector("form"), formB);
  assert.equal(commentB.value, "Keep task B's draft.");
  assert.equal(ui.document.activeElement, commentB);
});

test("the move popup confirms before discarding a draft through Esc, close, or backdrop", async (t) => {
  const confirmations = [];
  let answer = false;
  const ui = await dashboard(t, { confirm: (message) => { confirmations.push(message); return answer; } });
  const file = join(ui.directory, factoryFile);
  const original = await readFile(file, "utf8");
  ui.run("choose('blocked')");
  const outside = { clientX: 950, clientY: 400 };
  const dismiss = [
    async () => {
      const event = await ui.get("move-dialog").fire("cancel");
      assert.equal(event.defaultPrevented, true, "Esc must suppress the dialog's default close.");
    },
    async () => ui.get("close-move").fire("click"),
    async () => {
      await ui.get("move-dialog").fire("pointerdown", outside);
      await ui.get("move-dialog").fire("click", outside);
    },
  ];
  for (const close of dismiss) {
    await ui.get("task-list").querySelector(".move").fire("click");
    const comment = ui.get("move-body").querySelector("textarea");
    comment.value = "Keep this draft";
    await close();
    assert.equal(ui.get("move-dialog").open, true, "Declining must keep the popup open.");
    assert.equal(comment.value, "Keep this draft");
    assert.equal(confirmations.at(-1), "Discard your unsaved comment?");

    answer = true;
    await close();
    assert.equal(ui.get("move-dialog").open, false, "Accepting must close the popup.");
    answer = false;
  }
  assert.equal(confirmations.length, dismiss.length * 2);

  for (const close of dismiss) {
    await ui.get("task-list").querySelector(".move").fire("click");
    const confirmationCount = confirmations.length;
    await close();
    assert.equal(ui.get("move-dialog").open, false, "An empty comment must close without confirmation.");
    assert.equal(confirmations.length, confirmationCount);
  }
  assert.equal(ui.get("detail").hidden, false);
  assert.equal(await readFile(file, "utf8"), original);
});

test("a saved move fades out before its row is removed, even during refresh", async (t) => {
  const ui = await dashboard(t, { reducedMotion: false });
  ui.run("choose('blocked')");
  const implementation = ui.run("nodeOf('implementation')");
  assert.equal(implementation.querySelector(".sub").textContent, "waiting");
  assert.ok(implementation.className.split(" ").includes("active"),
    "The running-worker activity indicator remains separate from the task label.");
  const list = ui.get("task-list");
  const row = list.children[0];
  const animation = {};
  let fades = 0;
  row.animate = (frames, options) => {
    fades += 1;
    assert.deepEqual(Array.from(frames.opacity), [1, 0]);
    assert.equal(options.duration, 300);
    return animation;
  };
  await row.querySelector(".move").fire("click");
  const form = ui.get("move-body").querySelector("form");
  form.querySelector("select").value = "initial";
  form.querySelector("textarea").value = "This is now unblocked.";
  await form.fire("submit");
  assert.equal(ui.get("move-dialog").open, false);
  assert.equal(fades, 1, "A successful move must start the row's fade.");
  assert.equal(list.children[0], row, "Keep the row until the fade finishes.");
  assert.equal(row.inert, true, "The departing row must not accept another move.");
  assert.equal(ui.get("detail-empty").hidden, true);
  const file = join(ui.directory, factoryFile);
  assert.equal(JSON.parse(await readFile(file, "utf8")).tasks.find((task) => task.id === "issue-5").state, "initial");
  await ui.run("refresh()");
  assert.equal(list.children[0], row, "Refresh must not cut the fade short.");
  assert.equal(fades, 1);
  animation.onfinish();
  assert.equal(list.children.length, 0);
  assert.equal(ui.get("detail-empty").hidden, false);
  assert.equal(ui.get("detail").dataset.state, "blocked");
});

test("a rejected move does not fade the row", async (t) => {
  const ui = await dashboard(t, { reducedMotion: false });
  ui.run("choose('blocked')");
  const row = ui.get("task-list").children[0];
  let faded = false;
  row.animate = () => { faded = true; return {}; };
  await row.querySelector(".move").fire("click");
  const form = ui.get("move-body").querySelector("form");
  form.querySelector("select").value = "initial";
  form.querySelector("textarea").value = "This is now unblocked.";
  const { update } = await import("./factory.mjs");
  await update(join(ui.directory, factoryFile), { task: "issue-5", "next-action": "Changed while editing" });
  await form.fire("submit");
  assert.match(form.querySelector(".save-error").textContent, /changed since it was read/);
  assert.equal(faded, false);
  assert.equal(ui.get("task-list").children[0], row);
  assert.equal(ui.get("move-dialog").open, true);
});

test("the popup can resolve an initial task with an outcome and comment", async (t) => {
  const ui = await dashboard(t);
  ui.run("choose('initial')");
  const button = ui.get("task-list").querySelector(".move");
  assert.ok(button, "An initial task must offer a move to resolved.");
  await button.fire("click");
  const form = ui.get("move-body").querySelector("form");
  const selects = form.querySelectorAll("select");
  const state = selects.find((select) => select.name === "state");
  const outcome = selects.find((select) => select.name === "resolution");
  assert.ok(state.options.some((option) => option.value === "resolved"), "Resolved must be selectable.");
  state.value = "resolved";
  await state.fire("change");
  assert.equal(outcome.disabled, false);
  assert.equal(outcome.value, "completed");
  outcome.value = "cancelled";
  const comment = form.querySelector("textarea");
  comment.value = "No longer needed. Stop work on this task.";
  await ui.run("refresh()");
  assert.equal(form.querySelectorAll("select").find((select) => select.name === "resolution").value, "cancelled");
  await form.fire("keydown", { key: "Enter" });
  assert.equal(form.submitted, undefined, "Plain Enter must not save the move.");
  await form.fire("keydown", { key: "Enter", metaKey: true });
  await form.submitted;
  const saved = JSON.parse(await readFile(join(ui.directory, factoryFile), "utf8"))
    .tasks.find((task) => task.id === "issue-12");
  assert.equal(saved.state, "resolved");
  assert.equal(saved.resolution.outcome, "cancelled");
  assert.equal(saved.resolution.note, comment.value);
  assert.equal(saved.feedback.acknowledged_id, null);
  assert.equal(ui.get("detail").dataset.state, "initial");
});

test("the Settings item at the bottom of the sidebar opens one settings dialog", async (t) => {
  assert.match(html, /<nav id="factories"[^>]*><\/nav>\s*<div id="sidebar-footer">\s*<button id="open-settings" class="factory-item" type="button" aria-label="Settings">[\s\S]*?<span class="name">Settings<\/span>/);
  const ui = await dashboard(t);
  await ui.get("open-settings").fire("click");
  assert.equal(ui.get("settings-dialog").open, true);
  const form = ui.get("settings-body").querySelector("form");
  assert.deepEqual(form.querySelectorAll("input").map((input) => input.value), ["10", "3", "3"]);
  const [spend, cap] = form.querySelectorAll("select");
  assert.deepEqual([spend.value, cap.value], ["", ""]);
  assert.deepEqual(spend.options.map((option) => option.value), ["", "standard", "high", "max"]);
  assert.deepEqual(cap.options.map((option) => option.value), ["", "L0", "L1", "L2", "L3", "L4", "L5"]);
  assert.match(form.textContent, /Latest recorded autonomy: L4 \(issue-3\)/);
  ui.get("detail").hidden = false;
  ui.press("Escape");
  assert.equal(ui.get("detail").hidden, false, "Escape must not close the task panel behind the dialog.");
});

test("the settings dialog keeps its draft across refresh, reports a conflict, and sends only changed fields", async (t) => {
  const confirms = [];
  const ui = await dashboard(t, { confirm: (message) => { confirms.push(message); return false; } });
  const file = join(ui.directory, factoryFile);
  await ui.get("open-settings").fire("click");
  const form = ui.get("settings-body").querySelector("form");
  const [budget, investigation, implementation] = form.querySelectorAll("input");
  const [, cap] = form.querySelectorAll("select");
  assert.equal(ui.document.activeElement, budget);
  budget.value = "6";
  cap.value = "L2";
  const { update } = await import("./factory.mjs");
  await update(file, { budget: '{"max_parallel_workers":8}', limits: '{"implementation":4}' });
  await ui.run("refresh()");
  assert.equal(ui.get("settings-body").querySelector("input"), budget);
  assert.equal(budget.value, "6");
  await form.fire("submit");
  assert.match(form.querySelector(".save-error").textContent, /Budget changed since it was read/);
  assert.equal(ui.get("settings-dialog").open, true);
  assert.equal(JSON.parse(await readFile(file, "utf8")).budget.max_parallel_workers, 8);
  await ui.get("close-settings").fire("click");
  assert.equal(confirms.length, 1, "A changed value asks before discarding.");
  assert.equal(ui.get("settings-dialog").open, true);
  const reload = form.querySelectorAll("button").find((button) => button.textContent === "Reload settings");
  await reload.fire("click");
  assert.equal(budget.value, "6", "Reload keeps the draft.");
  assert.equal(cap.value, "L2");
  assert.equal(implementation.value, "4", "Reload refreshes fields the user did not touch.");
  await form.fire("submit");
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.budget.max_parallel_workers, 6);
  assert.deepEqual(saved.limits, { investigation: 3, implementation: 4 });
  assert.deepEqual(saved.lever, { autonomy_cap: "L2" });
  assert.equal(investigation.value, "3");
  assert.equal(ui.get("settings-dialog").open, false);
});

test("the settings dialog validates numbers before sending and saves nothing when nothing changed", async (t) => {
  const ui = await dashboard(t);
  const file = join(ui.directory, factoryFile);
  const original = await readFile(file, "utf8");
  await ui.get("open-settings").fire("click");
  const form = ui.get("settings-body").querySelector("form");
  const [budget, investigation] = form.querySelectorAll("input");
  for (const [input, value, back] of [[budget, "0", "10"], [budget, "", "10"], [budget, "101", "10"],
    [investigation, "1.5", "3"], [investigation, "", "3"]]) {
    input.value = value;
    await form.fire("submit");
    assert.match(form.querySelector(".save-error").textContent, /must be a whole number from 1 to 100/, value);
    assert.equal(await readFile(file, "utf8"), original);
    input.value = back;
  }
  await form.fire("submit");
  assert.equal(ui.get("settings-dialog").open, false);
  assert.equal(await readFile(file, "utf8"), original);
});

test("the delegate-always rule is present in the agent, skill, and plugin rules", () => {
  const plugin = join(__dirname, "..", "..");
  for (const file of [
    join(plugin, "agents", "general.agent.md"),
    join(__dirname, "SKILL.md"),
    join(plugin, "AGENTS.md"),
  ]) {
    const text = readFileSync(file, "utf8");
    assert.match(text, /never do(es)? (actual )?work or investigation/i, file);
    assert.match(text, /git rebase main/, file);
    assert.match(text, /git merge --ff-only/, file);
    assert.doesNotMatch(text, /git merge --no-ff/, file);
    assert.match(text, /claude-sonnet-5\.5/, file);
    assert.match(text, /never use `git stash`|never to use `git stash`/i, file);
    assert.match(text, /never\s+waits?\s+on\s+another\s+task/i, file);
    assert.match(text, /only\s+for\s+a\s+user\s+decision/i, file);
    assert.match(text, /never\s+uses?\s+the\s+`task`,\s+`read_agent`,?\s+or\s+`write_agent`\s+tools/i, file);
    assert.match(text, /Copilot\s+session\s+in\s+a\s+Rex\s+tab/, file);
  }
});

test("the agent, skill, and plugin rules say the coordinator never exceeds the budget", () => {
  const plugin = join(__dirname, "..", "..");
  for (const file of [join(plugin, "agents", "general.agent.md"), join(__dirname, "SKILL.md"), join(plugin, "AGENTS.md")]) {
    const text = readFileSync(file, "utf8");
    assert.match(text, /budget\.max_parallel_workers/, file);
    assert.match(text, /never\s+exceeds?\s+(it|the\s+budget)/i, file);
  }
});

test("the rules say only the user's click answers an attention prompt, and only an ask_user one", () => {
  const plugin = join(__dirname, "..", "..");
  const agents = readFileSync(join(plugin, "AGENTS.md"), "utf8");
  const skill = readFileSync(join(__dirname, "SKILL.md"), "utf8");
  for (const [text, file] of [[agents, "AGENTS.md"], [skill, "SKILL.md"]]) {
    assert.match(text, /click/, file);
    assert.doesNotMatch(text, /dashboard\s+shows\s+the\s+open\s+items\s+read\s+only|dashboard\s+never\s+answers\s+a\s+prompt/i, file);
  }
  assert.match(agents, /POST \/api\/attention\/answer/);
  assert.match(agents, /coordinator\s+still\s+never\s+answers/);
  assert.match(skill, /never\s+answer\s+the\s+prompt,\s+never\s+type\s+or\s+send\s+keys\s+into\s+the\s+pane/);
  assert.match(html, /Pick an option to type it into the pane/);
});

test("the worker write boundary is present in the skill and plugin rules", () => {
  for (const file of [join(__dirname, "SKILL.md"), join(__dirname, "..", "..", "AGENTS.md")]) {
    const text = readFileSync(file, "utf8");
    assert.match(text, /only\s+writable\s+root/i, file);
    assert.match(text, /primary checkout/, file);
    assert.match(text, /read\s+`plugins\/factory\/AGENTS\.md`\s+before\s+(its|the)\s+first\s+edit/i, file);
  }
});

test("the standing cost lines are one block in the skill and are mapped in improve.md", () => {
  const skill = readFileSync(join(__dirname, "SKILL.md"), "utf8");
  const block = skill.match(/Standing cost lines:\n([\s\S]*?)\n```/);
  assert.ok(block, "SKILL.md has the standing cost lines block");
  const lines = block[1];
  assert.match(lines, /1\. Never poll\..*no self-wake schedule shorter than 20\s+minutes.*`node PR_WATCH`.*blocking waiter/s);
  assert.match(lines, /2\. View a file before you edit it\..*edit, not create, for a file that\s+exists/s);
  assert.match(lines, /3\. This brief has the default for every decision.*nudges in one message/s);
  assert.match(lines, /4\. When the PR is handed to review.*`waiting` result.*fresh\s+worker.*short handoff/s);
  const improve = readFileSync(join(__dirname, "improve.md"), "utf8");
  for (const signal of ["tools.manage_schedule.calls", "tools.create.failures", "tools.edit.failures", "idle.over_10_minutes"]) {
    assert.ok(improve.includes(signal), signal);
  }
  assert.match(readFileSync(join(__dirname, "..", "..", "AGENTS.md"), "utf8"), /four\s+standing\s+cost\s+lines/);
});

test("the worker deny flags are one identical constant in the skill and plugin rules", () => {
  const constants = [join(__dirname, "SKILL.md"), join(__dirname, "..", "..", "AGENTS.md")].map((file) => {
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.startsWith("--deny-tool="));
    assert.equal(lines.length, 1, file);
    return lines[0];
  });
  assert.equal(constants[0], constants[1]);
  for (const rule of ["shell(git stash)", "shell(rex window:*)", "shell(rex session:*)", "shell(rex block:*)"]) {
    assert.ok(constants[0].includes(`--deny-tool='${rule}'`), rule);
  }
});

test("code-like text renders as inline code, escaped, once, and without touching links", async (t) => {
  const ui = await dashboard(t);
  const parts = (text) => JSON.parse(ui.run(`JSON.stringify(codeParts(${JSON.stringify(text)})
    .map((part) => typeof part === "string" ? part : { code: part.textContent, tag: part.tag }))`));
  const uuid = "01a1ec42-3b1e-7470-b269-912f7f7bd4fd";
  const sha = "be66032a1b2c3d4e5f60718293a4b5c6d7e8f901";
  for (const value of [uuid, `block:${uuid}`, `window:${uuid}`, "be66032", sha, "~/.copilot/state/x.json", "/tmp/a/b", "dashboard.test.cjs"]) {
    assert.deepEqual(parts(`see ${value} now`), ["see ", { code: value, tag: "code" }, " now"], value);
  }
  assert.deepEqual(parts("run `npm test -- -x` and `abc1234`"),
    ["run ", { code: "npm test -- -x", tag: "code" }, " and ", { code: "abc1234", tag: "code" }]);
  for (const plain of ["defaced", "1234567", "and/or", "plain words, e.g. this."]) {
    assert.deepEqual(parts(plain), [plain]);
  }
  assert.deepEqual(parts("<b>x</b> abc1234"), ["<b>x</b> ", { code: "abc1234", tag: "code" }]);
  assert.deepEqual(parts(`${uuid} ${uuid}`).filter((part) => part.code).length, 2);
});

test("commit hashes, #N, owner/repo#N and GitHub URLs become safe links", async (t) => {
  const ui = await dashboard(t);
  const parts = (text) => JSON.parse(ui.run(`JSON.stringify(codeParts(${JSON.stringify(text)}).map((part) => {
    if (typeof part === "string") return part;
    const anchor = part.tag === "a" ? part : part.children[0];
    return { tag: part.tag, text: part.textContent, ...(anchor?.tag === "a" ? { href: anchor.href, target: anchor.target, rel: anchor.rel } : {}) };
  }))`));
  const link = (text, href) => ({ tag: "a", text, href, target: "_blank", rel: "noopener noreferrer" });
  ui.run('snapshot.project = "github/runtime"');
  assert.deepEqual(parts("Fixed by `76b60939`, see PR #40789 and other/repo#9."), [
    "Fixed by ", { tag: "code", text: "76b60939", href: "https://github.com/github/runtime/commit/76b60939", target: "_blank", rel: "noopener noreferrer" },
    ", see PR ", link("#40789", "https://github.com/github/runtime/issues/40789"), " and ",
    link("other/repo#9", "https://github.com/other/repo/issues/9"), ".",
  ]);
  assert.deepEqual(parts("abc1234 and https://github.com/o/r/pull/1."), [
    { tag: "code", text: "abc1234", href: "https://github.com/github/runtime/commit/abc1234", target: "_blank", rel: "noopener noreferrer" },
    " and ", link("https://github.com/o/r/pull/1", "https://github.com/o/r/pull/1"), ".",
  ]);
  assert.deepEqual(parts("deadbeef C#1 a&#12"), ["deadbeef C#1 a&#12"]);
  assert.deepEqual(parts("<b>#5</b>"), ["<b>", link("#5", "https://github.com/github/runtime/issues/5"), "</b>"]);
  assert.deepEqual(parts("`run #5 now`"), [{ tag: "code", text: "run #5 now" }]);
  ui.run('snapshot.project = "not a repo"');
  assert.deepEqual(parts("abc1234 #5 other/repo#9"), [
    { tag: "code", text: "abc1234" }, " #5 ", link("other/repo#9", "https://github.com/other/repo/issues/9"),
  ]);
});

test("a link inside a suggested answer does not pick the answer", async (t) => {
  const ui = await dashboard(t);
  const data = structuredClone(example);
  data.tasks.find((item) => item.id === "issue-5").blocker.options = [{ label: "Merge #7" }];
  await writeFile(join(ui.directory, factoryFile), JSON.stringify(data));
  await ui.run("refresh()");
  ui.run("choose('blocked')");
  await ui.get("task-list").querySelector(".move").fire("click");
  const anchor = ui.get("move-body").querySelector(".option").querySelector("a");
  assert.equal(anchor.href, "https://github.com/owner/repo/issues/7");
  let stopped = false;
  await anchor.fire("click", { stopPropagation: () => { stopped = true; } });
  assert.ok(stopped);
});

test("rows wrap UUIDs, SHAs, panes, paths and backticked text in code and keep links", async (t) => {
  const ui = await dashboard(t);
  const pane = "block:01a1ec42-3b1e-7470-b269-912f7f7bd4fd";
  const task = structuredClone(example.tasks.find((item) => item.id === "issue-5"));
  task.blocker.reason = "Run `npm test` after be66032 lands in /tmp/work/tree. Check `a.json`.";
  task.worktree = { path: "/tmp/work/tree", branch: "x" };
  task.workers = { implementation: { status: "running", name: "Fix 9a8b7c6", pane, brief: "brief.md", result: "result.json" } };
  task.history.at(-1).note = "Merged as 0123abc.";
  const row = ui.run(`taskRow(${JSON.stringify(task)}, new Set())`);
  const codes = row.querySelectorAll("code").map((node) => node.textContent);
  for (const expected of ["npm test", "be66032", "/tmp/work/tree", "a.json", "9a8b7c6", pane, "0123abc"]) {
    assert.ok(codes.includes(expected), `${expected} in ${JSON.stringify(codes)}`);
  }
  assert.ok(codes.every((value) => !value.includes("`")));
  const worker = row.querySelector(".workers").querySelector("li");
  assert.ok(worker.querySelectorAll("code").some((node) => node.textContent === pane));
  assert.ok(worker.querySelectorAll("a").length >= 1, "Artifact links stay links.");
  assert.equal(row.querySelector(".blocker-options").querySelectorAll("li").length, task.blocker.options.length);
});

test("the unblock popup wraps backticked option labels in code inside the button", async (t) => {
  const ui = await dashboard(t);
  const data = structuredClone(example);
  data.tasks.find((item) => item.id === "issue-5").blocker.options = [{ label: "Run `gh auth login` first" }];
  await writeFile(join(ui.directory, factoryFile), JSON.stringify(data));
  await ui.run("refresh()");
  ui.run("choose('blocked')");
  await ui.get("task-list").querySelector(".move").fire("click");
  const choice = ui.get("move-body").querySelector(".option");
  assert.equal(choice.querySelector("code").textContent, "gh auth login");
  assert.equal(choice.textContent, "Run gh auth login first");
});

test("Cmd+K and Ctrl+K toggle the task palette, and other dialogs keep it closed", async (t) => {
  const ui = await dashboard(t);
  const palette = ui.get("palette-dialog");
  assert.equal(ui.press("k").defaultPrevented, false);
  assert.equal(palette.open, false);
  assert.equal(ui.press("k", { metaKey: true }).defaultPrevented, true);
  assert.equal(palette.open, true);
  assert.equal(ui.press("K", { ctrlKey: true }).defaultPrevented, true);
  assert.equal(palette.open, false);
  ui.press("k", { ctrlKey: true });
  assert.equal(palette.open, true);
  assert.equal(ui.get("palette-list").children.length, 5);
  palette.open = false;

  for (const id of ["settings-dialog", "move-dialog"]) {
    ui.get(id).open = true;
    assert.equal(ui.press("k", { metaKey: true }).defaultPrevented, false, id);
    assert.equal(palette.open, false, id);
    ui.get(id).open = false;
  }
});

test("r refreshes like the button, and is ignored while typing, with modifiers, or with a dialog open", async (t) => {
  const answers = [];
  const ui = await dashboard(t, {
    fetchRequest: async (path, _, request) => {
      answers.push(path.split("?")[0]);
      return request();
    },
  });
  const calls = () => answers.filter((path) => path === "/api/factory").length;
  const ignored = async (event, setup = () => {}) => {
    const before = calls();
    setup(true);
    const dispatched = ui.press("r", event);
    await ui.run("running");
    setup(false);
    assert.equal(calls(), before, JSON.stringify(event));
    assert.equal(dispatched.defaultPrevented, false);
  };
  answers.length = 0;
  for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey"]) await ignored({ [modifier]: true });
  await ignored({ target: { closest: () => ({}) } });
  await ignored({ repeat: true });
  await ignored({}, (open) => { ui.get("settings-dialog").open = open; });
  await ignored({}, (open) => { ui.get("palette-dialog").open = open; });

  const dispatched = ui.press("r");
  assert.equal(dispatched.defaultPrevented, true);
  await ui.run("running");
  assert.equal(calls(), 1);
  assert.match(html, /<button id="refresh"[^>]* title="[^"]*\(R\)"[^>]* aria-keyshortcuts="r"/);
});

test("the Refresh button is disabled and busy while a refresh runs, and works again after it ends, also on failure", async (t) => {
  let release;
  let reached;
  let fail = false;
  let hold = false;
  const ui = await dashboard(t, {
    fetchRequest: async (path, _, request) => {
      if (hold && path.startsWith("/api/factory?")) {
        await new Promise((resolve) => { release = resolve; reached(); });
        if (fail) throw new Error("boom");
      }
      return request();
    },
  });
  const hit = () => new Promise((resolve) => { reached = resolve; });
  const button = ui.get("refresh");
  assert.equal(button.disabled === true, false);
  hold = true;
  let held = hit();
  const first = button.fire("click");
  assert.equal(button.disabled, true);
  assert.equal(button["aria-busy"], "true");

  await held;
  const before = ui.run("running");
  await ui.press("r");
  await button.fire("click");
  assert.equal(ui.run("running"), before, "Neither the key nor a click starts a second refresh.");

  release();
  await first;
  assert.equal(button.disabled, false);
  assert.equal(button["aria-busy"], "false");

  fail = true;
  held = hit();
  const second = button.fire("click");
  assert.equal(button.disabled, true);
  await held;
  release();
  await second;
  assert.equal(button.disabled, false);
  assert.equal(button["aria-busy"], "false");

  fail = false;
  hold = false;
  ui.press("r");
  assert.equal(button.disabled, true, "The key shows the same busy state as a click.");
  await ui.run("running");
  await null;
  assert.equal(button.disabled, false);
});

test("every button gets a pressed state, and the slide respects reduced motion", () => {
  assert.match(html, /\n {6}button:active:not\(:disabled\), \.factory-item:active:not\(:disabled\) \{ background: var\(--btn-active\); \}/);
  assert.match(html, /\n {6}\.action-primary:active:not\(:disabled\) \{ background: var\(--btn-primary-active\); \}/);
  const motion = html.match(/@media \(prefers-reduced-motion: no-preference\) \{\s*button:active:not\(:disabled\) \{([^}]*)\}/);
  assert.match(motion?.[1] ?? "", /transform: translateY\(1px\)/);
  assert.doesNotMatch(html.replace(motion?.[0] ?? "", ""), /button:active[^{]*\{[^}]*transform/);
});

test("palette rows show the task reference with the same glyph as links", async (t) => {
  const ui = await dashboard(t);
  ui.press("k", { metaKey: true });
  const meta = ui.get("palette-list").children[0].querySelector(".option-meta");
  const ref = meta.querySelector(".ref");
  assert.equal(ref.querySelector("svg").tag, "svg", "The #N meta gets the same glyph as the links.");
  assert.equal(meta.querySelectorAll("a").length, 0);
});

test("Cmd+K opens the palette from the physical key when event.key is not a letter, and ignores repeats", async (t) => {
  const ui = await dashboard(t);
  const palette = ui.get("palette-dialog");
  assert.equal(ui.press("Dead", { code: "KeyK", metaKey: true }).defaultPrevented, true);
  assert.equal(palette.open, true);
  assert.equal(ui.press("Dead", { code: "KeyK", metaKey: true, repeat: true }).defaultPrevented, true);
  assert.equal(palette.open, true, "A held key must not close the palette.");
  palette.open = false;
  assert.equal(ui.press("л", { code: "KeyK", ctrlKey: true }).defaultPrevented, true);
  assert.equal(palette.open, true);
  palette.open = false;
  assert.equal(ui.press("v", { code: "KeyK", metaKey: true }).defaultPrevented, false, "Dvorak Cmd+V is not ours.");
  assert.equal(ui.press("Dead", { code: "KeyK" }).defaultPrevented, false);
  assert.equal(palette.open, false);
});

test("typing in the palette filters tasks and Escape closes it without closing the docked list", async (t) => {
  const ui = await dashboard(t);
  ui.run("choose('blocked')");
  ui.press("k", { metaKey: true });
  const input = ui.get("palette-input");
  input.value = "retry";
  await input.fire("input");
  assert.deepEqual(ui.get("palette-list").children.map((option) => option.dataset.taskId), ["issue-9"]);
  assert.equal(ui.get("palette-status").textContent, "1 task");
  assert.match(ui.get("palette-list").children[0].textContent, /Retry loop never stops on 401/);
  assert.equal(input["aria-activedescendant"], "palette-option-0");
  input.value = "nothing matches";
  await input.fire("input");
  assert.equal(ui.get("palette-list").children.length, 0);
  assert.equal(ui.get("palette-status").textContent, "0 tasks");

  ui.press("Escape");
  assert.equal(ui.get("detail").hidden, false, "Escape with the palette open must not close the docked list.");
  const event = await ui.get("palette-dialog").fire("cancel");
  assert.equal(event.defaultPrevented, true);
  assert.equal(ui.get("palette-dialog").open, false);
  assert.equal(ui.get("detail").hidden, false);
  ui.press("Escape");
  assert.equal(ui.get("detail").hidden, true);
});

test("palette arrows wrap and Enter docks the task's list and focuses its row", async (t) => {
  const ui = await dashboard(t, { reducedMotion: false });
  ui.press("k", { metaKey: true });
  const input = ui.get("palette-input");
  const options = () => ui.get("palette-list").children.map((option) => option["aria-selected"]);
  assert.deepEqual(options(), ["true", "false", "false", "false", "false"]);
  assert.equal((await input.fire("keydown", { key: "ArrowUp" })).defaultPrevented, true);
  assert.deepEqual(options(), ["false", "false", "false", "false", "true"]);
  await input.fire("keydown", { key: "ArrowDown" });
  await input.fire("keydown", { key: "ArrowDown" });
  assert.deepEqual(options(), ["false", "true", "false", "false", "false"]);

  input.value = "issue-3";
  await input.fire("input");
  await input.fire("keydown", { key: "Enter" });
  assert.equal(ui.get("palette-dialog").open, false);
  assert.equal(ui.run("location.hash"), "#resolved/merged");
  const row = ui.get("task-list").children.find((item) => item.dataset.taskId === "issue-3");
  assert.ok(row);
  assert.equal(ui.document.activeElement, row);
  assert.deepEqual([row.scrolled.block, row.scrolled.behavior], ["center", "smooth"]);
  assert.match(row.className, /task-flash/);
  await row.fire("blur");
  assert.doesNotMatch(row.className, /task-flash/);

  ui.press("k", { ctrlKey: true });
  input.value = "issue-5";
  await input.fire("input");
  await ui.get("palette-list").children[0].fire("click");
  assert.equal(ui.run("location.hash"), "#blocked");
  assert.equal(ui.get("task-list").children[0].dataset.taskId, "issue-5");
});

test("a card shows the worker summary for its state, else the newest, and folds a long one", async (t) => {
  const ui = await dashboard(t);
  const task = structuredClone(example.tasks.find((item) => item.id === "issue-5"));
  const long = `Plan for #12 and be66032: ${"step ".repeat(60)}`;
  task.state = "review";
  task.workers = {
    investigation: { status: "closed", summary: "Old finding.", summary_at: "2026-05-01T10:00:00Z" },
    implementation: { status: "closed", summary: long, summary_at: "2026-05-02T10:00:00Z" },
  };
  const card = (value) => ui.run(`taskRow(${JSON.stringify(value)}, new Set())`);
  let row = card(task);
  const heading = (node) => node.querySelector("h4").textContent;
  assert.equal(heading(row.querySelector(".summary")), "implementation summary", "No review summary: the newest wins.");
  task.state = "investigation";
  row = card(task);
  assert.equal(heading(row.querySelector(".summary")), "investigation summary", "The current state's role wins.");
  assert.equal(row.querySelector(".summary-toggle"), null, "A short summary has no toggle.");
  assert.equal(row.querySelector(".summary-text").className, "summary-text");

  task.state = "implementation";
  row = card(task);
  const body = row.querySelector(".summary-text");
  const toggle = row.querySelector(".summary-toggle");
  assert.ok(body.className.includes("clamped"));
  assert.equal(toggle.textContent, "Show more");
  assert.ok(body.querySelectorAll("a").length >= 1, "References stay links.");
  await toggle.fire("click");
  assert.ok(!body.className.includes("clamped"));
  assert.equal(toggle.textContent, "Show less");
  assert.ok(!card(task).querySelector(".summary-text").className.includes("clamped"), "A rebuilt row stays expanded.");
  await toggle.fire("click");
  assert.ok(body.className.includes("clamped"));

  task.workers = {};
  assert.equal(card(task).querySelector(".summary"), null, "No summary, no block.");
});

test("the palette button opens the palette, but not over another dialog", async (t) => {
  const ui = await dashboard(t);
  await ui.get("open-palette").fire("click");
  assert.equal(ui.get("palette-dialog").open, true);
  assert.equal(ui.get("palette-list").children.length, 5);
  ui.get("palette-dialog").open = false;
  ui.get("move-dialog").open = true;
  await ui.get("open-palette").fire("click");
  assert.equal(ui.get("palette-dialog").open, false);
});

test("the page works on a phone: viewport, safe areas, touch sizes and contained overflow", () => {
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
  assert.match(html, /<div id="flow-wrap">\s*<svg id="flow"/);
  assert.match(html, /\n {6}#open-palette, #refresh \{ display: inline-flex;/, "Both buttons show on desktop.");
  for (const id of ["open-palette", "refresh"]) {
    const [, button] = html.match(new RegExp(`(<button id="${id}"[\\s\\S]*?</button>)`));
    assert.match(button, /<svg [^>]*aria-hidden="true"/, `${id} has an icon.`);
    assert.match(button, /<span class="label">/, `${id} keeps its text on desktop.`);
    const name = id === "refresh" ? "Refresh" : "Go to task";
    assert.match(button, new RegExp(`aria-label="${name}" title="${name}( \\(R\\))?"`));
  }

  const blocks = (query) => {
    const found = [];
    for (let start = html.indexOf(`@media ${query} {`); start !== -1; start = html.indexOf(`@media ${query} {`, start + 1)) {
      let depth = 0;
      let index = html.indexOf("{", start);
      for (; index < html.length; index += 1) {
        if (html[index] === "{") depth += 1;
        if (html[index] === "}" && --depth === 0) break;
      }
      found.push(html.slice(start, index + 1));
    }
    assert.notEqual(found.length, 0, query);
    return found.join("\n");
  };
  const narrow = blocks("(max-width: 700px)");
  const touch = blocks("(max-width: 700px), (pointer: coarse)");
  assert.match(narrow, /#open-palette, #refresh \{[^}]*width: 44px;/, "Icon-only buttons are 44px wide.");
  assert.match(narrow, /#open-palette \.label, #refresh \.label \{ display: none; \}/, "The button text is hidden on a phone.");
  assert.doesNotMatch(touch, /\.label/, "Touch screens wider than a phone keep the text.");
  assert.match(touch, /button, select, input, textarea \{ min-height: 44px; font-size: 16px; \}/);
  assert.match(touch, /\.icon-button \{ width: 44px; height: 44px; \}/);
  assert.match(narrow, /env\(safe-area-inset-top\)/);
  assert.match(narrow, /env\(safe-area-inset-bottom\)/);
  assert.match(narrow, /#flow \{ min-width: 0; max-height: none; \}/, "The vertical chart is as tall as it needs to be.");
  assert.doesNotMatch(narrow, /#flow-wrap/, "The flowchart has no scroller on a phone.");
  assert.doesNotMatch(narrow, /overflow-x: auto/);
  assert.match(html, /<svg id="flow" viewBox="0 0 1160 560"/);
  assert.match(narrow, /#flow\.vertical \.node \.name \{ font-size: 17px;/, "Names are at least 14px, at scale 1.");
  assert.match(narrow, /#flow\.vertical \.node \.sub \{ font-size: 14px;/);
  assert.match(narrow, /#flow\.vertical \.outcome text \{ font-size: 14px; \}/);
  assert.match(narrow, /dialog, #move-dialog, #settings-dialog \{ width: 100%;/);

  const widths = [...(narrow + touch).matchAll(/(?<![-\w])(?:width|min-width): (\d+)px/g)].map((match) => Number(match[1]));
  assert.deepEqual(widths.filter((width) => width > 430), [], "Nothing on a phone is wider than the screen.");
});

test("on a phone the project switcher is a dropdown beside a settings button, and desktop keeps the sidebar", () => {
  const narrow = html.slice(html.indexOf("@media (max-width: 700px) {\n        .bar"));
  assert.match(html, /\n {6}#project-bar \{ display: none; \}/, "The switcher is hidden on desktop.");
  assert.match(narrow, /\.brand, #sidebar \{ display: none; \}/, "The brand and the sidebar, with its Settings item, are hidden.");
  assert.match(narrow, /#project-bar \{ display: flex;/);
  assert.match(html, /<div id="project-bar">\s*<div id="project-switch">\s*<button id="project-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="project-menu"[^>]*aria-label="Switch project"/);
  assert.match(html, /<nav id="project-menu"[^>]*hidden><\/nav>\s*<\/div>\s*<button id="bar-settings"[^>]*aria-label="Settings"/, "The settings button follows the dropdown.");
});

test("the sidebar has a fixed width and the selected item does not change its box", () => {
  const sidebar = html.match(/\n {6}#sidebar \{[^}]*\}/)[0];
  assert.match(sidebar, /width: clamp\(240px, 22vw, 360px\);/);
  assert.doesNotMatch(sidebar, /max-content|min-width|max-width/);
  const selected = html.match(/\.factory-item\[aria-current="true"\] \{[^}]*\}/)[0];
  assert.doesNotMatch(selected, /font-weight|padding|border-width|border:/);
});

test("the project dropdown lists the sorted factories, switches on a pick, and closes on Escape or an outside click", async (t) => {
  const ui = await dashboard(t);
  await writeFile(join(ui.directory, "other.repo-factory.json"),
    JSON.stringify({ ...example, id: "other-factory", project: "other/repo", updated_at: "2026-05-01T12:00:00Z" }));
  await ui.run("refresh()");
  const toggle = ui.get("project-toggle");
  const menu = ui.get("project-menu");
  const names = () => menu.querySelectorAll(".name").map((name) => name.textContent);
  assert.equal(ui.get("project-name").textContent, "owner/repo");
  assert.equal(toggle["aria-label"], "Switch project, current: owner/repo");
  assert.deepEqual(names(), ["other/repo", "owner/repo"], "The menu keeps the sidebar order.");
  assert.equal(menu.hidden, true);

  const inside = { closest: (selector) => selector === "#project-switch" ? menu : null };
  await toggle.fire("click");
  await ui.document.listeners.get("click")({ target: inside });
  assert.equal(menu.hidden, false);
  assert.equal(toggle["aria-expanded"], "true");
  assert.equal(menu.querySelectorAll("button")[1]["aria-current"], "true");
  assert.equal(menu.querySelectorAll("kbd").length, 0, "A phone has no digit shortcuts.");

  const escape = ui.press("Escape");
  assert.equal(escape.defaultPrevented, true);
  assert.equal(menu.hidden, true);
  assert.equal(ui.document.activeElement, toggle);
  assert.equal(toggle["aria-expanded"], "false");

  await toggle.fire("click");
  await ui.document.listeners.get("click")({ target: { closest: () => null } });
  assert.equal(menu.hidden, true, "A click outside closes the menu.");

  await toggle.fire("click");
  await menu.querySelectorAll("button")[0].fire("click");
  assert.equal(menu.hidden, true);
  assert.match(ui.run("location.href"), /file=other\.repo-factory\.json/);
  assert.equal(ui.get("project-name").textContent, "other/repo");

  await ui.get("bar-settings").fire("click");
  assert.equal(ui.get("settings-dialog").open, true, "The settings button opens the settings dialog.");
});

test("the factory payload lists pending attention oldest first, and its tag follows the events", async (t) => {
  const { url, directory } = await server(t);
  const path = `/api/factory?file=${factoryFile}`;
  const log = (id, type, at, data, task = null) => appendFile(join(directory, "owner.repo-factory-events.jsonl"),
    `${JSON.stringify({ id, at, type, task, source: "attention", data })}\n`);
  const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const read = (tag) => get(url, path, tag ? { headers: { "If-None-Match": tag } } : undefined);

  const first = await read();
  assert.deepEqual((await first.json()).attention, []);
  const empty = first.headers.get("etag");

  await log("e1", "attention.requested", ago(1), { session: "s-new", kind: "ask-user", text: "Pick one", options: ["a", "b"], role: "implementation" }, "issue-5");
  await log("e2", "attention.requested", ago(9), { session: "s-old", kind: "permission", text: "Run command: ls" });
  const changed = await read(empty);
  assert.equal(changed.status, 200, "A new item changes the tag while the factory file stays the same.");
  const tag = changed.headers.get("etag");
  assert.notEqual(tag, empty);
  const { attention } = await changed.json();
  assert.deepEqual(attention.map((item) => item.session), ["s-old", "s-new"]);
  assert.deepEqual(attention[1], {
    id: "e1", session: "s-new", kind: "ask-user", text: "Pick one", options: ["a", "b"], role: "implementation",
    pane: null, task: "issue-5", at: attention[1].at,
  });
  assert.equal((await read(tag)).status, 304);

  await log("e3", "attention.resolved", ago(0), { session: "s-old" });
  const resolved = await read(tag);
  assert.equal(resolved.status, 200);
  assert.notEqual(resolved.headers.get("etag"), tag);
  assert.deepEqual((await resolved.json()).attention.map((item) => item.session), ["s-new"]);
});

test("the factory payload drops an item whose pane is gone, and records its resolution", async (t) => {
  const bin = await mkdtemp(join(tmpdir(), "factory-dashboard-rex-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  // Like the real rex: `block ls -A --json` is an error; `-q --short=false` lists full IDs.
  await writeFile(join(bin, "rex"), `#!/bin/sh
[ "$1" = "--autostart=false" ] && shift
case "$*" in
  "block ls -A -q --short=false") echo block:01a1f4e8-4bb0-72d2-bff2-25420482aad9 ;;
  *) echo "Error: rex block ls --json requires one session. Pass -s SESSION" >&2; exit 1 ;;
esac
`);
  await chmod(join(bin, "rex"), 0o755);
  const { url, directory } = await server(t, { PATH: `${bin}${delimiter}${process.env.PATH}` });
  const events = join(directory, "owner.repo-factory-events.jsonl");
  const at = new Date(Date.now() - 20 * 60_000).toISOString();
  const request = (id, session, pane) => ({ id, at, type: "attention.requested", task: null, source: "attention",
    data: { session, kind: "sandbox-bypass", text: "Run command: ls", role: "backlog", pane } });
  await appendFile(events, [
    request("e1", "s-gone", "block:01a1f4d3-c03e-7f0b-bc24-060b0352db5f"),
    request("e2", "s-live", "block:01a1f4e8-4bb0-72d2-bff2-25420482aad9"),
  ].map((event) => `${JSON.stringify(event)}\n`).join(""));

  const path = `/api/factory?file=${factoryFile}`;
  assert.deepEqual((await (await get(url, path)).json()).attention.map((item) => item.session), ["s-live"]);
  await get(url, path);
  const resolved = (await readFile(events, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    .filter(({ type }) => type === "attention.resolved");
  assert.deepEqual(resolved.map(({ source, data }) => [source, data.session, data.reason]), [["attention", "s-gone", "pane-gone"]]);
});

test("answering types the picked option into the pane of a pending ask_user prompt", async (t) => {
  const bin = await mkdtemp(join(tmpdir(), "factory-dashboard-rex-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const sent = join(bin, "sent.txt");
  await writeFile(join(bin, "rex"), `#!/bin/sh
[ "$1" = "--autostart=false" ] && shift
case "$1" in
  block) echo block:01a1f4e8-4bb0-72d2-bff2-25420482aad9 ;;
  send-key)
    if [ -e "${bin}/fail" ]; then echo "no such block" >&2; exit 1; fi
    printf '%s\\n' "$*" >> "${sent}" ;;
esac
`);
  await chmod(join(bin, "rex"), 0o755);
  const { url, directory } = await server(t, { PATH: `${bin}${delimiter}${process.env.PATH}` });
  const live = "block:01a1f4e8-4bb0-72d2-bff2-25420482aad9";
  const at = new Date(Date.now() - 60_000).toISOString();
  const request = (id, session, data) => ({ id, at, type: "attention.requested", task: null, source: "attention",
    data: { session, kind: "ask-user", text: "Pick one", options: ["a", "b", "c"], role: "implementation", pane: live, ...data } });
  await appendFile(join(directory, "owner.repo-factory-events.jsonl"), [
    request("ask", "s-ask", {}),
    request("perm", "s-perm", { kind: "permission", options: [] }),
    request("odd", "s-odd", { pane: null }),
    request("gone", "s-gone", { pane: "block:01a1f4d3-c03e-7f0b-bc24-060b0352db5f" }),
  ].map((event) => `${JSON.stringify(event)}\n`).join(""));

  const answer = (body, headers = {}) => get(url, `/api/attention/answer?file=${factoryFile}`, {
    method: "POST",
    headers: { Origin: new URL(url).origin, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const keys = async () => readFile(sent, "utf8").catch(() => "");

  const ok = await answer({ id: "ask", index: 2 });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal(await keys(), `send-key -b ${live} down down enter\n`);

  const refusals = [
    [{ id: "ask", index: -1 }, 400, /option index/],
    [{ id: "ask", index: "1" }, 400, /option index/],
    [{ id: "ask", index: 1, extra: true }, 400, /option index/],
    [{ id: "missing", index: 0 }, 409, /no longer waiting/],
    [{ id: "perm", index: 0 }, 409, /no options/],
    [{ id: "odd", index: 0 }, 409, /no pane/],
    [{ id: "gone", index: 0 }, 409, /no longer waiting/],
  ];
  for (const [body, status, message] of refusals) {
    const response = await answer(body);
    assert.equal(response.status, status, JSON.stringify(body));
    assert.match((await response.json()).error, message, JSON.stringify(body));
  }
  const outOfRange = await answer({ id: "ask", index: 3 });
  assert.equal(outOfRange.status, 400);
  assert.match((await outOfRange.json()).error, /from 0 to 2/);

  await writeFile(join(bin, "fail"), "");
  const failed = await answer({ id: "ask", index: 0 });
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /Rex could not send the answer: no such block/);
  await rm(join(bin, "fail"));

  const foreign = await answer({ id: "ask", index: 0 }, { Origin: "http://evil.example" });
  assert.equal(foreign.status, 403);
  const wrongType = await answer({ id: "ask", index: 0 }, { "Content-Type": "text/plain" });
  assert.ok(wrongType.status >= 400 && wrongType.status < 500);
  assert.equal(await keys(), `send-key -b ${live} down down enter\n`, "A refused request sends no key.");
});

test("an ask_user prompt shows its options as buttons that post the pick, and the others stay copy-only", async (t) => {
  const posts = [];
  let reply = { status: 409, body: { error: "That prompt is no longer waiting." } };
  const ui = await dashboard(t, {
    fetchRequest: async (path, init, request) => {
      if (!path.startsWith("/api/attention/answer")) return request();
      posts.push({ path, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    },
  });
  const base = { role: "implementation", pane: "block:p1", task: null, at: "2026-05-01T12:00:00Z" };
  const items = [
    { ...base, id: "e1", session: "s1", kind: "ask-user", text: "Pick one", options: ["red", "green"] },
    { ...base, id: "e2", session: "s2", kind: "sandbox-bypass", text: "Run ls", options: ["yes", "no"] },
    { ...base, id: "e3", session: "s3", kind: "permission", text: "Run rm", options: [] },
  ];
  ui.run(`load({ ...snapshot, attention: ${JSON.stringify(items)} }, lastSource)`);
  await ui.get("attention-badge").fire("click");
  const [ask, bypass, permission] = ui.get("attention-list").children;
  assert.equal(bypass.querySelectorAll(".attention-answer").length, 0, "Sandbox bypass options are text.");
  assert.equal(permission.querySelectorAll(".attention-answer").length, 0);
  assert.match(bypass.textContent, /yes.*no/);
  const [red, green] = ask.querySelectorAll(".attention-answer");
  assert.deepEqual([red.textContent, green.textContent], ["red", "green"]);
  assert.equal(red.type, "button");

  await green.fire("click");
  assert.deepEqual(posts, [{ path: `/api/attention/answer?file=${encodeURIComponent(factoryFile)}`, body: { id: "e1", index: 1 } }]);
  assert.match(ask.textContent, /Not sent: That prompt is no longer waiting\./);
  assert.equal(red.disabled, false, "A refused answer can be tried again.");

  reply = { status: 200, body: { sent: true } };
  await red.fire("click");
  assert.deepEqual(posts.at(-1).body, { id: "e1", index: 0 });
  assert.match(ask.textContent, /Sent "red"\. Waiting for the prompt to close\./);
  assert.equal(red.disabled && green.disabled, true, "A sent answer is not sent twice.");
});

test("the badge, the page title and the waiting list show pending attention as data", async (t) => {
  assert.match(html, /<button id="attention-badge"[^>]* hidden>/);
  assert.match(html, /\$\{count \? `\(\$\{count\}\) ` : ""\}/);
  const ui = await dashboard(t, { now: Date.parse("2026-05-01T12:10:00Z") });
  const badge = ui.get("attention-badge");
  assert.equal(badge.hidden, true, "The badge is hidden at zero.");
  assert.equal(ui.document.title, "owner/repo - Factory");

  const item = (n, extra = {}) => ({
    session: `s${n}`, kind: "sandbox-bypass", text: `Run command: <b>rm</b> ${n}`, options: [], role: "implementation",
    pane: `block:p${n}`, task: "issue-5", at: `2026-05-01T12:0${n % 10}:00Z`, ...extra,
  });
  const show = (items) => ui.run(`load({ ...snapshot, attention: ${JSON.stringify(items)} }, lastSource)`);
  show([item(0, { options: ["yes", "no"] }), item(1, { pane: "block:x; rm -rf ~" })]);
  assert.equal(badge.hidden, false);
  assert.equal(ui.get("attention-count").textContent, "2");
  assert.equal(ui.document.title, "(2) owner/repo - Factory");

  await badge.fire("click");
  assert.equal(ui.get("detail").hidden, false);
  assert.equal(ui.get("attention-view").hidden, false);
  assert.equal(ui.get("task-view").hidden, true);
  assert.equal(ui.get("detail-title").textContent, "Waiting for you2");
  const [first, second] = ui.get("attention-list").children;
  assert.match(first.textContent, /Sandbox bypass.*10m.*Run command: <b>rm<\/b> 0.*yes.*no.*issue-5, implementation.*rex focus block:p0/);
  assert.equal(first.querySelector("code").textContent, "rex focus block:p0");

  ui.run("navigator = { clipboard: { writeText: async (value) => { globalThis.copied = value; } } }");
  const copy = first.querySelector("button");
  assert.equal(copy.textContent, "", "The copy button shows a glyph, not text.");
  assert.equal(copy["aria-label"], "Copy rex focus command");
  assert.equal(copy.title, "Copy rex focus command");
  assert.ok(copy.querySelector("svg"));
  await copy.fire("click");
  assert.equal(ui.run("copied"), "rex focus block:p0");
  assert.equal(copy["aria-label"], "Copied");
  assert.equal(copy.textContent, "");
  assert.equal(second.querySelector("button"), null, "A pane that is not a plain ID gets no shell command.");
  assert.match(second.textContent, /Pane: block:x; rm -rf ~/);

  show(Array.from({ length: 23 }, (_, n) => item(n, { pane: null })));
  assert.equal(ui.get("attention-list").children.length, 20);
  assert.match(ui.get("attention-note").textContent, /oldest 20 of 23/);

  show([]);
  assert.equal(badge.hidden, true);
  assert.equal(ui.document.title, "owner/repo - Factory");
  assert.equal(ui.get("attention-empty").hidden, false);
  await badge.fire("click");
  assert.equal(ui.get("detail").hidden, true, "A second click closes the list.");
});
