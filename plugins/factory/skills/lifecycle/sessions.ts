import { appendFile, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

const sessionRoles = ["factory", "investigation", "implementation", "review", "producer", "improver"];

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export type SessionEntry = { id: string; role: string; at: string; task?: string; rule?: string };

export const registryFile = (file: string) =>
  join(dirname(file), `${basename(file, extname(file))}-sessions.jsonl`);

// Worker records can hold a prefixed value such as "session:<uuid>".
export const sessionID = (value: unknown): string | null =>
  (typeof value === "string" ? value.match(uuid)?.[0].toLowerCase() : null) ?? null;

function entry(line: string, file: string, number: number): SessionEntry {
  let item: SessionEntry;
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

export async function readSessions(file: string): Promise<SessionEntry[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text.split("\n").flatMap((line, index) => (line ? [entry(line, file, index + 1)] : []));
}

// Appends unseen IDs only. Call it under the factory write lock.
export async function recordSessions(file: string, entries: SessionEntry[]) {
  if (!entries.length) return;
  const known = new Set((await readSessions(file)).map((item) => item.id));
  const fresh = entries.filter((item) => !known.has(item.id) && known.add(item.id));
  if (fresh.length) {
    await appendFile(file, fresh.map((item) => `${JSON.stringify(item)}\n`).join(""), { mode: 0o600 });
  }
}

export const sessionStateDirectory = () =>
  process.env.FACTORY_SESSION_STATE ?? join(homedir(), ".copilot", "session-state");

const real = (path: string) => realpath(path).catch(() => resolve(path));

export type SessionMeta = {
  id: string;
  cwd: string;
  realCwd: string;
  repository?: string;
  name?: string;
  createdAt: number;
};

export type SessionTarget = {
  key: string;
  role: string;
  owner: { task?: string; rule?: string };
  cwds: string[];
  project?: string;
  name?: string;
  since: number;
  until?: number;
  frozen?: boolean;
};

export type SessionMatch = { session?: string; ambiguous?: true };

const maxCachedDirectories = 16;
const upperBoundSlackMs = 60_000;

type DirectoryCache = {
  at: number;
  dirMtimeMs: number;
  coveredSinceMs: number;
  sessions: Map<string, { folderMtimeMs: number; yamlMtimeMs: number; meta: SessionMeta }>;
  pending: Map<string, { folderMtimeMs: number; yamlMtimeMs: number | null }>;
};

const directoryCache = new Map<string, DirectoryCache>();

// Decodes the single-line YAML scalar forms written in workspace.yaml.
// Malformed quotes or block/flow indicators return undefined instead of guessing.
export function yamlField(yaml: string, key: string): string | undefined {
  const match = yaml.match(new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, "m"));
  if (!match) return undefined;
  const raw = match[1].replace(/\r$/, "");
  if (!raw) return undefined;
  if (raw.startsWith("'")) {
    if (raw.length < 2 || !raw.endsWith("'")) return undefined;
    const inner = raw.slice(1, -1);
    if (!inner || inner.replace(/''/g, "").includes("'")) return undefined;
    return inner.replace(/''/g, "'");
  }
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return undefined;
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "string" && parsed ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (/^[|>[{&*!]/.test(raw)) return undefined;
  return raw;
}

async function readWorkspace(directory: string, id: string, folderMtimeMs: number, previous?: { folderMtimeMs: number; yamlMtimeMs: number; meta: SessionMeta }) {
  const yamlPath = join(directory, id, "workspace.yaml");
  const yamlStat = await stat(yamlPath);
  if (previous && previous.folderMtimeMs === folderMtimeMs && previous.yamlMtimeMs === yamlStat.mtimeMs) {
    return previous;
  }
  const yaml = await readFile(yamlPath, "utf8");
  const sessionCwd = yamlField(yaml, "cwd");
  const createdAt = Date.parse(yamlField(yaml, "created_at") ?? "");
  if (!sessionCwd || Number.isNaN(createdAt)) return { folderMtimeMs, yamlMtimeMs: yamlStat.mtimeMs, meta: null };
  const meta: SessionMeta = {
    id,
    cwd: sessionCwd,
    realCwd: await real(sessionCwd),
    repository: yamlField(yaml, "repository"),
    name: yamlField(yaml, "name"),
    createdAt,
  };
  return { folderMtimeMs, yamlMtimeMs: yamlStat.mtimeMs, meta };
}

async function pendingChanged(directory: string, pending: Map<string, { folderMtimeMs: number; yamlMtimeMs: number | null }>) {
  if (!pending.size) return false;
  const checks = await Promise.all([...pending.entries()].map(async ([id, seen]) => {
    try {
      if ((await stat(join(directory, id))).mtimeMs !== seen.folderMtimeMs) return true;
    } catch {
      return true;
    }
    try {
      const yamlMtimeMs = (await stat(join(directory, id, "workspace.yaml"))).mtimeMs;
      return seen.yamlMtimeMs === null || yamlMtimeMs !== seen.yamlMtimeMs;
    } catch {
      return seen.yamlMtimeMs !== null;
    }
  }));
  return checks.some(Boolean);
}

// Lists Copilot sessions created at or after sinceMs. Reuses parsed workspace.yaml
// entries when unchanged, and caches full sweeps only when cacheMs > 0.
export async function listSessions(directory: string, sinceMs: number, options?: { cacheMs?: number }): Promise<SessionMeta[]> {
  if (Number.isNaN(sinceMs)) return [];
  const cacheMs = options?.cacheMs ?? 0;
  let dirMtimeMs: number;
  try {
    dirMtimeMs = (await stat(directory)).mtimeMs;
  } catch {
    directoryCache.delete(directory);
    return [];
  }
  const hit = directoryCache.get(directory);
  if (hit && cacheMs > 0 && Date.now() - hit.at < cacheMs &&
      hit.dirMtimeMs === dirMtimeMs && hit.coveredSinceMs <= sinceMs &&
      !(await pendingChanged(directory, hit.pending))) {
    return [...hit.sessions.values()].map((item) => item.meta).filter((item) => item.createdAt >= sinceMs);
  }
  const entry: DirectoryCache = hit ?? {
    at: 0,
    dirMtimeMs,
    coveredSinceMs: sinceMs,
    sessions: new Map(),
    pending: new Map(),
  };
  const names = await readdir(directory).catch(() => []);
  const ids = names.filter((name) => sessionID(name) === name);
  const present = new Set(ids);
  for (const id of entry.sessions.keys()) {
    if (!present.has(id)) entry.sessions.delete(id);
  }
  for (const id of entry.pending.keys()) {
    if (!present.has(id)) entry.pending.delete(id);
  }
  await Promise.all(ids.map(async (id) => {
    try {
      const folderMtimeMs = (await stat(join(directory, id))).mtimeMs;
      if (folderMtimeMs < sinceMs) return;
      const loaded = await readWorkspace(directory, id, folderMtimeMs, entry.sessions.get(id));
      if (loaded.meta) {
        entry.sessions.set(id, { folderMtimeMs: loaded.folderMtimeMs, yamlMtimeMs: loaded.yamlMtimeMs, meta: loaded.meta });
        entry.pending.delete(id);
      } else {
        entry.sessions.delete(id);
        entry.pending.set(id, { folderMtimeMs, yamlMtimeMs: loaded.yamlMtimeMs });
      }
    } catch {
      // A folder whose workspace.yaml has not been written yet stays pending for the next check.
      try {
        const folderMtimeMs = (await stat(join(directory, id))).mtimeMs;
        if (folderMtimeMs >= sinceMs) entry.pending.set(id, { folderMtimeMs, yamlMtimeMs: null });
      } catch {
        entry.pending.delete(id);
      }
      entry.sessions.delete(id);
    }
  }));
  entry.at = Date.now();
  entry.dirMtimeMs = dirMtimeMs;
  entry.coveredSinceMs = Math.min(entry.coveredSinceMs, sinceMs);
  directoryCache.delete(directory);
  directoryCache.set(directory, entry);
  if (directoryCache.size > maxCachedDirectories) {
    directoryCache.delete(directoryCache.keys().next().value as string);
  }
  return [...entry.sessions.values()].map((item) => item.meta).filter((item) => item.createdAt >= sinceMs);
}

// Trusted working directories for a task worker role.
export function workerCwds(role: string, worktreePath: string | null | undefined, fallbackCwd?: string): string[] {
  if (role === "investigation") return fallbackCwd ? [fallbackCwd] : [];
  if (role === "review") return [...(worktreePath ? [worktreePath] : []), ...(fallbackCwd ? [fallbackCwd] : [])];
  if (worktreePath) return [worktreePath];
  return fallbackCwd ? [fallbackCwd] : [];
}

// Upper time bound for a closed worker:
// - undefined when the worker is not closed (no upper bound)
// - a finite timestamp (with slack) from closed_at or the next history transition
// - null when closed without a stable boundary (caller should decline inference)
export function workerUpperBound(
  status: string | undefined,
  closedAt: string | undefined,
  role: string,
  history: readonly { state?: string; at: string }[],
  sinceMs: number,
): number | null | undefined {
  if (status !== "closed") return undefined;
  const closedMs = closedAt ? Date.parse(closedAt) : Number.NaN;
  if (Number.isFinite(closedMs) && closedMs >= sinceMs) return closedMs + upperBoundSlackMs;
  let step = -1;
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index].state === role) {
      step = index;
      break;
    }
  }
  const nextAt = step >= 0 && step + 1 < history.length ? Date.parse(history[step + 1].at) : Number.NaN;
  if (Number.isFinite(nextAt) && nextAt >= sinceMs) return nextAt + upperBoundSlackMs;
  return null;
}

// Matches unresolved workers to sessions without guessing:
// - Every claimed or previously recorded registry session is excluded.
// - Named workers require an exact session name plus either a trusted cwd or matching repository.
// - Unnamed workers require a trusted cwd and never take a session claimed by an exact-name target.
// - Frozen (already-ambiguous) targets keep protecting their candidates without receiving a new match.
// - A session matched by more than one target is ambiguous for every claimant (order-independent).
export function matchSessions(
  sessions: readonly SessionMeta[],
  targets: readonly SessionTarget[],
  options?: { claimed?: ReadonlySet<string>; registry?: readonly SessionEntry[] },
): Map<string, SessionMatch> {
  const excluded = new Set<string>(options?.claimed);
  for (const item of options?.registry ?? []) excluded.add(item.id);
  const candidates = new Map<string, SessionMeta[]>();
  const namedClaimants = new Set<string>();
  for (const target of targets) {
    const cwds = new Set(target.cwds);
    const project = target.project?.toLowerCase();
    const list = sessions.filter((session) => {
      if (excluded.has(session.id)) return false;
      if (session.createdAt < target.since) return false;
      if (target.until !== undefined && session.createdAt > target.until) return false;
      const repo = session.repository?.toLowerCase();
      if (project && repo && repo !== project) return false;
      const cwdMatch = cwds.size > 0 && cwds.has(session.realCwd);
      const projectMatch = Boolean(project && repo && repo === project);
      if (target.name) return session.name === target.name && (cwdMatch || projectMatch);
      return cwdMatch;
    });
    candidates.set(target.key, list);
    if (target.name) {
      for (const session of list) namedClaimants.add(session.id);
    }
  }
  // Unnamed targets cannot compete for a session that an exact-name target already matches.
  for (const target of targets) {
    if (target.name) continue;
    const list = candidates.get(target.key) ?? [];
    candidates.set(target.key, list.filter((session) => !namedClaimants.has(session.id)));
  }
  const claimants = new Map<string, number>();
  for (const list of candidates.values()) {
    for (const session of list) claimants.set(session.id, (claimants.get(session.id) ?? 0) + 1);
  }
  const results = new Map<string, SessionMatch>();
  for (const target of targets) {
    if (target.frozen) {
      results.set(target.key, { ambiguous: true });
      continue;
    }
    const list = candidates.get(target.key) ?? [];
    if (list.length === 1 && claimants.get(list[0].id) === 1) {
      results.set(target.key, { session: list[0].id });
    } else if (list.length > 0) {
      results.set(target.key, { ambiguous: true });
    } else {
      results.set(target.key, {});
    }
  }
  return results;
}

export async function resolveSessions(
  directory: string,
  targets: readonly SessionTarget[],
  options?: { claimed?: ReadonlySet<string>; registry?: readonly SessionEntry[]; cacheMs?: number },
): Promise<Map<string, SessionMatch>> {
  if (!targets.length) return new Map();
  if (targets.every((target) => target.frozen)) {
    return new Map(targets.map((target) => [target.key, { ambiguous: true }]));
  }
  const earliest = Math.min(...targets.map((target) => target.since));
  const resolvedTargets = await Promise.all(targets.map(async (target) => ({
    ...target,
    cwds: await Promise.all(target.cwds.map((cwd) => real(cwd))),
  })));
  const sessions = await listSessions(directory, earliest, { cacheMs: options?.cacheMs });
  return matchSessions(sessions, resolvedTargets, { claimed: options?.claimed, registry: options?.registry });
}
