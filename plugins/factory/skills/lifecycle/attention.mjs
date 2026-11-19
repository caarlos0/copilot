import { execFile } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { emit, eventsFile, resolveFactory } from "./broker.mjs";

const run = promisify(execFile);
const tailBytes = 256 * 1024;
const maxTailBytes = 64 * 1024 * 1024;
const lookBackMs = 60_000;
const expireMs = 24 * 3_600_000;

// Rex may record short IDs; a short ID is the tail of the full one.
const bare = (id) => id.replace(/^\w+:/, "");
export const sameId = (a, b) => bare(a).endsWith(bare(b)) || bare(b).endsWith(bare(a));

const sessionState = () => process.env.FACTORY_SESSION_STATE ?? join(homedir(), ".copilot", "session-state");

async function readJSON(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

// Session logs reach 500 MB, so read the last bytes only. A busy session writes more than one
// tail after a prompt (tool output, streaming), so the tail grows until it reaches an event
// from before `since`, the start of the log, or the cap. The first line of a tail is cut.
async function tailEvents(file, since) {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  try {
    const { size } = await handle.stat();
    for (let bytes = tailBytes; ; bytes *= 4) {
      const start = Math.max(0, size - bytes);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      if (start > 0) lines.shift();
      const events = [];
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // A blank or partial line.
        }
      }
      const oldest = events.map(({ timestamp }) => Date.parse(timestamp)).find(Number.isFinite);
      if (start === 0 || bytes >= maxTailBytes || oldest < since - lookBackMs) return events;
    }
  } finally {
    await handle.close();
  }
}

// Times of the events that show a prompt was answered: a completed permission, or the end of
// an ask_user call. The completion has no tool name, so match it to its start by tool call ID.
async function answerTimes(session, since) {
  if (!/^[\w-]+$/.test(session)) return [];
  const events = await tailEvents(join(sessionState(), session, "events.jsonl"), since);
  const askUser = new Set(events
    .filter(({ type, data }) => type === "tool.execution_start" && data?.toolName === "ask_user")
    .map(({ data }) => data.toolCallId));
  return events
    .filter(({ type, data }) => type === "permission.completed" || (type === "tool.execution_complete" && askUser.has(data?.toolCallId)))
    .map(({ timestamp }) => Date.parse(timestamp))
    .filter(Number.isFinite);
}

// Block IDs in the live Rex server, or null when Rex cannot tell. `--json` needs one session,
// so ask for the IDs of every session. An empty answer is a Rex glitch, never "no panes".
async function liveBlocks() {
  try {
    const { stdout } = await run("rex", ["--autostart=false", "block", "ls", "-A", "-q", "--short=false"], { timeout: 10_000 });
    const ids = stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("block:"));
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

// Reads the factory events log and sorts every attention.requested that no attention.resolved
// followed into open and resolved. An open item is one whose session shows no answer, whose pane
// is still live, and that is under 24 hours old. `resolved` lists the items closed by those
// signals, with the reason, so the caller can record the missing attention.resolved event.
// `panes` replaces the Rex query: an array of live block IDs, or null to skip the check.
export async function scanAttention(file, { now = Date.now(), panes } = {}) {
  let text;
  try {
    text = await readFile(eventsFile(file), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { open: [], resolved: [] };
    throw error;
  }
  const requests = new Map();
  for (const line of text.split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const session = event?.data?.session;
    if (typeof session !== "string") continue;
    // The hook no longer records `other` (an inbox message or a finished shell command is not a
    // wait), but older logs hold them.
    if (event.type === "attention.requested") {
      if (event.data.kind !== "other") requests.set(event.id, event);
    } else if (event.type === "attention.resolved") {
      for (const [id, request] of requests) if (request.data.session === session) requests.delete(id);
    }
  }
  if (requests.size === 0) return { open: [], resolved: [] };

  const titles = new Map((await readJSON(file))?.tasks?.map((task) => [task.id, task.title]));
  const firstAsked = new Map();
  for (const { at, data } of requests.values()) {
    firstAsked.set(data.session, Math.min(firstAsked.get(data.session) ?? Infinity, Date.parse(at)));
  }
  const answers = new Map();
  let live = panes;
  const open = [];
  const resolved = [];
  for (const event of requests.values()) {
    const { session, kind, text: message, role = null, pane = null, options = [] } = event.data;
    const task = event.task ?? event.data.task ?? null;
    const item = { id: event.id, at: event.at, session, task, role, kind, text: message, options, pane, title: titles.get(task) ?? null };
    const at = Date.parse(event.at);
    if (!answers.has(session)) answers.set(session, await answerTimes(session, firstAsked.get(session)));

    let reason = null;
    if (answers.get(session).some((time) => time > at)) reason = "answered";
    else if (now - at > expireMs) reason = "expired";
    else if (pane) {
      if (live === undefined) live = await liveBlocks();
      if (live && !live.some((id) => sameId(id, pane))) reason = "pane-gone";
    }
    if (reason) resolved.push({ item, reason });
    else open.push(item);
  }
  return { open, resolved };
}

export async function openAttention(file, options) {
  return (await scanAttention(file, options)).open;
}

// Scans, then records an attention.resolved event for each session whose items closed by a
// signal, so every reader sees them closed. One event closes every request of its session, so
// a session with a newer open request waits. Returns the scan.
export async function resolveAttention(file, { source, ...options }) {
  const scan = await scanAttention(file, options);
  const waiting = new Set(scan.open.map((item) => item.session));
  const recorded = new Set();
  for (const { item, reason } of scan.resolved) {
    if (waiting.has(item.session) || recorded.has(item.session)) continue;
    recorded.add(item.session);
    await emit(await resolveFactory(file), { type: "attention.resolved", source, data: { session: item.session, reason } });
  }
  return scan;
}

const fail = (status, message) => Object.assign(new Error(message), { status });

// The keys that pick option `index` of an ask_user form with one enum field. It has no number
// keys: Down moves the highlight from the first option and Enter submits the form.
const answerKeys = (index) => [...Array(index).fill("down"), "enter"];

// Types the user's click into the item's pane. The caller has checked that the item is pending.
// Rex gets an argument array and no shell; the pane must be a plain block ID that Rex still lists.
// Permission prompts name no options, so nothing is sent to them.
export async function sendAnswer(item, index) {
  if (item.kind !== "ask-user" || !item.options?.length) {
    throw fail(409, "This prompt has no options to pick here. Answer it in its pane.");
  }
  if (!Number.isSafeInteger(index) || index < 0 || index >= item.options.length) {
    throw fail(400, `Option must be a whole number from 0 to ${item.options.length - 1}.`);
  }
  if (typeof item.pane !== "string" || !/^block:[\w-]+$/.test(item.pane)) {
    throw fail(409, "This prompt has no pane to answer in.");
  }
  const live = await liveBlocks();
  if (!live) throw fail(502, "Rex did not list the panes, so the answer was not sent.");
  if (!live.some((id) => sameId(id, item.pane))) throw fail(409, "The pane of this prompt no longer exists.");
  try {
    await run("rex", ["--autostart=false", "send-key", "-b", item.pane, ...answerKeys(index)], { timeout: 10_000 });
  } catch (error) {
    const reason = String(error.stderr ?? error.message).trim().split("\n")[0];
    throw fail(502, `Rex could not send the answer: ${reason}`);
  }
}
