import { execFile } from "node:child_process";
import { type FileHandle, open, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { emit, eventsFile, resolveFactory } from "./broker.ts";
import { readJSON } from "./state-dir.ts";

type LogEvent = { type?: string; timestamp: string; data?: { toolName?: string; toolCallId?: string } };
type AttentionEvent = {
  id: string;
  at: string;
  type: string;
  task?: string;
  data: {
    session: string;
    kind: string;
    text: string;
    task?: string;
    role?: string | null;
    pane?: string | null;
    options?: string[];
  };
};
export type AttentionItem = {
  id: string;
  at: string;
  session: string;
  task: string | null;
  role: string | null;
  kind: string;
  text: string;
  options: string[];
  pane: string | null;
  title: string | null;
  rex_session?: string;
};
type ScanOptions = { now?: number; panes?: string[] | null };
type Block = { id: string; session: string | null };

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

const run = promisify(execFile);
const tailBytes = 256 * 1024;
const maxTailBytes = 64 * 1024 * 1024;
const lookBackMs = 60_000;
const expireMs = 24 * 3_600_000;

// Rex may record short IDs; a short ID is the tail of the full one.
const bare = (id: string) => id.replace(/^\w+:/, "");
export const sameId = (a: string, b: string) => bare(a).endsWith(bare(b)) || bare(b).endsWith(bare(a));

const sessionState = () => process.env.FACTORY_SESSION_STATE ?? join(homedir(), ".copilot", "session-state");

// Session logs reach 500 MB, so read the last bytes only. A busy session writes more than one
// tail after a prompt (tool output, streaming), so the tail grows until it reaches an event
// from before `since`, the start of the log, or the cap. The first line of a tail is cut.
async function tailEvents(file: string, since: number) {
  let handle: FileHandle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
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
      const events: LogEvent[] = [];
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // A blank or partial line.
        }
      }
      const oldest = events.map(({ timestamp }) => Date.parse(timestamp)).find(Number.isFinite);
      if (start === 0 || bytes >= maxTailBytes || (oldest !== undefined && oldest < since - lookBackMs)) return events;
    }
  } finally {
    await handle.close();
  }
}

// The last event of a session log, from its last 256 KiB, or null when there is none.
export async function lastEvent(session: string) {
  if (!/^[\w-]+$/.test(session)) return null;
  const events = await tailEvents(join(sessionState(), session, "events.jsonl"), Date.now());
  const event = events.at(-1);
  return event ? { type: event.type, at: Date.parse(event.timestamp) } : null;
}

// Times of the events that show a prompt was answered: a completed permission, or the end of
// an ask_user call. The completion has no tool name, so match it to its start by tool call ID.
async function answerTimes(session: string, since: number) {
  if (!/^[\w-]+$/.test(session)) return [];
  const events = await tailEvents(join(sessionState(), session, "events.jsonl"), since);
  const askUser = new Set(events
    .filter(({ type, data }) => type === "tool.execution_start" && data?.toolName === "ask_user")
    .map(({ data }) => data?.toolCallId));
  return events
    .filter(({ type, data }) => type === "permission.completed" || (type === "tool.execution_complete" && askUser.has(data?.toolCallId)))
    .map(({ timestamp }) => Date.parse(timestamp))
    .filter(Number.isFinite);
}

// A string that changes when the events log or the log of one of `sessions` changes size or time,
// so a caller can reuse a scan while it stays the same.
export async function scanStamp(file: string, sessions: string[] = []) {
  const paths = [eventsFile(file), ...sessions.filter((session) => /^[\w-]+$/.test(session))
    .map((session) => join(sessionState(), session, "events.jsonl"))];
  return (await Promise.all(paths.map(async (path) => {
    try {
      const { size, mtimeMs } = await stat(path);
      return `${size}:${mtimeMs}`;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return "none";
      throw error;
    }
  }))).join(",");
}

const rexLines = async (prefix: string, args: string[]) => {
  const { stdout } = await run("rex", ["--autostart=false", ...args], { timeout: 10_000 });
  return stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith(prefix));
};

// Live blocks as `{ id, session }`, or null when Rex cannot tell. Rex resolves a block ID only in
// one session (`$REX_SESSION`, else the default one), so `block ls -A` lists panes that `send-key -b`
// and `focus` then call "not found". Ask each session for its own blocks to learn where a pane
// lives. An empty answer is a Rex glitch, never "no panes".
async function liveBlocks(): Promise<{ id: string; session: string }[] | null> {
  try {
    const sessions = await rexLines("session:", ["ls", "-q", "--short=false"]);
    const blocks = (await Promise.all(sessions.map(async (session) =>
      (await rexLines("block:", ["block", "ls", "-s", session, "-q", "--short=false"])).map((id) => ({ id, session }))))).flat();
    return blocks.length > 0 ? blocks : null;
  } catch {
    return null;
  }
}

// Reads the factory events log and sorts every attention.requested that no attention.resolved
// followed into open and resolved. An open item is one whose session shows no answer, whose pane
// is still live, and that is under 24 hours old. `resolved` lists the items closed by those
// signals, with the reason, so the caller can record the missing attention.resolved event.
// `panes` replaces the Rex query: an array of live block IDs, or null to skip the check. An open
// item carries `rex_session`, the Rex session that holds its pane, when Rex told.
export async function scanAttention(
  file: string,
  { now = Date.now(), panes }: ScanOptions = {},
): Promise<{ open: AttentionItem[]; resolved: { item: AttentionItem; reason: string }[] }> {
  let text: string;
  try {
    text = await readFile(eventsFile(file), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { open: [], resolved: [] };
    throw error;
  }
  const requests = new Map<string, AttentionEvent>();
  for (const line of text.split("\n")) {
    // Most lines are task events, so skip the parse for them.
    if (!line.includes('"attention.')) continue;
    let event: AttentionEvent;
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

  const titles = new Map<string | null, string>((await readJSON(file))?.tasks?.map((task: { id: string; title: string }) => [task.id, task.title]));
  const firstAsked = new Map<string, number>();
  for (const { at, data } of requests.values()) {
    firstAsked.set(data.session, Math.min(firstAsked.get(data.session) ?? Infinity, Date.parse(at)));
  }
  const answers = new Map<string, number[]>();
  let live: Block[] | null | undefined = panes ? panes.map((id) => ({ id, session: null })) : panes;
  const open: AttentionItem[] = [];
  const resolved: { item: AttentionItem; reason: string }[] = [];
  for (const event of requests.values()) {
    const { session, kind, text: message, role = null, pane = null, options = [] } = event.data;
    const task = event.task ?? event.data.task ?? null;
    const item: AttentionItem = { id: event.id, at: event.at, session, task, role, kind, text: message, options, pane, title: titles.get(task) ?? null };
    const at = Date.parse(event.at);
    if (!answers.has(session)) answers.set(session, await answerTimes(session, firstAsked.get(session)!));

    let reason: string | null = null;
    if (answers.get(session)!.some((time) => time > at)) reason = "answered";
    else if (now - at > expireMs) reason = "expired";
    else if (pane) {
      if (live === undefined) live = await liveBlocks();
      const block = live?.find(({ id }) => sameId(id, pane));
      if (live && !block) reason = "pane-gone";
      else if (block?.session) item.rex_session = block.session;
    }
    if (reason) resolved.push({ item, reason });
    else open.push(item);
  }
  return { open, resolved };
}

export async function openAttention(file: string, options?: ScanOptions) {
  return (await scanAttention(file, options)).open;
}

// Scans, then records an attention.resolved event for each session whose items closed by a
// signal, so every reader sees them closed. One event closes every request of its session, so
// a session with a newer open request waits. Returns the scan.
export async function resolveAttention(file: string, { source, ...options }: ScanOptions & { source: string }) {
  const scan = await scanAttention(file, options);
  const waiting = new Set(scan.open.map((item) => item.session));
  const recorded = new Set<string>();
  for (const { item, reason } of scan.resolved) {
    if (waiting.has(item.session) || recorded.has(item.session)) continue;
    recorded.add(item.session);
    await emit(await resolveFactory(file), { type: "attention.resolved", source, data: { session: item.session, reason } });
  }
  return scan;
}

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

// The keys that pick option `index` of an ask_user form with one enum field. It has no number
// keys: Down moves the highlight from the first option and Enter submits the form.
const answerKeys = (index: number) => [...Array(index).fill("down"), "enter"];

// Types the user's click into the item's pane. The caller has checked that the item is pending.
// Rex gets an argument array and no shell; the pane must be a plain block ID that Rex still lists.
// Permission prompts name no options, so nothing is sent to them.
export async function sendAnswer(item: { kind?: string; options?: string[]; pane?: unknown }, index: number) {
  if (item.kind !== "ask-user" || !item.options?.length) {
    throw fail(409, "This prompt has no options to pick here. Answer it in its pane.");
  }
  if (!Number.isSafeInteger(index) || index < 0 || index >= item.options.length) {
    throw fail(400, `Option must be a whole number from 0 to ${item.options.length - 1}.`);
  }
  const { pane } = item;
  if (typeof pane !== "string" || !/^block:[\w-]+$/.test(pane)) {
    throw fail(409, "This prompt has no pane to answer in.");
  }
  const live = await liveBlocks();
  if (!live) throw fail(502, "Rex did not list the panes, so the answer was not sent.");
  const block = live.find(({ id }) => sameId(id, pane));
  if (!block) throw fail(409, "The pane of this prompt no longer exists, so it was not answered.");
  try {
    await run("rex", ["--autostart=false", "send-key", "-s", block.session, "-b", block.id, ...answerKeys(index)], { timeout: 10_000 });
  } catch (error) {
    const { stderr, message } = error as { stderr?: unknown; message: string };
    const reason = String(stderr ?? message).trim().split("\n")[0];
    throw fail(502, `Rex could not send the answer: ${reason}`);
  }
}
