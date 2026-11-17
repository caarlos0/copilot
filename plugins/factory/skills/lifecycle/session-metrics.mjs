import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readSessions, sessionID } from "./sessions.mjs";

const idleOver = 10 * 60_000;
const minutes = (ms) => Math.round(ms / 600) / 100;

const commandPatterns = {
  sleep: /\bsleep\s+\d/,
  gh_wait: /\bgh\s+wait\b/,
  watch: /--watch\b|\bgh\s+run\s+watch\b/,
};
const statusRead = /\bgh\s+(?:pr\s+(?:view|checks)|run\s+(?:view|list))\b/;

// Counts only: no message, command, or file content leaves this function.
async function measure(lines) {
  const tools = {};
  const calls = new Map();
  const commands = { sleep: 0, gh_wait: 0, watch: 0, status_reads: 0 };
  const usage = { cost: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, model_seconds: 0 };
  const models = new Set();
  const idle = { ms: 0, over_10_minutes: 0, longest: 0 };
  let userMessages = 0;
  let turns = 0;
  let waitingSince = null;
  let first = null;
  let last = null;
  let skipped = 0;
  let events = 0;

  const endIdle = (at) => {
    if (waitingSince === null) return;
    const gap = at - waitingSince;
    idle.ms += gap;
    idle.longest = Math.max(idle.longest, gap);
    if (gap > idleOver) idle.over_10_minutes += 1;
    waitingSince = null;
  };

  for await (const line of lines) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const at = Date.parse(event.timestamp);
    if (Number.isNaN(at)) continue;
    events += 1;
    first ??= at;
    last = at;
    const data = event.data ?? {};
    if (event.type === "user.message") {
      userMessages += 1;
      endIdle(at);
    } else if (event.type === "assistant.turn_start") {
      turns += 1;
      endIdle(at);
    } else if (event.type === "assistant.turn_end") {
      waitingSince = at;
    } else if (event.type === "tool.execution_start") {
      calls.set(data.toolCallId, data.toolName);
      tools[data.toolName] ??= { calls: 0, failures: 0 };
      tools[data.toolName].calls += 1;
      const command = data.arguments?.command;
      if (typeof command === "string") {
        for (const [name, pattern] of Object.entries(commandPatterns)) {
          if (pattern.test(command)) commands[name] += 1;
        }
        if (statusRead.test(command) && !commandPatterns.watch.test(command)) commands.status_reads += 1;
      }
    } else if (event.type === "tool.execution_complete") {
      if (data.success === false && calls.has(data.toolCallId)) tools[calls.get(data.toolCallId)].failures += 1;
    } else if (event.type === "session.usage_record" && data.usage) {
      const item = data.usage;
      usage.cost += item.cost ?? 0;
      usage.input_tokens += item.inputTokens ?? 0;
      usage.output_tokens += item.outputTokens ?? 0;
      usage.cache_read_tokens += item.cacheReadTokens ?? 0;
      usage.model_seconds += (item.duration ?? 0) / 1000;
      if (item.model) models.add(item.model);
    }
  }

  return {
    events,
    skipped_lines: skipped,
    started_at: first === null ? null : new Date(first).toISOString(),
    ended_at: last === null ? null : new Date(last).toISOString(),
    wall_minutes: first === null ? 0 : minutes(last - first),
    user_messages: userMessages,
    turns,
    idle: { minutes: minutes(idle.ms), over_10_minutes: idle.over_10_minutes, longest_minutes: minutes(idle.longest) },
    tools,
    commands,
    usage: { ...usage, model_seconds: Math.round(usage.model_seconds), models: [...models].sort() },
  };
}

function sum(sessions) {
  const total = {
    sessions: sessions.length, wall_minutes: 0, user_messages: 0, turns: 0,
    idle_minutes: 0, idle_over_10_minutes: 0,
    ask_user_calls: 0,
    commands: { sleep: 0, gh_wait: 0, watch: 0, status_reads: 0 },
    usage: { cost: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, model_seconds: 0 },
  };
  for (const item of sessions) {
    total.wall_minutes += item.wall_minutes;
    total.user_messages += item.user_messages;
    total.turns += item.turns;
    total.idle_minutes += item.idle.minutes;
    total.idle_over_10_minutes += item.idle.over_10_minutes;
    total.ask_user_calls += item.tools.ask_user?.calls ?? 0;
    for (const key of Object.keys(total.commands)) total.commands[key] += item.commands[key];
    for (const key of Object.keys(total.usage)) total.usage[key] += item.usage[key];
  }
  for (const key of ["wall_minutes", "idle_minutes"]) total[key] = minutes(total[key] * 60_000);
  return total;
}

export async function report(entries, directory) {
  const sessions = [];
  const missing = [];
  for (const entry of entries) {
    const input = createReadStream(join(directory, entry.id, "events.jsonl"), "utf8");
    try {
      const metrics = await measure(createInterface({ input, crlfDelay: Infinity }));
      sessions.push({ id: entry.id, role: entry.role, task: entry.task, rule: entry.rule, ...metrics });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing.push(entry.id);
    }
  }
  return { totals: sum(sessions), missing, sessions };
}

async function main() {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      options: {
        help: { type: "boolean", short: "h" },
        registry: { type: "string" },
        since: { type: "string" },
        directory: { type: "string", default: join(homedir(), ".copilot", "session-state") },
      },
      allowPositionals: true,
    }));
    if (values.help) {
      console.log(`Measure Copilot sessions without reading their content.

Usage: node session-metrics.mjs --registry FILE [--since ISO] [--directory DIR]
       node session-metrics.mjs [--directory DIR] SESSION_UUID...

FILE is the <owner.repo>-factory-sessions.jsonl registry that factory.mjs keeps beside the
factory file. --since keeps sessions registered at or after that time, and always keeps the
long-lived factory session (role factory), whose totals are cumulative. DIR defaults to
~/.copilot/session-state. Prints JSON: totals, missing session IDs, and per-session wall
minutes, model seconds, user messages, turns, idle time (turn end to the next user message or turn),
tool call and failure counts, wait/watch command counts, and usage. Tool run times are not
reported: the event log does not record them reliably.
Exit: 0 success, 1 I/O or invalid registry, 2 usage.`);
      return;
    }
    if (values.registry === undefined && !positionals.length) throw new Error("Pass --registry FILE or session IDs.");
    if (values.registry !== undefined && positionals.length) throw new Error("Pass --registry or session IDs, not both.");
    if (values.since !== undefined && Number.isNaN(Date.parse(values.since))) throw new Error("--since must be an ISO 8601 time.");
    for (const id of positionals) {
      if (sessionID(id) !== id) throw new Error(`Not a session UUID: ${id}`);
    }
  } catch (error) {
    console.error(`${error.message}\nRun with --help for usage.`);
    process.exitCode = 2;
    return;
  }
  try {
    const entries = values.registry === undefined
      ? positionals.map((id) => ({ id }))
      : (await readSessions(resolve(values.registry)))
        .filter((entry) => values.since === undefined || entry.role === "factory" || Date.parse(entry.at) >= Date.parse(values.since));
    console.log(JSON.stringify(await report(entries, resolve(values.directory)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
