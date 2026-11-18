const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { mkdtemp, readFile, readdir, rm, symlink, writeFile } = require("node:fs/promises");
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const http = require("node:http");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");
const vm = require("node:vm");

const html = readFileSync(join(__dirname, "dashboard.html"), "utf8");
const example = JSON.parse(readFileSync(join(__dirname, "factory.example.json"), "utf8"));
const factoryFile = "owner.repo-factory.json";

async function server(t) {
  const directory = await mkdtemp(join(tmpdir(), "factory-dashboard-test-"));
  const outside = await mkdtemp(join(tmpdir(), "factory-dashboard-outside-"));
  await writeFile(join(directory, factoryFile), JSON.stringify(example));
  await writeFile(join(directory, "owner.repo-issue-9-implementation-brief.md"), "# The brief\n");
  await writeFile(join(directory, "unrelated-notes.md"), "private\n");
  await writeFile(join(outside, "secret.md"), "secret\n");
  await symlink(join(outside, "secret.md"), join(directory, "owner.repo-issue-9-investigation-brief.md"));
  const child = spawn(process.execPath, [join(__dirname, "serve.mjs"), "--directory", directory, "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
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
  assert.deepEqual(await (await get(url, `/api/factory?file=${factoryFile}`)).json(), data);
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
      assert.deepEqual(task.workers, before.workers);
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

test("a dashboard edit wakes the factory waiter even with no worker results", { timeout: 10000 }, async (t) => {
  const { url, directory } = await server(t);
  const file = join(directory, factoryFile);
  const cursor = join(directory, "cursor.json");
  const content = await readFile(file);
  await writeFile(cursor, JSON.stringify({ [file]: createHash("sha256").update(content).digest("hex") }));
  const child = spawn(process.execPath, [join(__dirname, "wait.mjs"), "--cursor", cursor, file],
    { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const closed = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => { child.kill(); await closed; });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.includes("Watching result files.")) resolve();
    });
    child.once("error", reject);
    child.once("close", (code) => reject(new Error(`Waiter exited ${code}: ${stderr}`)));
  });
  const response = await move(url, unblocked);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await closed, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { changed: [file] });
});

test("accepts only GET on loopback host names", async (t) => {
  const { url } = await server(t);
  assert.equal((await get(url, "/", { method: "POST" })).status, 405);
  assert.equal((await get(url, "/nope")).status, 404);
  const status = await new Promise((resolve, reject) => {
    const target = new URL(url);
    http.get({ host: target.hostname, port: target.port, path: "/", headers: { Host: "evil.example" } },
      (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
  });
  assert.equal(status, 403);
});

test("the page script parses, never renders data as HTML, and finds its elements", () => {
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^\s*import .+;\s*/m, "");
  new vm.Script(script);
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.doesNotMatch(html, /Merge OK\?|class="gate"/);
  assert.equal([...html.matchAll(/<input id="global-filter"/g)].length, 1);
  assert.doesNotMatch(html, /id="task-filter"/);
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  for (const [, id] of script.matchAll(/getElementById\("([^"]+)"\)/g)) {
    assert.ok(ids.has(id), `Missing element #${id}`);
  }
});

// Model only the DOM operations used by the task list; HTTP and the page script are real.
async function dashboard(t, { reducedMotion = true, confirm = () => true, now = Date.now(), fetchRequest } = {}) {
  const { url, directory } = await server(t);
  const elements = new Map();
  const document = {
    getElementById: (id) => elements.get(id),
    createElement: (tag) => new Element(tag),
    createElementNS: (_, tag) => new Element(tag),
    listeners: new Map(),
    addEventListener(name, callback) { this.listeners.set(name, callback); },
  };
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.dataset = {};
      this.style = { setProperty() {} };
      this.listeners = new Map();
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
  for (const [, tag, id] of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) elements.set(id, new Element(tag));
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
    window: { addEventListener() {}, confirm },
    matchMedia: () => ({ matches: reducedMotion }),
    performance: { now: () => 0 },
    requestAnimationFrame: (callback) => callback(2000),
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
  // Token flight is outside these interaction tests; counters finish in one frame.
  vm.runInContext("animate = () => {}; buildFlow();", context);
  const run = (source) => vm.runInContext(source, context);
  await run("refresh()");
  const press = (key) => document.listeners.get("keydown")({ key });
  return { run, document, directory, press, get: (id) => elements.get(id), setNow: (value) => { now = value; } };
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
  assert.doesNotMatch(html, /<dialog id="detail"/);
  const layout = html.match(/<div class="layout">([\s\S]*?)<noscript>/)[1];
  assert.ok(layout.indexOf('id="factories"') < layout.indexOf("<main>")
    && layout.indexOf("</main>") < layout.indexOf('<aside id="detail"'));
  assert.equal(layout.split('id="detail"').length, 2, "The panel appears once.");
  assert.match(html, /\.layout \{[^}]*grid-template-columns: 240px minmax\(0, 1fr\) auto/);
  assert.match(html, /main \{[^}]*grid-column: 2/);
  assert.match(html, /#detail \{[^}]*grid-column: 3;[^}]*width: clamp\(420px, 34vw, 520px\)[^}]*border-left: 1px solid var\(--border\)/);
  assert.match(html, /main \{[^}]*overflow: auto/);
  assert.match(html, /\.layout \{[^}]*grid-template-rows: minmax\(0, 1fr\);[^}]*flex: 1; min-height: 0/);
  assert.doesNotMatch(html, /\.layout \{[^}]*align-items: start/);
  assert.match(html, /body \{[^}]*height: 100vh/);
  assert.match(html, /#factories \{[^}]*overflow-y: auto/);
  assert.match(html, /#detail \{[^}]*overflow-y: auto/);
  assert.match(html, /#flow \{[^}]*min-width: 720px/);
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
  assert.equal(ui.get("goal").textContent, "other/repo");

  await write("2026-05-01T14:00:00Z");
  await ui.run("refresh()");
  assert.equal(dots().length, 0, "The selected factory never shows a dot.");
});

test("the dot never animates for reduced motion and the header shows a short refresh label", async (t) => {
  assert.match(html, /prefers-reduced-motion: reduce\) \{[^}]*\.update-dot \{ animation: none; \}/);
  assert.doesNotMatch(html, /Search all fields|<select id="factory"/);
  const ui = await dashboard(t, { now: Date.parse("2026-05-01T12:05:00Z") });
  assert.equal(ui.get("freshness").textContent, "refreshed just now");
  ui.setNow(Date.parse("2026-05-01T12:05:07Z"));
  ui.run("freshness()");
  assert.equal(ui.get("freshness").textContent, "refreshed 7s ago");
  ui.setNow(Date.parse("2026-05-01T12:08:00Z"));
  ui.run("freshness()");
  assert.equal(ui.get("freshness").textContent, "refreshed 3m ago");
});

test("global task filters search any field, combine terms, and survive refresh and move dialogs", async (t) => {
  const ui = await dashboard(t);
  ui.run("choose('review')");
  const filter = ui.get("global-filter");
  const rows = () => ui.get("task-list").children;
  assert.equal(ui.get("detail-filter-count").hidden, true);
  assert.equal(ui.get("detail-filter-count").textContent, "");
  filter.value = 'history.note:"New head pushed." workers.review.status:running';
  await filter.fire("input");
  assert.deepEqual(rows().map((row) => row.dataset.taskId), ["issue-7"]);
  assert.equal(ui.get("global-filter-count").textContent, `1 of ${example.tasks.length} tasks match.`);
  assert.equal(ui.get("clear-filter").hidden, false);
  assert.equal(ui.get("detail-filter-count").hidden, false);
  assert.equal(ui.get("detail-filter-count").textContent, "1 of 1 tasks match the global filter.");

  filter.value = "state:review 0123456";
  await filter.fire("input");
  assert.deepEqual(rows().map((row) => row.dataset.taskId), ["issue-7"]);
  filter.value = "id:issue-9";
  await filter.fire("input");
  assert.equal(rows().length, 0);
  assert.equal(ui.get("detail-empty").textContent, "No tasks match this filter.");

  ui.run("choose('implementation')");
  filter.value = "details.verdict:implement title:Retry";
  await filter.fire("input");
  assert.deepEqual(rows().map((row) => row.dataset.taskId), ["issue-9"]);
  await rows()[0].querySelector(".move").fire("click");
  await ui.run("refresh()");
  assert.equal(filter.value, "details.verdict:implement title:Retry");
  assert.equal(ui.get("global-filter-count").textContent, `1 of ${example.tasks.length} tasks match.`);
  assert.deepEqual(rows().map((row) => row.dataset.taskId), ["issue-9"]);
  assert.equal(ui.get("move-dialog").open, true);

  await ui.get("clear-filter").fire("click");
  assert.equal(filter.value, "");
  assert.equal(ui.get("global-filter-count").hidden, true);
  assert.equal(ui.get("clear-filter").hidden, true);
  assert.equal(rows().length, example.tasks.filter((task) => task.state === "implementation").length);
});

test("flow edges and token routes use only straight horizontal and vertical segments", async (t) => {
  const ui = await dashboard(t);
  const paths = ui.get("flow").querySelectorAll(".edge").map((edge) => edge.d);
  for (const hop of [{ from: null, to: "initial" }, { from: "blocked", to: "review" }, { from: "initial", to: "review" }]) {
    paths.push(ui.run(`routeFor(${JSON.stringify(hop)})`));
  }
  assert.equal(paths.length, 15);
  for (const path of paths) {
    assert.match(path, /^M[\d.,-]+( L[\d.,-]+)+$/, `Only M and L commands: ${path}`);
    const points = path.slice(1).split(" L").map((point) => point.split(",").map(Number));
    points.slice(1).forEach(([x, y], index) => {
      const [px, py] = points[index];
      assert.ok(x === px || y === py, `Diagonal segment in ${path}`);
    });
  }
});

test("the flow stops its continuous animations while every task is resolved", async (t) => {
  const ui = await dashboard(t);
  const calm = () => ui.get("flow").className.split(" ").includes("calm");
  const write = (tasks) => writeFile(join(ui.directory, factoryFile), JSON.stringify({ ...example, tasks }));
  const resolved = example.tasks.filter((task) => task.state === "resolved");
  assert.equal(calm(), false, "The example has open tasks.");

  await write(resolved);
  await ui.run("refresh()");
  assert.equal(calm(), true);

  await write(example.tasks);
  await ui.run("refresh()");
  assert.equal(calm(), false, "Any open task resumes the animations.");

  await write([]);
  await ui.run("refresh()");
  assert.equal(calm(), true, "A factory with no tasks is idle.");
  assert.match(html, /#flow\.calm \.edge, #flow\.calm \.ring \{ animation: none; \}/);
});

test("global filters update state totals, resolution outcomes, and every opened list", async (t) => {
  const ui = await dashboard(t);
  const filter = ui.get("global-filter");
  const nodeCount = (state) => Number(ui.run(`nodeOf('${state}')`).querySelector(".count").textContent);
  const outcomeCount = (outcome) => Number(ui.get("flow").querySelectorAll(".outcome")
    .find((node) => node.dataset.outcome === outcome).querySelector(".outcome-count").textContent);

  filter.value = "id:issue-7";
  await filter.fire("input");
  assert.equal(nodeCount("review"), 1);
  assert.equal(nodeCount("resolved"), 0);
  assert.equal(outcomeCount("merged"), 0);
  assert.equal(ui.get("global-filter-count").textContent, `1 of ${example.tasks.length} tasks match.`);
  ui.run("choose('initial')");
  assert.equal(ui.get("task-list").children.length, 0);
  ui.run("choose('review')");
  assert.deepEqual(ui.get("task-list").children.map((row) => row.dataset.taskId), ["issue-7"]);

  filter.value = "id:issue-3";
  await filter.fire("input");
  assert.equal(nodeCount("review"), 0);
  assert.equal(nodeCount("resolved"), 1);
  assert.equal(outcomeCount("merged"), 1);
  const merged = ui.get("flow").querySelectorAll(".outcome").find((node) => node.dataset.outcome === "merged");
  await merged.fire("click");
  assert.deepEqual(ui.get("task-list").children.map((row) => row.dataset.taskId), ["issue-3"]);

  await ui.get("clear-filter").fire("click");
  assert.equal(nodeCount("review"), 1);
  assert.equal(nodeCount("resolved"), 1);
  assert.equal(outcomeCount("merged"), 1);
  assert.deepEqual(ui.get("task-list").children.map((row) => row.dataset.taskId), ["issue-3"]);
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

test("a row puts the title and Move button on one line and the links on their own wrapping line", async (t) => {
  const ui = await dashboard(t);
  ui.run("choose('implementation')");
  const row = ui.get("task-list").children[0];
  const [head, links] = row.children;
  assert.deepEqual(head.children.map((child) => child.tag), ["h3", "button"]);
  assert.equal(head.children[1].className, "move");
  assert.equal(links.className, "links");
  assert.ok(links.children.length > 0);
  assert.equal(head.querySelectorAll("a").length, 0);
  assert.match(html, /\.row-head h3 \{[^}]*flex: 1;[^}]*min-width: 0/);
  assert.match(html, /\.chips, \.links \{[^}]*flex-wrap: wrap/);
  assert.match(html, /\.task-row \{[^}]*overflow-wrap: anywhere/);
  assert.match(html, /\.move \{[^}]*flex: none/);
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

test("rows omit the Next line when there is no next action", async (t) => {
  const ui = await dashboard(t);
  const base = example.tasks.find((item) => item.id === "issue-9");
  const lines = (next) => ui.run(`taskRow(${JSON.stringify({ ...base, next_action: next })}, new Set())`)
    .children.filter((child) => child.tag === "p" && child.textContent.startsWith("Next:"));
  assert.equal(lines("Ship it.").length, 1);
  for (const next of ["None", "none.", "", "  ", null]) assert.equal(lines(next).length, 0, String(next));
  assert.equal(lines("None. The PR is merged.").length, 1);
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
  assert.equal(ui.get("detail").hidden, true, "Close must close the filtered list, not clear its filter.");
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

test("Find work lists rules, user links and skipped work without changing task states", async (t) => {
  const ui = await dashboard(t);
  const source = ui.get("flow").querySelector(".source");
  assert.equal(source["aria-label"], "Find work: 2 enabled rules");
  assert.equal(source.querySelector(".count").textContent, "2");
  assert.equal(source.querySelector(".sub").textContent, "due now");
  assert.equal(ui.get("flow").querySelectorAll(".edge")
    .find((edge) => edge.dataset.edge === "source>initial").className.includes("idle"), false);
  await source.fire("click");
  assert.equal(ui.run("location.hash"), "#producers");
  assert.equal(ui.get("producers-dialog").open, true);
  assert.equal(ui.get("detail").hidden, true);
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
  assert.match(ui.get("ignored-list").textContent, /#2 2026-04-30: Archived duplicate/);
  assert.equal(ui.get("ignored-empty").hidden, true);
  assert.equal(ui.get("producers-note").textContent, "");
  await ui.get("close-producers").fire("click");
  assert.equal(ui.get("producers-dialog").open, false);
  assert.equal(ui.run("location.hash"), "");
  await source.fire("keydown", { key: "Enter" });
  assert.equal(ui.get("producers-dialog").open, true);
  await ui.get("producers-dialog").fire("cancel");
  assert.equal(ui.get("producers-dialog").open, false);
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
  assert.equal(state.value, "investigation", "The state the task was blocked from is preselected.");
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
  await ui.get("close-move").fire("click");
  ui.run("choose('initial')");
  assert.equal(ui.get("task-list").querySelector(".move").textContent, "Move");
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

test("runningWorkers and budgetText count every running worker against the budget", async () => {
  const { runningWorkers, budgetText } = await import("./factory-data.mjs");
  const data = structuredClone(example);
  assert.equal(runningWorkers(data), 3, "Idle, closed, and missing workers do not count.");
  assert.equal(budgetText(data), "3 running / budget 10");
  data.rules[0].worker = { ...data.rules[1].worker, status: "running" };
  assert.equal(runningWorkers(data), 4, "A running rule worker counts.");
  delete data.budget;
  assert.equal(budgetText(data), "4 running / no total cap");
});

test("the header shows running workers against the budget and refreshes with the file", async (t) => {
  const ui = await dashboard(t);
  assert.equal(ui.get("budget-state").textContent, "3 running / budget 10");
  assert.equal(ui.get("budget-line").hidden, false);
  const { budget: _, ...old } = structuredClone(example);
  await writeFile(join(ui.directory, factoryFile), JSON.stringify(old));
  await ui.run("refresh()");
  assert.equal(ui.get("budget-state").textContent, "3 running / no total cap");
});

test("the cog opens one settings dialog and the old budget button is gone", async (t) => {
  assert.doesNotMatch(html, /edit-budget|Edit budget|budget-dialog/);
  assert.match(html, /<h2 id="goal"><\/h2>\s*<button id="open-settings"[^>]*aria-label="Settings"[^>]*title="Settings"/);
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
  assert.equal(ui.get("budget-state").textContent, "3 running / budget 8");
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
  assert.equal(ui.get("budget-state").textContent, "3 running / budget 6");
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
    assert.match(text, /git merge main/, file);
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

test("the worker write boundary is present in the skill and plugin rules", () => {
  for (const file of [join(__dirname, "SKILL.md"), join(__dirname, "..", "..", "AGENTS.md")]) {
    const text = readFileSync(file, "utf8");
    assert.match(text, /only\s+writable\s+root/i, file);
    assert.match(text, /primary checkout/, file);
    assert.match(text, /read\s+`plugins\/factory\/AGENTS\.md`\s+before\s+(its|the)\s+first\s+edit/i, file);
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
  for (const plain of ["defaced", "1234567", "and/or", "https://github.com/o/r/pull/1", "plain words, e.g. this."]) {
    assert.deepEqual(parts(plain), [plain]);
  }
  assert.deepEqual(parts("<b>x</b> abc1234"), ["<b>x</b> ", { code: "abc1234", tag: "code" }]);
  assert.deepEqual(parts(`${uuid} ${uuid}`).filter((part) => part.code).length, 2);
});

test("rows wrap UUIDs, SHAs, panes, paths and backticked text in code and keep links", async (t) => {
  const ui = await dashboard(t);
  const pane = "block:01a1ec42-3b1e-7470-b269-912f7f7bd4fd";
  const task = structuredClone(example.tasks.find((item) => item.id === "issue-5"));
  task.blocker.reason = "Run `npm test` after be66032 lands in /tmp/work/tree.";
  task.next_action = "Check `a.json`.";
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

test("code uses the GitHub inline code style in both color schemes", () => {
  assert.match(html, /--code-bg: rgba\(175, 184, 193, \.2\)/);
  assert.match(html, /--code-bg: rgba\(110, 118, 129, \.4\)/);
  const rule = html.match(/\n\s*code \{([^}]*)\}/)[1];
  for (const part of [/font-family: var\(--mono\)/, /font-size: 85%/, /padding: \.2em \.4em/, /border-radius: 6px/,
    /background: var\(--code-bg\)/, /overflow-wrap: anywhere/]) assert.match(rule, part);
});
