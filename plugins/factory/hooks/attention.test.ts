import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import hooks from "../hooks.json" with { type: "json" };

const script = join(import.meta.dirname, "..", "skills", "lifecycle", "factory.mjs");
const pluginRoot = join(import.meta.dirname, "..");
const fixtures = join(import.meta.dirname, "fixtures");
const load = async (name: string) => JSON.parse(await readFile(join(fixtures, name), "utf8"));
const PERMISSION_SESSION = "00000000-0000-4000-8000-000000000001";

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "attention-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, "state");
  const scratch = join(directory, "tmp");
  await mkdir(state);
  await mkdir(scratch);
  const file = join(state, "owner.repo-factory.json");
  await writeFile(file, JSON.stringify({ tasks: [] }));
  const events = async () => {
    try {
      const text = await readFile(join(state, "owner.repo-factory-events.jsonl"), "utf8");
      return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const run = (payload: string | Record<string, unknown>, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [script, "hook", "attention"], {
      encoding: "utf8",
      input: typeof payload === "string" ? payload : JSON.stringify({ ...payload, cwd: directory }),
      env: { PATH: process.env.PATH, TMPDIR: scratch, HOME: directory, FACTORY_FILE: file, ...env },
    });
  const worker = { FACTORY_TASK: "t1", FACTORY_ROLE: "implementation", REX_BLOCK: "block:abc" };
  return { directory, state, scratch, file, events, run, worker };
}

test("hooks.json declares the notification, permissionRequest and ask_user preToolUse entries", () => {
  assert.equal(hooks.hooks.notification.length, 1);
  assert.equal(hooks.hooks.permissionRequest.length, 1);
  for (const entry of [...hooks.hooks.notification, ...hooks.hooks.permissionRequest, hooks.hooks.preToolUse[1]]) {
    assert.equal(entry.type, "command");
    assert.ok(entry.bash.includes("factory.mjs\" hook attention"));
    assert.ok(entry.timeoutSec > 0 && entry.timeoutSec <= 30);
  }
});

test("does nothing in a session that is not the factory", async (t) => {
  const { run, events, scratch } = await setup(t);
  for (const name of ["notification-permission.json", "notification-elicitation.json", "permission-request-sandbox-bypass.json"]) {
    const out = run(await load(name));
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout + out.stderr, "");
  }
  assert.deepEqual(await events(), []);
  assert.deepEqual(await readdir(scratch), []);
});

test("a worker's permission prompt appends attention.requested", async (t) => {
  const { run, events, worker } = await setup(t);
  const out = run(await load("notification-permission.json"), worker);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout + out.stderr, "");
  const [event, ...rest] = await events();
  assert.equal(rest.length, 0);
  assert.equal(event.type, "attention.requested");
  assert.equal(event.source, "attention");
  assert.equal(event.task, null);
  assert.deepEqual(event.data, {
    session: PERMISSION_SESSION,
    kind: "permission",
    text: "Run command: ls /home/user/other | head -3",
    role: "implementation",
    pane: "block:abc",
  });
});

test("a sandbox-bypass request carries the reason from permissionRequest", async (t) => {
  const { run, events, worker } = await setup(t);
  assert.equal(run(await load("permission-request-sandbox-bypass.json"), worker).status, 0);
  assert.deepEqual(await events(), []);
  assert.equal(run(await load("notification-permission.json"), worker).status, 0);
  const [event] = await events();
  assert.equal(event.data.kind, "sandbox-bypass");
  assert.equal(
    event.data.text,
    "Run command: ls /home/user/other | head -3\nSandbox bypass: `/home/user/other` is outside the sandbox's readable paths.",
  );
});

test("an ask_user question carries its message and options", async (t) => {
  const { run, events, worker } = await setup(t);
  assert.equal(run(await load("pre-tool-use-ask-user.json"), worker).status, 0);
  assert.equal(run(await load("notification-elicitation.json"), worker).status, 0);
  const [event] = await events();
  assert.equal(event.data.kind, "ask-user");
  assert.equal(event.data.text, "Which color do you prefer?");
  assert.deepEqual(event.data.options, ["red", "green", "blue"]);
});

test("a form with several fields or a non-enum field carries no options", async (t) => {
  const { run, events, worker } = await setup(t);
  const payload = await load("pre-tool-use-ask-user.json");
  const color = payload.toolArgs.requestedSchema.properties.color;
  const forms = [
    { color, size: { type: "string", enum: ["s", "m"] } },
    { count: { type: "integer" } },
    { color: { ...color, enum: ["red", 3] } },
  ];
  for (const properties of forms) {
    const form = { ...payload, toolArgs: { ...payload.toolArgs, requestedSchema: { properties } } };
    assert.equal(run(form, worker).status, 0);
    assert.equal(run(await load("notification-elicitation.json"), worker).status, 0);
  }
  assert.deepEqual((await events()).map((event) => event.data.options), [undefined, undefined, undefined]);
});

test("an elicitation without a note falls back to the notification message", async (t) => {
  const { run, events, worker } = await setup(t);
  assert.equal(run(await load("notification-elicitation.json"), worker).status, 0);
  const [event] = await events();
  assert.equal(event.data.kind, "ask-user");
  assert.equal(event.data.text, "Information requested");
  assert.equal(event.data.options, undefined);
});

test("a note from another prompt is not reused", async (t) => {
  const { run, events, worker } = await setup(t);
  assert.equal(run(await load("permission-request-sandbox-bypass.json"), worker).status, 0);
  const other = { ...(await load("notification-permission.json")), message: "Run command: rm -rf build" };
  assert.equal(run(other, worker).status, 0);
  const [event] = await events();
  assert.equal(event.data.kind, "permission");
  assert.equal(event.data.text, "Run command: rm -rf build");
});

test("text is capped at 2000 characters", async (t) => {
  const { run, events, worker } = await setup(t);
  const payload = { ...(await load("notification-permission.json")), message: "x".repeat(5000) };
  assert.equal(run(payload, worker).status, 0);
  const [event] = await events();
  assert.equal(event.data.text.length, 2000);
});

test("finds a worker by its session in the factory file", async (t) => {
  const { run, events, file } = await setup(t);
  const workers = { implementation: { status: "running", session: PERMISSION_SESSION, pane: "block:file" } };
  await writeFile(file, JSON.stringify({ tasks: [{ id: "t1", workers }] }));
  assert.equal(run(await load("notification-permission.json")).status, 0);
  const [event] = await events();
  assert.equal(event.data.role, "implementation");
  assert.equal(event.data.pane, "block:file");
});

test("recognizes the coordinator by the owner lock", async (t) => {
  const { run, events, state } = await setup(t);
  const lock = join(state, "owner.repo-factory.lock");
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ copilot_session: PERMISSION_SESSION }));
  assert.equal(run(await load("notification-permission.json")).status, 0);
  const [event] = await events();
  assert.equal(event.data.role, "coordinator");
  assert.equal(event.data.pane, undefined);
});

test("a notification that is not a prompt raises no event", async (t) => {
  const { run, events, worker } = await setup(t);
  for (const name of ["notification-inbox-message.json", "notification-shell-completed.json"]) {
    const out = run(await load(name), worker);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout + out.stderr, "", name);
  }
  assert.deepEqual(await events(), []);
  assert.equal(run(await load("notification-permission.json"), worker).status, 0);
  assert.equal((await events()).length, 1);
});

test("garbage input exits 0 with no output and no event", async (t) => {
  const { run, events, worker } = await setup(t);
  const bad = ["", "not json", "null", "[]", "42", '{"sessionId":7}', '{"sessionId":"s","notification_type":{}}'];
  for (const input of bad) {
    const out = run(input, worker);
    assert.equal(out.status, 0, input);
    assert.equal(out.stdout + out.stderr, "", input);
  }
  assert.deepEqual(await events(), []);
});

test("exits 0 when the state directory is missing", async (t) => {
  const { run, directory, worker } = await setup(t);
  const out = run(await load("notification-permission.json"), { ...worker, FACTORY_FILE: join(directory, "gone", "x-factory.json") });
  assert.equal(out.status, 0);
  assert.equal(out.stdout + out.stderr, "");
});

test("the preToolUse entry runs the hook only for ask_user", async (t) => {
  const { directory, scratch, worker } = await setup(t);
  const entry = hooks.hooks.preToolUse[1];
  const run = async (name: string) => {
    const payload = JSON.stringify({ ...(await load(name)), cwd: directory });
    return spawnSync("/bin/bash", ["-c", entry.bash], {
      encoding: "utf8",
      input: payload,
      env: { PATH: process.env.PATH, TMPDIR: scratch, HOME: directory, PLUGIN_ROOT: pluginRoot, FACTORY_FILE: join(directory, "state", "owner.repo-factory.json"), ...worker },
    });
  };
  const bash = await run("pre-tool-use-sandbox-bypass.json");
  assert.equal(bash.status, 0, bash.stderr);
  assert.deepEqual(await readdir(scratch), []);
  const ask = await run("pre-tool-use-ask-user.json");
  assert.equal(ask.status, 0, ask.stderr);
  assert.equal(ask.stdout + ask.stderr, "");
  assert.equal((await readdir(scratch)).length, 1);
});
