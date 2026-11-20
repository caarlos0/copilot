import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { archiveFormat, githubResourceURL, validateArchive } from "./factory-data.mjs";

const dayFile = /^\d{4}-\d{2}-\d{2}\.json$/;

export const archiveDirectory = (file) =>
  join(dirname(file), `${basename(file, extname(file))}-archive`);

const dayOf = (task) => new Date(task.updated_at).toISOString().slice(0, 10);

async function writeDay(directory, data) {
  const file = join(directory, `${data.day}.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readArchive(directory, project) {
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const days = [];
  for (const name of names.filter((item) => dayFile.test(item)).sort()) {
    const file = join(directory, name);
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      validateArchive(data, project, name.slice(0, 10));
      days.push(data);
    } catch (error) {
      throw new Error(`${file}: ${error.message}`);
    }
  }
  return days;
}

// Newest copy of each task whose id, issue, or PR matches; stale copies lose.
export function findArchived(days, { id, issue, pr }) {
  const newest = new Map();
  for (const { day, tasks } of days) {
    for (const task of tasks) {
      if (task.id !== id &&
          !(issue && task.issue && githubResourceURL(task.issue) === githubResourceURL(issue)) &&
          !(pr && task.pr && githubResourceURL(task.pr) === githubResourceURL(pr))) continue;
      const known = newest.get(task.id);
      if (!known || Date.parse(task.updated_at) >= Date.parse(known.task.updated_at)) {
        newest.set(task.id, { task, day });
      }
    }
  }
  return [...newest.values()];
}

// Upserts by task ID, so a retried write cannot duplicate a task.
export async function saveArchive(directory, project, tasks) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = new Map((await readArchive(directory, project)).map((data) => [data.day, data]));
  const changed = new Map();
  for (const task of tasks) {
    const day = dayOf(task);
    const data = changed.get(day) ?? existing.get(day) ??
      { format: archiveFormat, project, day, tasks: [] };
    data.tasks = [...data.tasks.filter((item) => item.id !== task.id), task];
    changed.set(day, data);
  }
  for (const data of changed.values()) await writeDay(directory, data);
}

export async function removeArchived(directory, project, id) {
  for (const data of await readArchive(directory, project)) {
    if (!data.tasks.some((task) => task.id === id)) continue;
    data.tasks = data.tasks.filter((task) => task.id !== id);
    if (data.tasks.length) await writeDay(directory, data);
    else await rm(join(directory, `${data.day}.json`));
  }
}

const day = 86_400_000;
const hour = 3_600_000;
const largeFile = 100 * 1024 * 1024;
const workerRoles = ["investigation", "implementation", "review"];
const usage = "Usage: node archive.mjs clean FACTORY_FILE [--older-than 14d] [--run]";

function parseAge(value) {
  const match = /^(\d+)([dh])$/.exec(value);
  if (!match) throw new Error(`--older-than must look like 14d or 36h, got "${value}".`);
  return Number(match[1]) * (match[2] === "d" ? day : hour);
}

const pendingFeedback = (task) => task.feedback && task.feedback.acknowledged_id !== task.feedback.id;

// Lists the per-task artifacts of tasks resolved longer than `olderThan` ago
// and, with `run`, deletes them. Large unreferenced files are only reported.
export async function clean(file, { olderThan = 14 * day, run = false, now = Date.now() } = {}) {
  const directory = dirname(file);
  const current = JSON.parse(await readFile(file, "utf8"));
  const project = basename(file, extname(file)).replace(/-factory$/, "");
  const archived = (await readArchive(archiveDirectory(file), current.project)).flatMap((data) => data.tasks);
  const live = new Set(current.tasks.map((task) => task.id));
  const resolved = [...current.tasks, ...archived.filter((task) => !live.has(task.id))]
    .filter((task) => task.state === "resolved");
  const expired = resolved.filter((task) => Date.parse(task.updated_at) < now - olderThan && !pendingFeedback(task));
  const open = JSON.stringify(current.tasks.filter((task) => task.state !== "resolved" || pendingFeedback(task)));

  const entries = await readdir(directory, { withFileTypes: true });
  const roles = workerRoles.join("|");
  const files = new RegExp(`^(${roles})-(brief|result)([.-].*)?\\.(md|json)$`);
  const dirs = new RegExp(`^(${roles})-instructions$`);
  const prefixes = new Map(expired.map((task) => [`${project}-${task.id}-`, task.id]));
  const artifacts = new Map();
  for (const entry of entries) {
    const pattern = entry.isFile() ? files : entry.isDirectory() ? dirs : null;
    if (!pattern) continue;
    for (let at = entry.name.indexOf("-"); at !== -1; at = entry.name.indexOf("-", at + 1)) {
      const task = prefixes.get(entry.name.slice(0, at + 1));
      if (task !== undefined && pattern.test(entry.name.slice(at + 1))) artifacts.set(entry.name, task);
    }
  }

  const remove = [];
  const kept = [];
  for (const [name, task] of artifacts) {
    const path = join(directory, name);
    const reason = open.includes(name) ? "referenced by an open task"
      : now - (await stat(path)).mtimeMs < day ? "modified in the last 24 hours" : null;
    if (reason) kept.push({ path, task, reason });
    else remove.push({ path, task });
  }

  const factories = entries.filter((entry) => entry.isFile() && entry.name.endsWith("-factory.json")).map((entry) => entry.name);
  const references = (await Promise.all(factories.map((name) => readFile(join(directory, name), "utf8")))).join("\n");
  const large = [];
  for (const entry of entries) {
    if (!entry.isFile() || factories.includes(entry.name)) continue;
    const info = await stat(join(directory, entry.name));
    if (info.size > largeFile && now - info.mtimeMs >= day && !references.includes(entry.name)) {
      large.push({ path: join(directory, entry.name), size: info.size });
    }
  }

  if (run) for (const { path } of remove) await rm(path, { recursive: true, force: true });
  return { run, tasks: [...new Set(remove.map((item) => item.task))], delete: remove, kept, "stale-large": large };
}

async function main() {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: { "older-than": { type: "string", default: "14d" }, run: { type: "boolean", default: false } },
    });
    if (positionals.length !== 2 || positionals[0] !== "clean") throw new Error(usage);
    const result = await clean(resolve(positionals[1]), { olderThan: parseAge(values["older-than"]), run: values.run });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.message === usage ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
