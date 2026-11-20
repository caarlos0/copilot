import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Parsed JSON, or null when the file is missing or not valid JSON.
export async function readJSON(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const exists = (path) => {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
};

export const candidates = (home) => [
  join(home, ".local/state/copilot-factory"),
  join(home, ".local/state/copilot-coordinator"),
];

// Every existing state directory, new first. Factories created before the
// rename stay in the legacy directory, which is never moved, so a file can
// live in either one. The new directory alone is the default when neither exists.
export function stateDirectories(home = homedir()) {
  const existing = candidates(home).filter(exists);
  return existing.length ? existing : candidates(home).slice(0, 1);
}

// The new directory wins, then the legacy one. A file that exists in neither
// belongs in the new directory.
export function stateFile(name, home = homedir()) {
  const paths = candidates(home).map((directory) => join(directory, name));
  return paths.find(exists) ?? paths[0];
}
