import { appendFile, readFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

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
