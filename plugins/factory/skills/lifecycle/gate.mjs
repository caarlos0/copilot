import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { stateFile } from "./state-dir.mjs";

// Decides whether the coordinator hooks apply to a session. The owner lock
// (`<project>-factory.lock`) records the coordinator's Copilot session, and the
// hook payload carries the same `sessionId`, so no launcher has to set a variable.
// FACTORY_COORDINATOR=1 forces the hooks on and =0 forces them off.

// "<owner.repo>-factory.json" from FACTORY_FILE, else from the origin remote of cwd.
export function factoryFile(cwd, env = process.env) {
  if (env.FACTORY_FILE) return env.FACTORY_FILE;
  const remote = spawnSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 5000 });
  const match = remote.status === 0 && remote.stdout.trim().match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return match ? stateFile(`${match[1]}.${match[2]}-factory.json`) : null;
}

export const lockPath = (file) => join(dirname(file), `${basename(file, ".json")}.lock`);

const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

// The Copilot session the lock records, or null. `owner.json` is the format the
// lifecycle skill writes; `owner` is the older "session ID pane ID" text.
export function lockSession(lock) {
  try {
    const session = JSON.parse(read(join(lock, "owner.json")) ?? "null")?.copilot_session;
    if (typeof session === "string" && session) return session;
  } catch {}
  return read(join(lock, "owner"))?.match(/\bsession\s+([\w-]+)/)?.[1] ?? null;
}

export const hookSession = (input) => input?.sessionId ?? input?.session_id ?? null;

export function ownsLock(file, sessionId) {
  return Boolean(file && sessionId && lockSession(lockPath(file)) === sessionId);
}

export function isCoordinator(input, env = process.env) {
  if (env.FACTORY_COORDINATOR === "0") return false;
  if (env.FACTORY_COORDINATOR === "1") return true;
  const sessionId = hookSession(input);
  return sessionId !== null && ownsLock(factoryFile(input.cwd ?? process.cwd(), env), sessionId);
}

// Why the hooks would not run for the session that runs the caller, or null.
// Only a factory with an owner lock can report this. COPILOT_AGENT_SESSION_ID is
// the caller's session in the agent's shell.
export function hooksInactive(file, env = process.env) {
  const lock = lockPath(file);
  if (!read(join(lock, "owner.json")) && !read(join(lock, "owner"))) return null;
  if (env.FACTORY_COORDINATOR === "0") return "FACTORY_COORDINATOR=0 turns the hooks off";
  if (env.FACTORY_COORDINATOR === "1") return null;
  const owner = lockSession(lock);
  if (!owner) return `${lock} records no Copilot session; write owner.json with copilot_session`;
  const session = env.COPILOT_AGENT_SESSION_ID;
  return session && session !== owner ? `${lock} records session ${owner}, not this session ${session}` : null;
}
