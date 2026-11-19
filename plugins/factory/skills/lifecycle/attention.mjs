import { execFileSync } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { eventsFile } from "./broker.mjs";

const tailBytes = 256 * 1024;
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

// Session logs reach 500 MB, so read the last bytes only. The first line of a tail is cut.
async function tailEvents(file) {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - tailBytes);
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
    return events;
  } finally {
    await handle.close();
  }
}

// Times of the events that show a prompt was answered: a completed permission, or the end of
// an ask_user call. The completion has no tool name, so match it to its start by tool call ID.
async function answerTimes(session) {
  if (!/^[\w-]+$/.test(session)) return [];
  const events = await tailEvents(join(sessionState(), session, "events.jsonl"));
  const askUser = new Set(events
    .filter(({ type, data }) => type === "tool.execution_start" && data?.toolName === "ask_user")
    .map(({ data }) => data.toolCallId));
  return events
    .filter(({ type, data }) => type === "permission.completed" || (type === "tool.execution_complete" && askUser.has(data?.toolCallId)))
    .map(({ timestamp }) => Date.parse(timestamp))
    .filter(Number.isFinite);
}

// Block IDs in the live Rex server, or null when Rex cannot tell.
function liveBlocks() {
  try {
    const { blocks } = JSON.parse(execFileSync("rex", ["block", "ls", "-A", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }));
    return Array.isArray(blocks) ? blocks.map((block) => block.block_id) : null;
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
    if (event.type === "attention.requested") requests.set(event.id, event);
    else if (event.type === "attention.resolved") {
      for (const [id, request] of requests) if (request.data.session === session) requests.delete(id);
    }
  }
  if (requests.size === 0) return { open: [], resolved: [] };

  const titles = new Map((await readJSON(file))?.tasks?.map((task) => [task.id, task.title]));
  const answers = new Map();
  let live = panes;
  const open = [];
  const resolved = [];
  for (const event of requests.values()) {
    const { session, kind, text: message, role = null, pane = null, options = [] } = event.data;
    const task = event.task ?? event.data.task ?? null;
    const item = { id: event.id, at: event.at, session, task, role, kind, text: message, options, pane, title: titles.get(task) ?? null };
    const at = Date.parse(event.at);
    if (!answers.has(session)) answers.set(session, await answerTimes(session));

    let reason = null;
    if (answers.get(session).some((time) => time > at)) reason = "answered";
    else if (now - at > expireMs) reason = "expired";
    else if (pane) {
      if (live === undefined) live = liveBlocks();
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
