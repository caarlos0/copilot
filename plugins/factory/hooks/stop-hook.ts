import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import writeFileAtomic from "write-file-atomic";
import { resolveFactory, waiterPid } from "../skills/lifecycle/broker.ts";
import type { Factory, WorkerRole } from "../skills/lifecycle/factory-data.ts";
import { factoryFile, hookSession, isCoordinator } from "../skills/lifecycle/gate.ts";

// agentStop hook for the factory coordinator. It blocks the end of a turn while
// the run is not finished and no waiter is armed, or factory.mjs reconcile has
// new actionable findings. Anything unexpected allows the stop: a broken hook
// must never trap the session.
// The hook runs inside factory.mjs, which sits in skills/lifecycle/.
const lifecycle = dirname(fileURLToPath(import.meta.url));
const maxReason = 4000;
const informationalKinds = new Set(["attention-stale", "rex-session-missing"]);
const skippedStopClasses = new Set(["user-decision", "approval"]);

type Finding = Record<string, unknown>;

const hashFile = (file: string) =>
  join(dirname(file), `${basename(file, extname(file))}-stop-hook.hash`);

function block(reason: string) {
  process.stdout.write(`${JSON.stringify({ decision: "block", reason: reason.slice(0, maxReason) })}\n`);
}

function readHash(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function isActionable(finding: Finding, factory: Factory): boolean {
  const kind = finding.kind;
  if (typeof kind === "string" && informationalKinds.has(kind)) return false;
  if (kind === "stop" && finding.cause === "blocked" && typeof finding.class === "string" && skippedStopClasses.has(finding.class)) {
    return false;
  }
  if (kind === "merged-worktree" && finding.created_by_run === false) return false;
  if (kind === "branch-ahead") {
    const task = factory.tasks?.find((item) => item.id === finding.task);
    if (task?.workers?.implementation?.status === "running" || task?.workers?.review?.status === "running") return false;
  }
  return true;
}

// Normalizes one finding for deduplication. Strips elapsed-time counters and
// includes worker identity for worker-quiet so a relaunch triggers a new block.
function findingKey(finding: Finding, factory: Factory): string {
  const copy: Finding = {};
  for (const key of Object.keys(finding).sort()) {
    if (finding.kind === "worker-quiet" && key === "idle_minutes") continue;
    copy[key] = finding[key];
  }
  if (finding.kind === "worker-quiet") {
    const task = factory.tasks?.find((item) => item.id === finding.task);
    const worker = task?.workers?.[finding.role as WorkerRole];
    copy._launched_at = worker?.launched_at ?? null;
    copy._session = worker?.session ?? null;
  }
  return JSON.stringify(copy);
}

function findingsHash(session: string | null, findings: Finding[], factory: Factory): string {
  const canonical = [session ?? "", ...findings.map((finding) => findingKey(finding, factory)).sort()].join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

async function run() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    input = {};
  }
  const file = factoryFile(input.cwd ?? process.cwd());
  if (!file || !isCoordinator(input) || !statSync(file, { throwIfNoEntry: false })) return;
  const factory: Factory = JSON.parse(readFileSync(file, "utf8"));
  const resolved = await resolveFactory(file);
  const statePath = hashFile(resolved);

  if (factory.status === "finished") {
    await rm(statePath, { force: true }).catch(() => {});
    return;
  }

  if (await waiterPid(resolved) === null) {
    block(`No broker waiter is armed and the run is not finished. Arm the waiter now. Run \`node ${join(lifecycle, "factory.mjs")} broker wait ${file} --since CURSOR --exclude-source coordinator --exclude-source attention --exclude-source improve --exclude-source stops --due\` as async bash with the latest cursor. If you have no cursor, run \`factory.mjs broker cursor\`. Then end the turn.`);
    return;
  }

  // Findings block once per turn and once per unchanged actionable set: a running
  // waiter holds queued messages, so repeating the same block only floods the queue.
  if (input.stop_hook_active || input.stopHookActive) return;
  const sweep = spawnSync(process.execPath, [join(lifecycle, "factory.mjs"), "reconcile", file], { encoding: "utf8", timeout: 15000 });
  if (sweep.status !== 0) return;
  const { findings } = JSON.parse(sweep.stdout);
  const actionable: Finding[] = Array.isArray(findings) ? findings.filter((finding: Finding) => isActionable(finding, factory)) : [];
  if (!actionable.length) {
    await rm(statePath, { force: true }).catch(() => {});
    return;
  }

  const hash = findingsHash(hookSession(input), actionable, factory);
  if (readHash(statePath) === hash) return;
  await writeFileAtomic(statePath, `${hash}\n`, { mode: 0o600 });
  block(`factory.mjs reconcile reports ${actionable.length} finding(s). Act on each finding with factory.mjs write. Keep the waiter armed. Then end the turn. If a finding needs the user, report it. Do not act on it. Findings: ${JSON.stringify(actionable)}`);
}

export async function main(_argv: string[]) {
  try {
    await run();
  } catch {
    // fail open
  }
}
