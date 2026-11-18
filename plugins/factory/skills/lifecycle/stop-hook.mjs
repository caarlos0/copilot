import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFactory, waiterPid } from "./broker.mjs";
import { stateFile } from "./state-dir.mjs";

// agentStop hook for the factory coordinator. It blocks the end of a turn while
// the run is not finished and no waiter is armed, or reconcile.mjs has findings.
// Anything unexpected allows the stop: a broken hook must never trap the session.
const here = dirname(fileURLToPath(import.meta.url));
const maxReason = 4000;

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : "";
}

// "<owner.repo>-factory.json" from the origin remote, as the lifecycle skill names it.
function factoryFile(cwd) {
  if (process.env.FACTORY_FILE) return process.env.FACTORY_FILE;
  const match = git(cwd, "remote", "get-url", "origin").match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return match ? stateFile(`${match[1]}.${match[2]}-factory.json`) : null;
}

function block(reason) {
  process.stdout.write(`${JSON.stringify({ decision: "block", reason: reason.slice(0, maxReason) })}\n`);
}

async function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    input = {};
  }
  const file = factoryFile(input.cwd ?? process.cwd());
  if (!file || !statSync(file, { throwIfNoEntry: false })) return;
  const factory = JSON.parse(readFileSync(file, "utf8"));
  if (factory.status === "finished") return;

  if (await waiterPid(await resolveFactory(file)) === null) {
    block(`No broker waiter is armed and the run is not finished. Arm it now: run \`node ${join(here, "broker.mjs")} wait ${file} --since CURSOR --exclude-source coordinator --due\` as async bash with the latest cursor (\`broker.mjs cursor\` if you have none), then end the turn.`);
    return;
  }

  // Findings block once per turn: some need the user, and a loop would only burn turns.
  if (input.stop_hook_active || input.stopHookActive) return;
  const sweep = spawnSync(process.execPath, [join(here, "reconcile.mjs"), file], { encoding: "utf8", timeout: 15000 });
  if (sweep.status !== 0) return;
  const { findings } = JSON.parse(sweep.stdout);
  if (findings?.length) {
    block(`reconcile.mjs reports ${findings.length} finding(s). Act on each one through factory.mjs, keep the waiter armed, then end the turn. Report a finding that needs the user instead of acting on it. Findings: ${JSON.stringify(findings)}`);
  }
}

try {
  await main();
} catch {
  // fail open
}
