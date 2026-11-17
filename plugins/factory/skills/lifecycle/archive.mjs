import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
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
