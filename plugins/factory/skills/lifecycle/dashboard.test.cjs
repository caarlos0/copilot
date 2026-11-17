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
    [factoryFile, "owner.repo-issue-9-implementation-brief.md", "owner.repo-issue-9-investigation-brief.md", "unrelated-notes.md"].sort());
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
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  for (const [, id] of script.matchAll(/getElementById\("([^"]+)"\)/g)) {
    assert.ok(ids.has(id), `Missing element #${id}`);
  }
});

// Model only the DOM operations used by the task list; HTTP and the page script are real.
async function dashboard(t) {
  const { url, directory } = await server(t);
  const elements = new Map();
  const document = {
    getElementById: (id) => elements.get(id),
    createElement: (tag) => new Element(tag),
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
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) {
      this.children = children;
      if (this.tag === "select") this.value = children[0]?.value ?? "";
    }
    get textContent() { return this.children.map((child) => typeof child === "string" ? child : child.textContent).join(""); }
    set textContent(value) { this.children = [String(value)]; }
    get options() { return this.children.filter((child) => child.tag === "option"); }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    async fire(name, event = {}) { await this.listeners.get(name)?.({ target: this, preventDefault() {}, ...event }); }
    getBoundingClientRect() { return { left: 100, right: 900, top: 100, bottom: 700 }; }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    querySelectorAll(selector) {
      const match = /^([a-z]+|\.[\w-]+)(\[open\])?$/.exec(selector);
      assert.ok(match, `Unsupported test selector: ${selector}`);
      const [, name, open] = match;
      return this.children.flatMap((child) => {
        if (!(child instanceof Element)) return [];
        const matches = name.startsWith(".") ? child.className.split(" ").includes(name.slice(1)) : child.tag === name;
        return [
          ...(matches && (!open || child.open) ? [child] : []),
          ...child.querySelectorAll(selector),
        ];
      });
    }
  }
  for (const [, tag, id] of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) elements.set(id, new Element(tag));
  elements.get("detail").append(...["detail-title", "close-detail", "detail-status", "task-list", "detail-empty"]
    .map((id) => elements.get(id)));
  elements.get("move-dialog").append(...["move-title", "close-move", "move-body"].map((id) => elements.get(id)));
  const location = new URL(`?file=${factoryFile}`, url);
  const context = vm.createContext({
    ...await import("./factory-data.mjs"),
    document, location, URL, URLSearchParams,
    history: { replaceState: (_, __, value) => { location.href = new URL(value, location).href; } },
    window: { addEventListener() {} },
    matchMedia: () => ({ matches: true }),
    setTimeout() {}, clearTimeout() {},
    fetch: (path, options = {}) => get(url, path, {
      ...options,
      headers: { ...options.headers, ...(options.method === "POST" ? { Origin: new URL(url).origin } : {}) },
    }),
  });
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
    .replace(/^\s*import .+;\s*/m, "").replace(/\s*buildFlow\(\);\s*refresh\(\);\s*$/, "");
  vm.runInContext(script, context);
  // Flow animation is outside these interaction tests.
  vm.runInContext("draw = () => renderDetail(openState()); animate = () => {};", context);
  const run = (source) => vm.runInContext(source, context);
  await run("refresh()");
  return { run, document, directory, get: (id) => elements.get(id) };
}

test("state selection opens a modal list that can close and reopen", async (t) => {
  const ui = await dashboard(t);
  ui.run("choose('blocked')");
  assert.equal(ui.get("detail").tag, "dialog");
  assert.equal(ui.get("detail").open, true);
  assert.equal(ui.get("task-list").tag, "ul");
  assert.equal(ui.get("task-list").children.length, 1);
  assert.match(ui.get("task-list").textContent, /Docs build fails on a clean checkout/);
  assert.equal(ui.get("task-list").children[0].tag, "li");
  await ui.get("close-detail").fire("click");
  assert.equal(ui.get("detail").open, false);
  ui.run("choose('blocked')");
  assert.equal(ui.get("task-list").children.length, 1);
  await ui.get("detail").fire("cancel");
  assert.equal(ui.get("detail").open, false);
  ui.run("choose('blocked')");
  const outside = { clientX: 10, clientY: 10 };
  await ui.get("detail").fire("pointerdown", { clientX: 500, clientY: 400 });
  await ui.get("detail").fire("click", { clientX: 500, clientY: 400 });
  assert.equal(ui.get("detail").open, true, "A click inside the popup must not close it.");
  await ui.get("detail").fire("pointerdown", { ...outside, target: ui.get("task-list") });
  await ui.get("detail").fire("click", outside);
  assert.equal(ui.get("detail").open, true, "A drag that starts inside the popup must not close it.");
  await ui.get("detail").fire("pointerdown", outside);
  await ui.get("detail").fire("click", outside);
  assert.equal(ui.get("detail").open, false, "A click on the backdrop must close the popup.");
  ui.run("choose('investigation')");
  assert.equal(ui.get("detail-empty").hidden, false);
  assert.equal(ui.get("task-list").children.length, 0);
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

test("Move opens a separate popup whose draft survives refresh and conflict", async (t) => {
  const ui = await dashboard(t);
  ui.run("choose('blocked')");
  const list = ui.get("task-list");
  await list.querySelector(".move").fire("click");
  assert.equal(ui.get("move-dialog").open, true);
  assert.equal(ui.get("detail").open, true);
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
  assert.equal(ui.get("detail").open, true);
  assert.equal(ui.get("detail").dataset.state, "blocked", "The list must stay on the state it showed.");
  assert.equal(ui.get("task-list").children.length, 0);
  assert.equal(ui.document.activeElement, ui.get("close-detail"), "After saving, focus must stay in the task popup.");
  assert.match(ui.get("detail-status").textContent, /to Initial\. Comment saved; awaiting factory acknowledgement/);
});

test("the move popup closes on its close button and backdrop without saving", async (t) => {
  const ui = await dashboard(t);
  const file = join(ui.directory, factoryFile);
  const original = await readFile(file, "utf8");
  ui.run("choose('blocked')");
  await ui.get("task-list").querySelector(".move").fire("click");
  await ui.get("close-move").fire("click");
  assert.equal(ui.get("move-dialog").open, false);
  await ui.get("task-list").querySelector(".move").fire("click");
  const outside = { clientX: 950, clientY: 400 };
  await ui.get("move-dialog").fire("pointerdown", outside);
  await ui.get("move-dialog").fire("click", outside);
  assert.equal(ui.get("move-dialog").open, false);
  assert.equal(ui.get("detail").open, true);
  assert.equal(await readFile(file, "utf8"), original);
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
  await form.fire("submit");
  const saved = JSON.parse(await readFile(join(ui.directory, factoryFile), "utf8"))
    .tasks.find((task) => task.id === "issue-12");
  assert.equal(saved.state, "resolved");
  assert.equal(saved.resolution.outcome, "cancelled");
  assert.equal(saved.resolution.note, comment.value);
  assert.equal(saved.feedback.acknowledged_id, null);
  assert.equal(ui.get("detail").dataset.state, "initial");
  assert.match(ui.get("detail-status").textContent, /to Resolved\./);
});
