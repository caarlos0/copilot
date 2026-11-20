import { stat } from "node:fs/promises";
import { join } from "node:path";
import { measureFile } from "./session-metrics.mjs";
import { sessionID } from "./sessions.mjs";

const maxLogBytes = 512 * 1024 * 1024;
const refreshMs = 30_000;
const readers = 4;
const maxCached = 1024;

// 1 AI credit = $0.01 (docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing).
// totalNanoAiu is 1e9 per credit: the log's costPerBatch for Claude Sonnet 5.5 input is 2e11
// nano AIU per 1M tokens, which is the published $2.00 per 1M tokens.
const usdPerCredit = 0.01;
const usdOf = (credits) => credits === null ? null : Math.round(credits * usdPerCredit * 1e4) / 1e4;

// Session logs are streamed once per file change, and a log that keeps growing is not read
// again for refreshMs. Only numbers and model names leave this module. The cache serves every
// factory file, so it is capped, and the oldest entry goes first, instead of tracking references.
const cache = new Map();
export const cacheSize = () => cache.size;
const reading = new Map();

function remember(file, entry) {
  cache.delete(file);
  cache.set(file, entry);
  if (cache.size > maxCached) cache.delete(cache.keys().next().value);
}

async function readLog(file) {
  try {
    const { mtimeMs, size } = await stat(file);
    if (size > maxLogBytes) return null;
    const stamp = `${mtimeMs}-${size}`;
    const hit = cache.get(file);
    if (hit && (hit.stamp === stamp || Date.now() - hit.at < refreshMs)) return hit.usage;
    if (!reading.has(file)) {
      reading.set(file, measureFile(file).then((metrics) => {
        const { usage } = metrics;
        const credits = usage.nano_aiu > 0 ? Math.round(usage.nano_aiu / 1e7) / 100 : null;
        const value = metrics.events === 0 ? null : {
          models: usage.models,
          credits,
          usd: usdOf(credits),
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          active_minutes: metrics.wall_minutes,
        };
        remember(file, { stamp, at: Date.now(), usage: value });
        return value;
      }).finally(() => reading.delete(file)));
    }
    return await reading.get(file);
  } catch {
    return null;
  }
}

export const sessionUsage = (session, directory) => {
  const id = sessionID(session);
  return id === null ? null : readLog(join(directory, id, "events.jsonl"));
};

function total(items) {
  const found = items.filter(Boolean);
  if (!found.length) return null;
  // A partial credit sum would understate the cost, so mixed sessions fall back to tokens.
  const credited = found.every((item) => item.credits !== null);
  const credits = credited ? Math.round(found.reduce((sum, item) => sum + item.credits, 0) * 100) / 100 : null;
  return {
    models: [...new Set(found.flatMap((item) => item.models))].sort(),
    credits,
    usd: usdOf(credits),
    input_tokens: found.reduce((sum, item) => sum + item.input_tokens, 0),
    output_tokens: found.reduce((sum, item) => sum + item.output_tokens, 0),
    active_minutes: Math.round(found.reduce((sum, item) => sum + item.active_minutes, 0) * 100) / 100,
  };
}

// Per worker role usage and a task total; a missing or unreadable session is null.
// ended_at is null while the task is open, so the browser can keep counting.
export async function taskUsage(task, directory, read = sessionUsage) {
  const workers = {};
  const seen = new Map();
  for (const [role, worker] of Object.entries(task.workers)) {
    if (!worker) continue;
    const id = sessionID(worker.session);
    workers[role] = id === null ? null : await read(id, directory);
    if (id !== null) seen.set(id, workers[role]);
  }
  return {
    started_at: task.history[0].at,
    ended_at: task.state === "resolved" ? task.history.at(-1).at : null,
    workers,
    total: total([...seen.values()]),
  };
}

// Runs fn over items with at most `limit` calls in flight; results keep the order of items.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export async function factoryUsage(data, directory) {
  const ids = new Set();
  for (const task of data.tasks) {
    for (const worker of Object.values(task.workers)) {
      const id = worker && sessionID(worker.session);
      if (id) ids.add(id);
    }
  }
  const list = [...ids];
  const results = await mapLimit(list, readers, (id) => sessionUsage(id, directory));
  const measured = new Map(list.map((id, index) => [id, results[index]]));
  const read = (id) => measured.get(id);
  const usage = {};
  for (const task of data.tasks) usage[task.id] = await taskUsage(task, directory, read);
  return usage;
}
