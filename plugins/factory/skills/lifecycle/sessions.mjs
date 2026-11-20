import { appendFile, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

const sessionRoles = ["factory", "investigation", "implementation", "review", "producer", "improver"];

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export const registryFile = (file) =>
  join(dirname(file), `${basename(file, extname(file))}-sessions.jsonl`);

// Worker records can hold a prefixed value such as "session:<uuid>".
export const sessionID = (value) =>
  (typeof value === "string" ? value.match(uuid)?.[0].toLowerCase() : null) ?? null;

function entry(line, file, number) {
  let item;
  try {
    item = JSON.parse(line);
  } catch {
    throw new Error(`${file} line ${number} is not valid JSON.`);
  }
  if (item === null || typeof item !== "object" || sessionID(item.id) !== item.id ||
      !sessionRoles.includes(item.role) || Number.isNaN(Date.parse(item.at))) {
    throw new Error(`${file} line ${number} is not a session entry {id, role, at}.`);
  }
  return item;
}

export async function readSessions(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return text.split("\n").flatMap((line, index) => (line ? [entry(line, file, index + 1)] : []));
}

// Appends unseen IDs only. Call it under the factory write lock.
export async function recordSessions(file, entries) {
  if (!entries.length) return;
  const known = new Set((await readSessions(file)).map((item) => item.id));
  const fresh = entries.filter((item) => !known.has(item.id) && known.add(item.id));
  if (fresh.length) {
    await appendFile(file, fresh.map((item) => `${JSON.stringify(item)}\n`).join(""), { mode: 0o600 });
  }
}

export const sessionStateDirectory = () =>
  process.env.FACTORY_SESSION_STATE ?? join(homedir(), ".copilot", "session-state");

const real = (path) => realpath(path).catch(() => resolve(path));

// The Copilot sessions started in cwd at or after `since`.
export async function findSessions(directory, cwd, since) {
  const from = Date.parse(since);
  const names = await readdir(directory).catch(() => []);
  const wanted = await real(cwd);
  const found = [];
  await Promise.all(names.filter((name) => sessionID(name) === name).map(async (name) => {
    try {
      // A session folder is modified at least once after it is created.
      if ((await stat(join(directory, name))).mtimeMs < from) return;
      const yaml = await readFile(join(directory, name, "workspace.yaml"), "utf8");
      const field = (key) => yaml.match(new RegExp(`^${key}: *["']?(.+?)["']?$`, "m"))?.[1];
      if (!(Date.parse(field("created_at")) >= from) || !field("cwd")) return;
      if (await real(field("cwd")) === wanted) found.push(name);
    } catch {
      // An unreadable folder is not a match; the lookup never fails a write.
    }
  }));
  return found;
}
