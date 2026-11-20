import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fstatSync, readFileSync, statSync, unlinkSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { link, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { defaultBranch } from "./default-branch.mjs";
import { dueRules, isObject, nextDue } from "./factory-data.mjs";
import type { Factory } from "./factory-data.ts";
import { alive } from "./state-dir.mjs";

type EventData = Record<string, any>;
export type BrokerEvent = {
  id: string | null;
  at: string;
  type: string;
  task: string | null;
  source: string;
  data: EventData;
};
type NewEvent = { type: string; task?: string | null; source: string; data?: EventData };
type WaitOptions = { since?: number; timeout?: number; exclude?: string[]; due?: boolean; reconcile?: number };
type ArmedOptions = Required<Omit<WaitOptions, "since" | "timeout">> & Pick<WaitOptions, "since" | "timeout">;
type WaitResult = { events: BrokerEvent[]; cursor: string; timeout?: true };

const maxTimer = 2 ** 31 - 1;
const maxLine = 64 * 1024;
const reconcileEvery = "5m";
const reconcileMs = 5 * 60_000;
const workerOutcomes = ["working", "waiting", "complete", "blocked"];
const attentionKinds = ["permission", "sandbox-bypass", "ask-user", "other"];
const maxAttentionText = 2000;
const changeKinds = ["rule", "limit", "budget", "process", "skill"];
const answers = ["accept", "decline"];
const decisions = ["accepted", "declined"];

// Each type lists whether it needs --task and the data keys it must carry.
const eventTypes = {
  "task.moved": { task: true, data: ["to"] },
  "task.updated": { task: true, data: ["revision"] },
  "worker.result": { task: true, data: ["role", "outcome"] },
  "worker.blocked": { task: true, data: ["role", "reason"] },
  "pr.merged": { task: true, data: ["pr", "merge_commit"] },
  "feedback.pending": { task: true, data: ["feedback_id"] },
  "budget.updated": { task: false, data: ["max_parallel_workers"] },
  "limits.updated": { task: false, data: ["investigation", "implementation"] },
  "lever.updated": { task: false, data: ["spend", "autonomy_cap"] },
  "attention.requested": { task: false, data: ["session", "kind", "text"] },
  "attention.resolved": { task: false, data: ["session"] },
  "improve.proposed": { task: false, data: ["rule", "change", "title", "evidence", "recommended", "proposal_id", "result"] },
  "improve.decided": { task: false, data: ["proposal_id", "decision"] },
};

export const eventsFile = (file: string) =>
  join(dirname(file), `${basename(file, extname(file))}-events.jsonl`);

const waiterFile = (file: string) =>
  join(dirname(file), `${basename(file, extname(file))}-waiter.pid`);

class UsageError extends Error {}

function isWaiter(pid: number) {
  if (!alive(pid)) return false;
  // A reused PID is alive but not a waiter. An orphan (parent gone, so ppid 1) has no
  // reader for its output: its wake can never reach the agent. When ps cannot run
  // (some sandboxes), the process cannot be identified, so it counts as the waiter.
  try {
    const line = execFileSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const [, ppid, command] = line.match(/^\s*(\d+)\s+(.*)$/s) ?? [];
    return command !== undefined && /(?:broker\.mjs|factory\.mjs\s+broker)\s+wait\b/.test(command) && Number(ppid) > 1;
  } catch {
    return true;
  }
}

// Output sent to a file or /dev/null is never read, so the agent would not be woken.
function stdoutUnread() {
  try {
    const out = fstatSync(1);
    return out.isFile() || (out.isCharacterDevice() && out.rdev === statSync("/dev/null").rdev);
  } catch {
    return false;
  }
}

// The PID of the armed waiter for this factory, or null when none runs. A PID file
// whose process is gone, or whose PID now belongs to another command, is stale and
// counts as no waiter.
export async function waiterPid(factory: string): Promise<number | null> {
  let text;
  try {
    text = await readFile(waiterFile(factory), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const pid = Number.parseInt(text, 10);
  return Number.isInteger(pid) && pid > 0 && isWaiter(pid) ? pid : null;
}

// A hard link makes the claim atomic and never exposes a half-written PID file.
async function claimWaiter(factory: string) {
  const path = waiterFile(factory);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${process.pid}\n`, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await link(temp, path);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const pid = await waiterPid(factory);
      if (pid !== null) {
        throw new Error(`A waiter (pid ${pid}) is already armed for this factory. Keep only one waiter. Wait for it to exit, or stop it.`);
      }
      await rm(path, { force: true });
    }
    throw new Error("Another waiter claimed this factory at the same time. Keep only one waiter.");
  } finally {
    await rm(temp, { force: true });
  }
}

function releaseWaiter(factory: string) {
  const path = waiterFile(factory);
  try {
    if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
  } catch {
    // Nothing to release.
  }
}

function validateEvent({ type, task, source, data }: { type: string; task: string | null; source: string; data: EventData }) {
  const schema = eventTypes[type as keyof typeof eventTypes] as { task: boolean; data: string[] } | undefined;
  if (!schema) throw new UsageError(`Unknown event type ${type}. Use one of: ${Object.keys(eventTypes).join(", ")}.`);
  if (!/^[a-z][a-z0-9-]*$/.test(source)) throw new UsageError("--source must be lowercase letters, digits, and hyphens.");
  if (schema.task && !task) throw new UsageError(`${type} needs --task ID.`);
  if (!isObject(data)) throw new UsageError("--data must be a JSON object.");
  for (const key of schema.data) {
    if (data[key] === undefined) throw new UsageError(`${type} data needs "${key}".`);
  }
  if (type === "worker.result" && !workerOutcomes.includes(data.outcome)) {
    throw new UsageError(`worker.result outcome must be one of: ${workerOutcomes.join(", ")}.`);
  }
  if (type.startsWith("attention.")) validateAttention(type, data);
  if (type.startsWith("improve.")) validateImprove(type, data);
}

function validateImprove(type: string, data: EventData) {
  const text = (key: string) => {
    if (typeof data[key] !== "string" || data[key] === "") throw new UsageError(`${type} data "${key}" must be a non-empty string.`);
  };
  text("proposal_id");
  if (type === "improve.decided") {
    if (!decisions.includes(data.decision)) throw new UsageError(`${type} decision must be one of: ${decisions.join(", ")}.`);
    if (data.note !== undefined && typeof data.note !== "string") throw new UsageError(`${type} data "note" must be a string.`);
    return;
  }
  for (const key of ["rule", "title", "result"]) text(key);
  if (typeof data.evidence !== "string") throw new UsageError(`${type} data "evidence" must be a string.`);
  if (data.evidence.length > maxAttentionText) throw new UsageError(`${type} data "evidence" must have at most ${maxAttentionText} characters.`);
  if (!changeKinds.includes(data.change)) throw new UsageError(`${type} change must be one of: ${changeKinds.join(", ")}.`);
  if (data.result !== basename(data.result) || data.result.startsWith(".")) {
    throw new UsageError(`${type} data "result" must name a file in the state directory.`);
  }
  if (!answers.includes(data.recommended)) throw new UsageError(`${type} recommended must be one of: ${answers.join(", ")}.`);
}

function validateAttention(type: string, data: EventData) {
  const text = (key: string) => {
    if (typeof data[key] !== "string") throw new UsageError(`${type} data "${key}" must be a string.`);
  };
  text("session");
  if (data.session === "") throw new UsageError(`${type} data "session" must not be empty.`);
  for (const key of ["role", "pane"]) {
    if (data[key] !== undefined) text(key);
  }
  if (type === "attention.resolved") return;
  text("text");
  if (data.text.length > maxAttentionText) throw new UsageError(`${type} data "text" must have at most ${maxAttentionText} characters.`);
  if (!attentionKinds.includes(data.kind)) throw new UsageError(`${type} kind must be one of: ${attentionKinds.join(", ")}.`);
  if (data.options !== undefined && !(Array.isArray(data.options) && data.options.every((option: unknown) => typeof option === "string"))) {
    throw new UsageError(`${type} data "options" must be an array of strings.`);
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// The result file sits in the state directory beside the factory file; a worker names it,
// so it must match the event it announces.
async function checkResult(factory: string, { type, task, data }: { type: string; task: string | null; data: EventData }) {
  const name = data.result;
  if (typeof name !== "string" || name !== basename(name) || name.startsWith(".")) {
    throw new Error(`${type} data "result" must name a result file in the state directory.`);
  }
  let saved;
  try {
    saved = JSON.parse(await readFile(join(dirname(factory), name), "utf8"));
  } catch (error) {
    throw new Error(`Result file ${name} is not readable JSON in the state directory: ${(error as Error).message}`);
  }
  const outcome = type === "worker.blocked" ? "blocked" : data.outcome;
  for (const [key, want] of [["task", task], ["role", data.role], ["outcome", outcome]]) {
    if (saved?.[key] !== want) throw new Error(`Result file ${name} has ${key} ${JSON.stringify(saved?.[key])}, but the event has ${JSON.stringify(want)}.`);
  }
}

// A task without a worktree record has no branch to check. A task with a PR merges the default
// branch in (never rebases), so only a local-landing task must descend from it.
async function checkHead(factory: string, task: string | null, head: string) {
  const record = JSON.parse(await readFile(factory, "utf8")).tasks?.find(({ id }: { id: string }) => id === task);
  const worktree = record?.worktree;
  if (!worktree?.path) return;
  const at = git(worktree.path, "rev-parse", "HEAD");
  if (at !== head) throw new Error(`The worktree ${worktree.path} is at ${at}, not at head ${head}. Commit the changes. Then report the correct head.`);
  if (git(worktree.path, "status", "--porcelain")) throw new Error(`The worktree ${worktree.path} has uncommitted changes. Commit them. Then emit the event again.`);
  if (record.pr) return;
  const base = defaultBranch(worktree.path) ?? "main";
  try {
    git(worktree.path, "merge-base", "--is-ancestor", base, head);
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error;
    throw new Error(`Head ${head} does not descend from ${base}. Run git rebase ${base}. Then emit the event again.`);
  }
}

// Refuses an event the factory could not trust. Nothing is appended on failure.
async function checkEvent(factory: string, event: { type: string; task: string | null; data: EventData }) {
  const { type, task, data } = event;
  if (type === "worker.result" || (type === "worker.blocked" && data.result !== undefined)) {
    await checkResult(factory, event);
  }
  if (type === "worker.result" && data.role === "implementation" && data.outcome === "complete" && typeof data.head === "string") {
    await checkHead(factory, task, data.head);
  }
  if (type === "pr.merged" && !/^[0-9a-f]{40}$/.test(data.merge_commit)) {
    throw new Error("pr.merged data merge_commit must be a full 40-character SHA.");
  }
}

// The log directory is resolved the way factory.mjs resolves its file.
export async function resolveFactory(file: string) {
  return join(await realpath(dirname(resolve(file))), basename(file));
}

async function size(file: string) {
  try {
    return (await stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

// One O_APPEND write per event keeps concurrent emitters from interleaving lines.
export async function emit(factory: string, { type, task = null, source, data = {} }: NewEvent) {
  validateEvent({ type, task, source, data });
  await checkEvent(factory, { type, task, data });
  const event = { id: randomUUID(), at: new Date().toISOString(), type, task, source, data };
  const line = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(line) > maxLine) throw new Error("Event is larger than 64 KiB. Keep long evidence in the result file.");
  const handle = await open(eventsFile(factory), "a", 0o600);
  try {
    await handle.write(line);
  } finally {
    await handle.close();
  }
  return event;
}

// Reads complete lines after the byte offset; a trailing partial line stays unread.
async function readEvents(file: string, offset: number) {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && offset === 0) return { events: [] as BrokerEvent[], cursor: 0 };
    throw error;
  }
  try {
    const { size: length } = await handle.stat();
    if (offset > length) throw new Error(`Cursor ${offset} is past the end of the log (${length} bytes).`);
    const buffer = Buffer.alloc(length - offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const text = buffer.subarray(0, bytesRead);
    const end = text.lastIndexOf(10) + 1;
    const events: BrokerEvent[] = [];
    for (const line of text.subarray(0, end).toString("utf8").split("\n")) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        console.error(`Skipped an invalid event line: ${line.slice(0, 80)}`);
      }
    }
    return { events, cursor: offset + end };
  } finally {
    await handle.close();
  }
}

export async function waitForEvents(factory: string, { since, timeout, exclude = [], due = false, reconcile = reconcileMs }: WaitOptions) {
  await claimWaiter(factory);
  const release = () => releaseWaiter(factory);
  process.on("exit", release);
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) process.once(signal, () => process.exit(code));
  try {
    return await armedWait(factory, { since, timeout, exclude, due, reconcile });
  } finally {
    release();
    process.off("exit", release);
  }
}

async function armedWait(factory: string, { since, timeout, exclude, due, reconcile }: ArmedOptions) {
  const file = eventsFile(factory);
  let cursor = since ?? await size(file);
  const state = async (): Promise<Factory> => JSON.parse(await readFile(factory, "utf8"));

  const watchers: FSWatcher[] = [];
  const timers: NodeJS.Timeout[] = [];
  let dueTimers: NodeJS.Timeout[] = [];
  let dueAt: number | null = null;
  // Each waiter starts its own window, so a wake never fires the tick at once.
  const reconcileTimers: NodeJS.Timeout[] = [];
  let reconcileAt = Date.now() + reconcile;
  let stopped = false;
  try {
    return await new Promise<WaitResult>((complete, fail) => {
      let dirty = false;
      let checking = false;
      const finish = (result: WaitResult) => {
        stopped = true;
        complete(result);
      };
      const abort = (error: unknown) => {
        stopped = true;
        fail(error);
      };
      // The timer follows the factory file, so run-status and rule edits re-arm it.
      const armDue = (next: number | null) => {
        if (next === dueAt) return;
        dueAt = next;
        for (const timer of dueTimers) clearTimeout(timer);
        dueTimers = [];
        if (next !== null) after(Math.max(next - Date.now(), 0), () => void check(next), dueTimers);
      };
      const armReconcile = () => {
        for (const timer of reconcileTimers.splice(0)) clearTimeout(timer);
        const at = reconcileAt;
        after(Math.max(at - Date.now(), 0), () => void check(at), reconcileTimers);
      };
      async function check(now = Date.now()) {
        dirty = true;
        if (checking || stopped) return;
        checking = true;
        try {
          while (dirty && !stopped) {
            dirty = false;
            const read = await readEvents(file, cursor);
            cursor = read.cursor;
            const events = read.events.filter((event) => !exclude.includes(event.source));
            if (due) {
              const data = await state();
              armDue(nextDue(data));
              // Due rules come from the factory file on every wake, so they are never lost.
              const rules = dueRules(data, now);
              if (rules.length) {
                events.push({ id: null, at: new Date(now).toISOString(), type: "rule.due", task: null, source: "broker", data: { rules } });
              }
              const tick = Math.max(now, Date.now());
              if (tick >= reconcileAt) {
                if (data.status === "active") {
                  events.push({ id: null, at: new Date(now).toISOString(), type: "reconcile.due", task: null, source: "broker", data: { every: reconcileEvery } });
                }
                reconcileAt = tick + reconcile;
                armReconcile();
              }
            }
            if (events.length) finish({ events, cursor: String(cursor) });
          }
        } catch (error) {
          abort(error);
        } finally {
          checking = false;
        }
      }

      const directory = dirname(file);
      const watched = [basename(file), basename(factory)];
      const watcher = watch(directory, (_, name) => {
        if (name === null || watched.includes(name)) void check();
      });
      watcher.on("error", abort);
      watcher.on("close", () => {
        if (!stopped) abort(new Error(`Event watcher closed unexpectedly: ${directory}`));
      });
      watchers.push(watcher);

      function after(ms: number, action: () => void, list = timers) {
        const tick = (left: number) => {
          list.push(setTimeout(() => (left > maxTimer ? tick(left - maxTimer) : action()), Math.min(left, maxTimer)));
        };
        tick(ms);
      }
      if (timeout !== undefined) after(timeout * 1000, () => finish({ events: [], cursor: String(cursor), timeout: true }));
      if (due) armReconcile();
      console.error("Watching events.");
      void check();
    });
  } finally {
    stopped = true;
    for (const timer of [...timers, ...dueTimers, ...reconcileTimers]) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  }
}

const usage = `Factory event broker: a durable event log that only grows, with a waiter that wakes at once.

Usage: node broker.mjs wait FACTORY_FILE [--since CURSOR] [--timeout SECONDS]
                       [--exclude-source SOURCE ...] [--due]
       node broker.mjs emit FACTORY_FILE TYPE [--task ID] [--source SOURCE] [--data JSON]
       node broker.mjs cursor FACTORY_FILE
       node broker.mjs armed FACTORY_FILE

The log is <owner.repo>-factory-events.jsonl beside FACTORY_FILE (mode 0600). A cursor is a
byte offset in the log. Events are notifications. The factory JSON file stays the source of truth.

wait    Waits until an event exists after the cursor, prints {"events":[...],"cursor":"N"},
        and exits. Give the printed cursor to the next wait. Then no event is lost between calls.
        Without --since, wait starts at the current end of the log ("cursor" prints that end).
        --exclude-source skips events from a source (repeatable), so the factory ignores its
        own writes. Skipped events still advance the cursor.
        --timeout S exits 0 with "events":[] and "timeout":true after S seconds.
        --due also returns a synthetic rule.due event (data.rules = rule IDs) when an enabled
        rule with "every" is due. It follows the factory file, so edits of run-status and rules
        move the due time while it waits. Set last_run_at with factory.mjs --rule ID --ran.
        If you do not, the next wait returns the event again. Do not use --due while no
        slot is free for the rule.
        --due also returns a synthetic reconcile.due event (data.every = "5m") every 5 minutes
        after the waiter starts, while the run is active. The window is per waiter, so a wake
        does not start it at once. After this event, run reconcile.mjs and arm the waiter again.
emit    Appends one event and prints it. Types: ${Object.keys(eventTypes).join(", ")}.
        Needed data keys: ${Object.entries(eventTypes).map(([type, { data }]) => `${type}: ${data.join(", ")}`).join("; ")}.
        worker.result outcome: ${workerOutcomes.join(", ")}. --source defaults to worker.
        emit refuses a worker.result (exit 1, nothing appended) when data.result is not a JSON
        file in the state directory with the same task, role, and outcome. A worker.blocked with
        data.result gets the same check with outcome blocked. A complete implementation
        worker.result with data.head must match HEAD of the worktree of the task. For a task
        without a PR, the head must also descend from main. emit skips these checks when the
        task has no worktree record.
        pr.merged needs a full merge_commit SHA.
        attention.requested and attention.resolved need no --task (a rule worker or the
        coordinator has none). A hook emits them with --source attention when a Copilot session
        waits for the user. attention.requested data: session (the Copilot session ID, a string),
        kind (${attentionKinds.join(", ")}), text (a string of at most ${maxAttentionText} characters), and
        optional role, pane (strings) and options (an array of strings). attention.resolved needs
        only session. Wait with --exclude-source attention, so these events never wake the factory.
        improve.proposed (--source improve, no --task) puts one proposed change of an improve rule
        in the "Waiting for you" list of the dashboard. data: rule, change (${changeKinds.join(", ")}), title,
        evidence (a string of at most ${maxAttentionText} characters), recommended (${answers.join(", ")}),
        proposal_id (unique), and result (the name of the result file). The dashboard server appends
        improve.decided (--source dashboard; data proposal_id, decision ${decisions.join(" or ")}, optional note)
        when the user clicks. Wait with --exclude-source improve, so a proposal never wakes the
        factory. The decision always wakes it.
        pr.merged is a hint from the implementation worker (role, pr, merge_commit, head). The
        factory verifies the merge on GitHub before it resolves the task.
        factory.mjs emits task.moved, task.updated, and feedback.pending after every task write.
        It emits budget.updated, limits.updated, or lever.updated (no --task) after every write
        of that setting.
cursor  Prints {"cursor":"N"} for the current end of the log.
armed   Read-only. Prints {"armed":true,"pid":N} and exits 0 when a waiter for this factory is
        alive. Prints {"armed":false} and exits 1 when no waiter is alive. wait records its PID in
        <owner.repo>-factory-waiter.pid and removes it on exit. A PID file is stale in these cases:
        the process is gone; the command line of the process (ps -o command=) is not
        "broker.mjs wait" (a reused PID); or the parent of the process is gone (ppid 1), so
        the process is an orphan that nobody reads. wait refuses to start when stdout goes to
        a file or to /dev/null. Without a usable ps, a live PID counts as the waiter.
        A second wait for the same factory exits 1 unless the first waiter is stale, so only one
        waiter exists. A turn must never end while armed exits 1.

The command prints progress and errors to stderr. Exit: 0 success, 1 operational failure, 2 invalid usage.`;

export async function main(argv: string[]) {
  let command = "";
  let factory = "";
  let event: NewEvent = { type: "", source: "" };
  let waitOptions: WaitOptions = {};
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
        since: { type: "string" },
        timeout: { type: "string" },
        "exclude-source": { type: "string", multiple: true },
        due: { type: "boolean" },
        task: { type: "string" },
        source: { type: "string" },
        data: { type: "string" },
      },
      allowPositionals: true,
    });
    if (values.help || positionals.length === 0) {
      console.log(usage);
      process.exitCode = values.help ? 0 : 2;
      return;
    }
    const [name, file, ...args] = positionals;
    if (!["wait", "emit", "cursor", "armed"].includes(name)) throw new Error(`Unknown command ${name}.`);
    if (!file) throw new Error("A factory FILE is required.");
    command = name;
    factory = file;
    if (command === "emit") {
      if (args.length !== 1) throw new Error("emit needs exactly one TYPE.");
      event = {
        type: args[0],
        task: values.task ?? null,
        source: values.source ?? "worker",
        data: values.data === undefined ? {} : JSON.parse(values.data),
      };
    } else {
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}.`);
      if (command === "wait") {
        if (values.since !== undefined && !/^\d+$/.test(values.since)) throw new Error("--since must be a cursor printed by wait or cursor.");
        const timeout = values.timeout === undefined ? undefined : Number(values.timeout);
        if (timeout !== undefined && !(timeout > 0)) throw new Error("--timeout must be a positive number of seconds.");
        waitOptions = {
          since: values.since === undefined ? undefined : Number(values.since),
          timeout,
          exclude: values["exclude-source"] ?? [],
          due: values.due === true,
        };
      }
    }
  } catch (error) {
    console.error(`${(error as Error).message}\nRun with --help for usage.`);
    process.exitCode = 2;
    return;
  }
  try {
    factory = await resolveFactory(factory);
    if (command === "emit") {
      console.log(JSON.stringify(await emit(factory, event)));
    } else if (command === "cursor") {
      console.log(JSON.stringify({ cursor: String(await size(eventsFile(factory))) }));
    } else if (command === "armed") {
      const pid = await waiterPid(factory);
      console.log(JSON.stringify(pid === null ? { armed: false } : { armed: true, pid }));
      if (pid === null) process.exitCode = 1;
    } else {
      if (stdoutUnread()) {
        throw new UsageError("wait refuses to run with stdout sent to a file or /dev/null. Nobody would read the wake. Run wait as async bash and read its output. Never run it in the background with & or nohup.");
      }
      console.log(JSON.stringify(await waitForEvents(factory, waitOptions)));
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
