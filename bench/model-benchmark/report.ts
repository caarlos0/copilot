import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { defaultOut } from "./run.mjs";
import { loadTasks } from "./score.mjs";
import type { Json } from "./score.ts";

const z = 1.96;

// Wilson 95% score interval for k successes in n trials.
export function wilson(k: number, n: number): [number | null, number | null] {
  if (n === 0) return [null, null];
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

// Linear interpolation between the closest ranks.
export function percentile(values: number[], fraction: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const ratio = (top: number, bottom: number) => (bottom === 0 ? null : top / bottom);

export type Summary = ReturnType<typeof summarize>;
export type Row = Summary & { verdict: string; failed: string[] };

export function summarize(records: Json[]) {
  const used = records.filter((record) => record.excluded === null);
  const passes = used.filter((record) => record.score?.pass).length;
  const costs = used.map((record) => record.aic).filter((value) => value !== null);
  const total = sum(costs);
  const [low, high] = wilson(passes, used.length);
  return {
    role: records[0].role, model: records[0].model,
    runs: records.length, n: used.length, pass: passes, rate: ratio(passes, used.length), wilson_low: low, wilson_high: high,
    aic_total: total, aic_per_run: ratio(total, costs.length), aic_per_pass: ratio(total, passes),
    wall_p50: percentile(used.map((record) => record.wall_seconds), 0.5), wall_p90: percentile(used.map((record) => record.wall_seconds), 0.9),
    tool_failure_rate: ratio(sum(used.map((record) => record.tool_failures ?? 0)), sum(used.map((record) => record.tool_calls ?? 0))),
    edit_failure_rate: ratio(sum(used.map((record) => record.edit_failures ?? 0)), sum(used.map((record) => record.edit_calls ?? 0))),
    protocol_rate: ratio(used.filter((record) => record.score?.protocol.ok).length, used.length),
    contaminated: records.filter((record) => record.excluded === "contamination").length,
    infra: records.filter((record) => record.excluded === "infra").length,
    mixed_model: used.filter((record) => record.mixed_model).length,
    usage_missing: used.filter((record) => record.usage_missing).length,
  };
}

const atMost = (value: number | null, limit: number | null) => value !== null && limit !== null && value <= limit;

// The keep bar from the loop card. Every line must hold; the baseline defines the limits.
export function keepBar(candidate: Summary, baseline?: Summary): { verdict: string; failed: string[] } {
  if (!baseline) return { verdict: "no-baseline", failed: [] };
  const lines: Record<string, boolean> = {
    pass_rate: candidate.rate !== null && candidate.rate >= baseline.rate! - 0.1 && candidate.wilson_low! >= 0.75,
    protocol: candidate.protocol_rate === 1 && candidate.contaminated === 0,
    tool_failures: atMost(candidate.tool_failure_rate ?? 0, (baseline.tool_failure_rate ?? 0) + 0.05),
    cost: baseline.aic_per_pass !== null && atMost(candidate.aic_per_pass, baseline.aic_per_pass * 0.8),
    wall: baseline.wall_p50 !== null && atMost(candidate.wall_p50, baseline.wall_p50 * 1.5),
  };
  const failed = Object.keys(lines).filter((name) => !lines[name]);
  return { verdict: failed.length ? "reject" : "keep", failed };
}

export function aggregate(records: Json[], baselineModel: string): Row[] {
  const groups = new Map<string, Json[]>();
  for (const record of records) {
    const key = `${record.role}\n${record.model}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const rows = [...groups.values()].map(summarize);
  return rows.map((row): Row => {
    if (row.model === baselineModel) return { ...row, verdict: "baseline", failed: [] };
    const baseline = rows.find((other) => other.role === row.role && other.model === baselineModel);
    return { ...row, ...keepBar(row, baseline) };
  }).sort((a, b) => a.role.localeCompare(b.role) || a.model.localeCompare(b.model));
}

const percent = (value: number | null) => (value === null ? "n/a" : `${Math.round(value * 100)}%`);
const number = (value: number | null, digits = 1) => (value === null ? "n/a" : value.toFixed(digits));

export function renderTable(rows: Row[], usdPerAic: number) {
  const header = ["role", "model", "pass", "rate [95% wilson]", "AIC/run", "AIC/pass", "~$/pass", "wall p50/p90 s", "tool fail", "protocol", "excl", "verdict"];
  const body = rows.map((row) => [
    row.role, row.model, `${row.pass}/${row.n}`,
    row.n === 0 ? "n/a" : `${percent(row.rate)} [${percent(row.wilson_low)}-${percent(row.wilson_high)}]`,
    number(row.aic_per_run), number(row.aic_per_pass), row.aic_per_pass === null ? "n/a" : `$${(row.aic_per_pass * usdPerAic).toFixed(2)}`,
    `${number(row.wall_p50, 0)}/${number(row.wall_p90, 0)}`, percent(row.tool_failure_rate), percent(row.protocol_rate),
    `${row.contaminated + row.infra}`,
    row.failed.length ? `${row.verdict}: ${row.failed.join(",")}` : row.verdict,
  ]);
  const widths = header.map((_, index) => Math.max(header[index].length, ...body.map((line) => line[index].length)));
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd();
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join("\n");
}

export function readLedger(file: string, batch: string | null = null): Json[] {
  const records = readFileSync(file, "utf8").split("\n").filter(Boolean).map((text) => JSON.parse(text));
  return batch === null ? records : records.filter((record) => record.batch === batch);
}

const usageText = `Aggregate the benchmark ledger per role and model: pass rate with Wilson bounds,
AI credits per run and per passing run, wall time, tool failures, and the keep-bar verdict.

Usage: node report.mjs [--dir DIR] [--batch ID] [--baseline MODEL] [--usd-per-aic N] [--json FILE]

--dir          output directory with ledger.jsonl (default $BENCH_OUT, else ~/.local/state/copilot-coordinator/bench)
--batch        only this batch
--baseline     baseline model (default from tasks.json)
--usd-per-aic  price of one AI credit for the ~$/pass column (default 0.01)
--json         where to write the JSON (default DIR/report.json)
Exit: 0 success, 1 no ledger or no runs, 2 usage.`;

async function main() {
  let values: { help?: boolean; dir?: string; batch?: string; baseline?: string; "usd-per-aic"?: string; json?: string };
  try {
    ({ values } = parseArgs({
      options: {
        help: { type: "boolean", short: "h" }, dir: { type: "string" }, batch: { type: "string" },
        baseline: { type: "string" }, "usd-per-aic": { type: "string", default: "0.01" }, json: { type: "string" },
      },
    }));
  } catch (error) {
    console.error(`${(error as Error).message}\nRun with --help for usage.`);
    process.exitCode = 2;
    return;
  }
  if (values.help) {
    console.log(usageText);
    return;
  }
  const dir = resolve(values.dir ?? defaultOut());
  const usdPerAic = Number(values["usd-per-aic"]);
  if (!(usdPerAic >= 0)) {
    console.error("--usd-per-aic must be a number.");
    process.exitCode = 2;
    return;
  }
  let records: Json[];
  try {
    records = readLedger(join(dir, "ledger.jsonl"), values.batch ?? null);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
    return;
  }
  if (!records.length) {
    console.error("No runs in the ledger.");
    process.exitCode = 1;
    return;
  }
  const baseline = values.baseline ?? loadTasks().defaults.baseline;
  const rows = aggregate(records, baseline);
  console.log(renderTable(rows, usdPerAic));
  writeFileSync(resolve(values.json ?? join(dir, "report.json")), `${JSON.stringify({ baseline, usd_per_aic: usdPerAic, rows }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
