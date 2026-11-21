import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rename, rm, unlink, symlink } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { TestContext } from "node:test";
import vm from "node:vm";

const html = readFileSync(`${import.meta.dirname}/board.html`, "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)![1]
  .replace(/^\s*import .+;\s*/m, "");
const example = JSON.parse(readFileSync(`${import.meta.dirname}/handoff.example.json`, "utf8"));

type Server = Awaited<ReturnType<typeof serverFixture>>;
type Timer = { callback: () => unknown; delay: number };
type Intercept = (url: URL, options: RequestInit) => unknown;

async function serverFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "coordinator-board-test-"));
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let closed: Promise<unknown> | undefined;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (closed) await closed;
    await rm(directory, { recursive: true, force: true });
  });
  const raw = async (name: string, content: string) => {
    const temporary = join(directory, `.${name}.next`);
    await writeFile(temporary, content);
    await rename(temporary, join(directory, name));
  };
  const write = (name: string, data: unknown) => raw(name, JSON.stringify(data));
  await write("example-handoff.json", example);
  child = spawn(process.execPath, [
    join(import.meta.dirname, "coordinator.mjs"), "serve", "--directory", directory, "--port", "0",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  closed = new Promise((resolve) => child.once("close", resolve));
  const url = await new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child!.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) resolve(match[0]);
    });
    child!.stderr.on("data", (chunk) => { stderr += chunk; });
    child!.once("error", reject);
    child!.once("close", (code) => reject(new Error(`Board server exited ${code}: ${stderr}`)));
  });
  return { directory, url, write, raw };
}

class Element {
  declare tag: string;
  declare children: Element[];
  declare dataset: Record<string, string>;
  declare hidden: boolean;
  declare value: string;
  declare content: string;
  declare listeners: Record<string, () => unknown>;
  declare clicks: number;
  declare open: boolean;
  declare className: string;
  declare href: string;
  declare title: string;
  constructor(tag: string) {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.hidden = false;
    this.value = "";
    this.content = "";
    this.listeners = {};
    this.clicks = 0;
  }
  set textContent(value: unknown) {
    this.content = String(value);
    this.children = [];
  }
  get textContent(): string {
    return this.content + this.children.map((child) => child.textContent).join("");
  }
  set innerHTML(value: string) {
    throw new Error(`Board must not render task data as HTML: ${value}`);
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.content = "";
    this.children = children;
  }
  querySelectorAll(selector: string): Element[] {
    assert.equal(selector, "details[open]");
    return this.children.flatMap((child) => [
      ...(child.tag === "details" && child.open ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  addEventListener(event: string, callback: () => unknown) {
    this.listeners[event] = callback;
  }
  click() {
    this.clicks++;
    return this.listeners.click?.();
  }
}

async function board(t: TestContext, data: any = structuredClone(example), options: { server?: Server; search?: string } = {}) {
  const server = options.server ?? await serverFixture(t);
  await server.write("example-handoff.json", data);
  const nodes = Object.fromEntries(
    [...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element("div")]),
  );
  nodes.error.hidden = true;
  const timers: Timer[] = [];
  const events: Record<string, () => unknown> = {};
  const requests: { url: URL; options: RequestInit }[] = [];
  let intercept: Intercept | null = null;
  const location = new URL(options.search ?? "?file=example-handoff.json", server.url);
  const context = vm.createContext({
    ...await import("./board-data.ts"),
    document: {
      createElement: (tag: string) => new Element(tag),
      getElementById: (id: string) => nodes[id],
    },
    window: { addEventListener: (event: string, callback: () => unknown) => { events[event] = callback; } },
    location,
    history: { replaceState: (_: unknown, __: unknown, url: URL) => { location.href = url.href; } },
    URL,
    URLSearchParams,
    fetch: async (path: string, fetchOptions: RequestInit) => {
      const url = new URL(path, server.url);
      requests.push({ url, options: fetchOptions });
      if (intercept) {
        const response = await intercept(url, fetchOptions);
        if (response !== undefined) return response;
      }
      return fetch(url, fetchOptions);
    },
    setTimeout: (callback: () => unknown, delay: number) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer: Timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  await vm.runInContext(script, context);
  return {
    server,
    nodes,
    timers,
    requests,
    location,
    intercept(callback: Intercept | null) { intercept = callback; },
    async choose(file: string) {
      nodes.coordinator.value = file;
      await nodes.coordinator.listeners.change();
    },
    async refresh(next?: unknown) {
      if (next !== undefined) await server.write("example-handoff.json", next);
      const timer = timers.shift()!;
      assert.equal(timer.delay, 60000);
      await timer.callback();
      assert.equal(timers.length, 1, "schedule the next refresh only after this one finishes");
    },
    async navigate(search: string) {
      location.search = search;
      await events.popstate();
    },
  };
}

test("renders JSON tasks fetched over HTTP in all five columns as text", async (t) => {
  const data = structuredClone(example);
  const statuses = ["pending", "running", "verifying", "blocked", "done"];
  data.goal = '<img src=x onerror="alert(1)">';
  delete data.tasks[0].links;
  data.tasks = statuses.map((status) => ({
    ...data.tasks[0],
    id: status,
    status,
    blocker: status === "blocked" ? "Needs approval" : null,
    brief: `${status}-brief.md`,
    pr: "https://github.com/caarlos0/dotfiles/pull/42",
  }));
  const view = await board(t, data);
  assert.equal(view.nodes.goal.textContent, data.goal);
  assert.equal(view.nodes.error.hidden, true, view.nodes.error.textContent);
  assert.match(view.nodes.freshness.textContent, /Snapshot: 2026-11-05T05:00:00Z/);
  assert.equal(view.requests.length, 2);
  assert.ok(view.requests.every((request) => request.options.cache === "no-store"));
  assert.match(view.nodes.source.textContent, /example-handoff.json/);
  const columns = view.nodes.board.children;
  assert.equal(columns.length, 5);
  for (const [index, column] of columns.entries()) {
    assert.equal(column.dataset.status, statuses[index]);
    assert.match(column.children[0].textContent, /\(1\)$/);
    const card = column.children[1];
    assert.equal(card.children[0].textContent, `${data.project} / ${data.tasks[index].id}`);
    assert.match(card.textContent, /Worker: Unknown/);
    assert.match(card.textContent, /Evidence and task details/);
    const links = card.children.find((node) => node.className === "links")!;
    const artifact = new URL(links.children[0].href, view.server.url);
    assert.equal(artifact.pathname, "/api/artifact");
    assert.equal(artifact.searchParams.get("file"), "example-handoff.json");
    assert.equal(artifact.searchParams.get("name"), `${statuses[index]}-brief.md`);
    assert.equal(links.children[1].href, data.tasks[index].pr);
    assert.equal(links.children[1].textContent, "#42");
  }
  assert.match(columns[3].textContent, /Blocked: Needs approval/);
});

test("shows every issue and PR context link as its number without repeating the legacy PR", async (t) => {
  const data = structuredClone(example);
  const pr = "https://github.com/owner/repository/pull/43";
  const issue = "https://github.com/owner/repository/issues/42";
  const otherIssue = "https://github.com/other/repository/issues/42";
  const otherPR = "https://github.com/owner/repository/pull/44";
  data.tasks[0].pr = pr;
  data.tasks[0].links = [issue, pr, otherIssue, otherPR, issue];
  const view = await board(t, data);
  assert.equal(view.nodes.error.hidden, true, view.nodes.error.textContent);
  const card = view.nodes.board.children[0].children[1];
  const links = card.children.find((node) => node.className === "links")!;
  assert.deepEqual(links.children.map((node) => [node.textContent, node.href]), [
    ["#43", pr], ["#42", issue], ["#42", otherIssue], ["#44", otherPR],
  ]);
  for (const node of links.children) assert.equal(node.title, node.href);

  data.tasks[0].pr = null;
  data.tasks[0].links = [issue];
  await view.refresh(data);
  const issueCard = view.nodes.board.children[0].children[1];
  const issueLinks = issueCard.children.find((node) => node.className === "links")!;
  assert.deepEqual(issueLinks.children.map((node) => [node.textContent, node.href]), [["#42", issue]]);
});

test("atomic JSON replacements refresh the board; failed reads retain evidence and recover", async (t) => {
  const view = await board(t);
  const details = view.nodes.board.children[0].children[1].children.find((node) => node.tag === "details")!;
  assert.equal(details.open, false);
  details.open = true;
  const done = structuredClone(example);
  done.tasks[0].status = "done";
  done.status = "finished";
  await view.refresh(done);
  assert.match(view.nodes.board.children[4].textContent, /Done \(1\)/);
  assert.match(view.nodes["run-state"].textContent, /finished/);
  const expanded = view.nodes.board.querySelectorAll("details[open]");
  assert.equal(expanded.length, 1, "keep evidence expanded when a task changes columns");
  assert.equal(expanded[0].dataset.taskId, example.tasks[0].id);
  const rendered = view.nodes.board.textContent;
  await unlink(join(view.server.directory, "example-handoff.json"));
  await view.refresh();
  assert.equal(view.nodes.board.textContent, rendered);
  assert.match(view.nodes.error.textContent, /ENOENT.*last successful snapshot of example-handoff.json/);
  await view.refresh(example);
  assert.equal(view.nodes.error.hidden, true);
  assert.match(view.nodes.board.children[0].textContent, /Pending \(1\)/);
});

test("rejects malformed or invalid snapshots without partially replacing the board", async (t) => {
  const view = await board(t);
  const rendered = view.nodes.board.textContent;
  const invalidCases: [string, (data: any) => void][] = [
    ["Unknown status", (data) => { data.tasks[0].status = "idle"; }],
    ["Duplicate task ID", (data) => { data.tasks.push(data.tasks[0]); }],
    ["timezone", (data) => { data.updated_at = "2026-11-05T05:00:00"; }],
    ["task.next_action", (data) => { delete data.tasks[0].next_action; }],
    ["task.worker", (data) => { data.tasks[0].worker = {}; }],
    ["blocker", (data) => { data.tasks[0].blocker = "Needs approval"; }],
    ["filename", (data) => { data.tasks[0].result = "../private.json"; }],
    ["GitHub", (data) => { data.tasks[0].pr = "javascript:alert(1)"; }],
    ["task.links", (data) => { data.tasks[0].links = {}; }],
    ["GitHub", (data) => { data.tasks[0].links = ["https://example.com/owner/repo/issues/42"]; }],
  ];
  for (const [message, change] of invalidCases) {
    const data = structuredClone(example);
    change(data);
    await view.refresh(data);
    assert.equal(view.nodes.board.textContent, rendered, message);
    assert.equal(view.nodes.error.hidden, false, message);
    assert.ok(view.nodes.error.textContent.includes(message), view.nodes.error.textContent);
  }
  await view.server.raw("example-handoff.json", "not JSON");
  await view.refresh();
  assert.equal(view.nodes.board.textContent, rendered);
  assert.match(view.nodes.error.textContent, /JSON/);
});

test("the root page discovers choices without a query and notices newly created handoffs", async (t) => {
  const view = await board(t, example, { search: "" });
  assert.equal(view.nodes.board.children.length, 0);
  assert.equal(view.nodes.coordinator.children.length, 2);
  assert.equal(view.nodes.coordinator.children[1].textContent, "example-handoff.json / 1 task");
  assert.doesNotMatch(view.nodes.coordinator.children[1].textContent, /Example coordinator|active/);
  await view.server.write("second-handoff.json", { ...example, id: "second", goal: "New coordinator" });
  await view.refresh();
  assert.equal(view.nodes.coordinator.children.length, 3);
  assert.equal(view.nodes.coordinator.children[2].textContent, "second-handoff.json / 1 task");
  await view.choose("second-handoff.json");
  assert.equal(view.nodes.goal.textContent, "New coordinator");
  assert.equal(view.location.searchParams.get("file"), "second-handoff.json");
  assert.equal(view.nodes.error.hidden, true);
  await view.navigate("");
  assert.equal(view.nodes.board.children.length, 0);
  await unlink(join(view.server.directory, "example-handoff.json"));
  await unlink(join(view.server.directory, "second-handoff.json"));
  await view.refresh();
  assert.match(view.nodes.coordinator.textContent, /No valid handoffs found/);
});

test("full paths with reserved characters load over HTTP, while invalid queries never select a fallback", async (t) => {
  const server = await serverFixture(t);
  const file = join(server.directory, "run #1 & followup.json");
  await server.write("run #1 & followup.json", example);
  const view = await board(t, example, { server, search: `?file=${encodeURIComponent(file)}` });
  assert.equal(view.nodes.error.hidden, true);
  assert.equal(view.nodes.coordinator.value, file);
  await view.choose("missing-handoff.json");
  assert.equal(view.nodes.error.hidden, false);
  assert.match(view.nodes.error.textContent, /ENOENT/);
  assert.equal(view.nodes.coordinator.value, "missing-handoff.json");
  assert.match(view.nodes.source.textContent, /run #1 & followup.json/);
  assert.match(view.nodes.error.textContent, /Showing the last successful snapshot of/);
  const empty = await board(t, example, { search: "?file=missing-handoff.json" });
  assert.equal(empty.nodes.board.children.length, 0);
  assert.match(empty.nodes.error.textContent, /No snapshot loaded/);
});

test("listing and selected-board failures remain independent", async (t) => {
  const view = await board(t);
  view.intercept((url) => {
    if (url.pathname === "/api/boards") {
      return Response.json({ error: "Directory scan failed" }, { status: 500 });
    }
  });
  await view.refresh({ ...example, goal: "Updated despite list failure" });
  assert.equal(view.nodes.goal.textContent, "Updated despite list failure");
  assert.match(view.nodes["discovery-error"].textContent, /Directory scan failed/);
  assert.equal(view.nodes.error.hidden, true);
  view.intercept(null);
  await unlink(join(view.server.directory, "example-handoff.json"));
  await view.refresh();
  assert.equal(view.nodes["discovery-error"].hidden, true);
  assert.equal(view.nodes.error.hidden, false);
  await view.refresh(example);
  assert.equal(view.nodes.error.hidden, true);
});

test("switching coordinators discards an older in-flight response and keeps one timer", async (t) => {
  const view = await board(t);
  await view.server.write("new-handoff.json", { ...example, id: "new", goal: "New selection" });
  let finishOldRead!: () => void;
  let oldReadStarted!: () => void;
  const started = new Promise<void>((resolve) => { oldReadStarted = resolve; });
  const gate = new Promise<void>((resolve) => { finishOldRead = resolve; });
  view.intercept(async (url) => {
    if (url.pathname === "/api/board" && url.searchParams.get("file") === "example-handoff.json") {
      oldReadStarted();
      await gate;
    }
  });
  const reading = view.refresh();
  await started;
  await view.choose("new-handoff.json");
  finishOldRead();
  await reading;
  assert.equal(view.nodes.goal.textContent, "New selection");
  assert.match(view.nodes.source.textContent, /new-handoff.json/);
  assert.equal(view.timers.length, 1);
});

test("an empty run shows all empty columns without inventing tasks", async (t) => {
  const view = await board(t, { ...example, tasks: [] });
  assert.equal(view.nodes.error.hidden, true);
  assert.equal(view.nodes.board.children.length, 5);
  for (const column of view.nodes.board.children) {
    assert.match(column.textContent, /\(0\)No tasks$/);
  }
});

test("HTTP discovery lists valid handoffs rather than unrelated reports", { timeout: 10000 }, async (t) => {
  const server = await serverFixture(t);
  const page = await fetch(server.url);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await page.text(), html);
  const module = await fetch(new URL("board-data.mjs", server.url));
  assert.equal(module.status, 200);
  assert.equal(module.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(await module.text(), readFileSync(join(import.meta.dirname, "board-data.mjs"), "utf8"));
  await server.write("report.json", { outcome: "complete", checks: [] });
  const response = await fetch(new URL("api/boards", server.url));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.boards.map((board: { file: string }) => board.file), ["example-handoff.json"]);
  assert.equal(data.boards[0].goal, example.goal);
  assert.deepEqual(data.errors, []);
});

test("HTTP discovery lists role handoffs but excludes board copies and worker JSON", async (t) => {
  const server = await serverFixture(t);
  for (const role of ["reviewer", "implementer", "coordinator"]) {
    await server.write(`project-${role}.json`, { ...example, id: `project-${role}` });
  }
  await server.write("old-board.json", example);
  await server.write("worker-result.json", example);
  await server.write("pass-snapshot.json", example);
  const data = await (await fetch(new URL("api/boards", server.url))).json();
  assert.deepEqual(data.boards.map((board: { file: string }) => board.file), [
    "example-handoff.json", "project-coordinator.json",
    "project-implementer.json", "project-reviewer.json",
  ]);
  assert.deepEqual(data.errors, []);
});

test("HTTP discovery reports invalid handoffs but excludes temporary JSON", async (t) => {
  const server = await serverFixture(t);
  await server.raw("broken-handoff.json", "incomplete JSON");
  await server.raw("unrelated-report.json", "incomplete report");
  await server.write("example-handoff.next.json", example);
  const data = await (await fetch(new URL("api/boards", server.url))).json();
  assert.deepEqual(data.boards.map((board: { file: string }) => board.file), ["example-handoff.json"]);
  assert.deepEqual(data.errors.map((error: { file: string }) => error.file), ["broken-handoff.json"]);
});

test("HTTP reads are uncached and expose only scoped handoffs and their referenced artifacts", async (t) => {
  const server = await serverFixture(t);
  const data = structuredClone(example);
  data.tasks[0].brief = "brief.md";
  await server.write("example-handoff.json", data);
  await server.raw("brief.md", "<script>not executable</script>");
  await server.raw("private.txt", "not a referenced artifact");
  const artifact = await fetch(new URL("api/artifact?file=example-handoff.json&name=brief.md", server.url));
  assert.equal(artifact.status, 200);
  assert.equal(artifact.headers.get("cache-control"), "no-store");
  assert.equal(artifact.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(artifact.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await artifact.text(), "<script>not executable</script>");
  for (const [route, status] of [
    ["api/artifact?file=example-handoff.json&name=private.txt", 403],
    ["api/board?file=../outside.json", 403],
    ["private.txt", 404],
    ["api/board?file=missing.json", 404],
  ] as [string, number][]) {
    assert.equal((await fetch(new URL(route, server.url))).status, status, route);
  }
  const outside = await mkdtemp(join(tmpdir(), "coordinator-board-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "private.json"), JSON.stringify(example));
  await symlink(join(outside, "private.json"), join(server.directory, "escape-handoff.json"));
  assert.equal((await fetch(new URL("api/board?file=escape-handoff.json", server.url))).status, 403);
});

test("CLI help has no state dependency and invalid arguments have a nonzero exit", () => {
  const script = join(import.meta.dirname, "coordinator.mjs");
  const help = spawnSync(process.execPath, [script, "serve", "--help", "--directory", "/no-such-state-directory"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /No packages are required/);
  assert.equal(help.stderr, "");
  for (const args of [["--unknown"], ["--port"], ["--port", "invalid"], ["--port", "65536"], ["extra-operand"]]) {
    const result = spawnSync(process.execPath, [script, "serve", ...args], { encoding: "utf8" });
    assert.equal(result.status, 2, JSON.stringify({ args, stderr: result.stderr }));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /--help/);
  }
  const missing = spawnSync(process.execPath, [script, "serve", "--directory", "/no-such-state-directory"], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ENOENT/);
});
