import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFactory, waiterPid } from "../skills/lifecycle/broker.ts";
import { factoryFile, isCoordinator } from "../skills/lifecycle/gate.ts";

// agentStop hook for the factory coordinator. It blocks the end of a turn while
// the run is not finished and no waiter is armed, or factory.mjs reconcile has findings.
// Anything unexpected allows the stop: a broken hook must never trap the session.
// The hook runs inside factory.mjs, which sits in skills/lifecycle/.
const lifecycle = dirname(fileURLToPath(import.meta.url));
const maxReason = 4000;

function block(reason: string) {
  process.stdout.write(`${JSON.stringify({ decision: "block", reason: reason.slice(0, maxReason) })}\n`);
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
  const factory = JSON.parse(readFileSync(file, "utf8"));
  if (factory.status === "finished") return;

  if (await waiterPid(await resolveFactory(file)) === null) {
    block(`No broker waiter is armed and the run is not finished. Arm the waiter now. Run \`node ${join(lifecycle, "factory.mjs")} broker wait ${file} --since CURSOR --exclude-source coordinator --due\` as async bash with the latest cursor. If you have no cursor, run \`factory.mjs broker cursor\`. Then end the turn.`);
    return;
  }

  // Findings block once per turn: some need the user, and a loop would only burn turns.
  if (input.stop_hook_active || input.stopHookActive) return;
  const sweep = spawnSync(process.execPath, [join(lifecycle, "factory.mjs"), "reconcile", file], { encoding: "utf8", timeout: 15000 });
  if (sweep.status !== 0) return;
  const { findings } = JSON.parse(sweep.stdout);
  if (findings?.length) {
    block(`factory.mjs reconcile reports ${findings.length} finding(s). Act on each finding with factory.mjs write. Keep the waiter armed. Then end the turn. If a finding needs the user, report it. Do not act on it. Findings: ${JSON.stringify(findings)}`);
  }
}

export async function main(_argv: string[]) {
  try {
    await run();
  } catch {
    // fail open
  }
}
