import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import writeFileAtomic from "write-file-atomic";
import { archiveFormat, githubResourceURL, validateArchive } from "./factory-data.mjs";

type Task = {
  id: string;
  state: string;
  updated_at: string;
  issue?: string | null;
  pr?: string | null;
  feedback?: { id: string; acknowledged_id?: string } | null;
};
type Day = { format: string; project: string; day: string; tasks: Task[] };
type Rule = { id: string; worker?: { status?: string } | null };
type Artifact = { category: "worker" | "task" | "rule"; age: number; task?: string; rule?: string };
type Removal = { path: string; category: Artifact["category"]; task?: string; rule?: string };

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;
const errorMessage = (error: unknown) => (error as Error).message;

const dayFile = /^\d{4}-\d{2}-\d{2}\.json$/;

export const archiveDirectory = (file: string) =>
  join(dirname(file), `${basename(file, extname(file))}-archive`);

const dayOf = (task: Task) => new Date(task.updated_at).toISOString().slice(0, 10);

async function writeDay(directory: string, data: Day) {
  const file = join(directory, `${data.day}.json`);
  await writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

export async function readArchive(directory: string, project: string) {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const days: Day[] = [];
  for (const name of names.filter((item) => dayFile.test(item)).sort()) {
    const file = join(directory, name);
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      validateArchive(data, project, name.slice(0, 10));
      days.push(data);
    } catch (error) {
      throw new Error(`${file}: ${errorMessage(error)}`);
    }
  }
  return days;
}

// Newest copy of each task whose id, issue, or PR matches; stale copies lose.
export function findArchived(days: Day[], { id, issue, pr }: { id: string; issue?: string | null; pr?: string | null }) {
  const newest = new Map<string, { task: Task; day: string }>();
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
export async function saveArchive(directory: string, project: string, tasks: Task[]) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = new Map((await readArchive(directory, project)).map((data) => [data.day, data]));
  const changed = new Map<string, Day>();
  for (const task of tasks) {
    const day = dayOf(task);
    const data: Day = changed.get(day) ?? existing.get(day) ??
      { format: archiveFormat, project, day, tasks: [] };
    data.tasks = [...data.tasks.filter((item) => item.id !== task.id), task];
    changed.set(day, data);
  }
  for (const data of changed.values()) await writeDay(directory, data);
}

export async function removeArchived(directory: string, project: string, id: string) {
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
// Scratch files that workers leave beside the factory file; nothing names them, so only age removes them.
const workerScratch = /^(completion\d|discovery[-\d]|queue-).*\.(json|txt)$/;
const usage = "Usage: node archive.mjs clean FACTORY_FILE [--older-than 14d] [--run]";

function parseAge(value: string) {
  const match = /^(\d+)([dh])$/.exec(value);
  if (!match) throw new Error(`--older-than must look like 14d or 36h, got "${value}".`);
  return Number(match[1]) * (match[2] === "d" ? day : hour);
}

const pendingFeedback = (task: Task) => task.feedback && task.feedback.acknowledged_id !== task.feedback.id;

// Lists the per-task artifacts of tasks resolved longer than `olderThan` ago,
// the briefs and results of rules with no running worker, and worker scratch
// files, the last two by file age, and with `run` deletes them. Large
// unreferenced files are only reported.
export async function clean(
  file: string,
  { olderThan = 14 * day, run = false, now = Date.now() }: { olderThan?: number; run?: boolean; now?: number } = {},
) {
  const directory = dirname(file);
  const current: { project: string; tasks: Task[]; rules?: Rule[] } = JSON.parse(await readFile(file, "utf8"));
  const project = basename(file, extname(file)).replace(/-factory$/, "");
  const archived = (await readArchive(archiveDirectory(file), current.project)).flatMap((data) => data.tasks);
  const live = new Set(current.tasks.map((task) => task.id));
  const resolved = [...current.tasks, ...archived.filter((task) => !live.has(task.id))]
    .filter((task) => task.state === "resolved");
  const expired = resolved.filter((task) => Date.parse(task.updated_at) < now - olderThan && !pendingFeedback(task));
  const rules = current.rules ?? [];
  const idle = rules.filter((rule) => rule.worker?.status !== "running");
  const open = JSON.stringify(current.tasks.filter((task) => task.state !== "resolved" || pendingFeedback(task)));
  const busy = JSON.stringify(rules.filter((rule) => rule.worker?.status === "running"));

  const entries = await readdir(directory, { withFileTypes: true });
  const roles = workerRoles.join("|");
  const files = new RegExp(`^(${roles})-(brief|result)([.-].*)?\\.(md|json)$`);
  const dirs = new RegExp(`^(${roles})-instructions$`);
  const ruleFiles = /^(brief|result)([.-].*)?\.(md|json)$/;
  const prefixes = new Map(expired.map((task) => [`${project}-${task.id}-`, task.id]));
  const rulePrefixes = new Map(idle.map((rule) => [`${project}-${rule.id}-`, rule.id]));
  // Task artifacts go by the task's resolution date; the others by file age alone.
  const artifacts = new Map<string, Artifact>();
  for (const entry of entries) {
    if (workerScratch.test(entry.name) && entry.isFile()) {
      artifacts.set(entry.name, { category: "worker", age: olderThan });
      continue;
    }
    const pattern = entry.isFile() ? files : entry.isDirectory() ? dirs : null;
    for (let at = entry.name.indexOf("-"); at !== -1; at = entry.name.indexOf("-", at + 1)) {
      const prefix = entry.name.slice(0, at + 1);
      const rest = entry.name.slice(at + 1);
      const task = prefixes.get(prefix);
      const rule = rulePrefixes.get(prefix);
      if (task !== undefined && pattern?.test(rest)) artifacts.set(entry.name, { category: "task", task, age: 0 });
      else if (rule !== undefined && entry.isFile() && ruleFiles.test(rest) && !artifacts.has(entry.name)) {
        artifacts.set(entry.name, { category: "rule", rule, age: olderThan });
      }
    }
  }

  const remove: Removal[] = [];
  const kept: (Removal & { reason: string })[] = [];
  for (const [name, { category, age, ...owner }] of artifacts) {
    const path = join(directory, name);
    const modified = now - (await stat(path)).mtimeMs;
    if (category !== "task" && modified < Math.max(day, age)) continue;
    const reason = open.includes(name) ? "referenced by an open task"
      : busy.includes(name) ? "referenced by a running rule worker"
      : modified < day ? "modified in the last 24 hours" : null;
    if (reason) kept.push({ path, category, ...owner, reason });
    else remove.push({ path, category, ...owner });
  }
  const counts: Record<string, number> = {};
  for (const { category } of remove) counts[category] = (counts[category] ?? 0) + 1;

  const factories = entries.filter((entry) => entry.isFile() && entry.name.endsWith("-factory.json")).map((entry) => entry.name);
  const references = (await Promise.all(factories.map((name) => readFile(join(directory, name), "utf8")))).join("\n");
  const large: { path: string; size: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || factories.includes(entry.name)) continue;
    const info = await stat(join(directory, entry.name));
    if (info.size > largeFile && now - info.mtimeMs >= day && !references.includes(entry.name)) {
      large.push({ path: join(directory, entry.name), size: info.size });
    }
  }

  if (run) for (const { path } of remove) await rm(path, { recursive: true, force: true });
  const unique = (key: "task" | "rule") => [...new Set(remove.map((item) => item[key]).filter((value) => value !== undefined))];
  return { run, tasks: unique("task"), rules: unique("rule"), counts, delete: remove, kept, "stale-large": large };
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
    console.error(errorMessage(error));
    process.exitCode = errorMessage(error) === usage ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
