# Model benchmark

Compares Copilot CLI models on the work this repository's factory does. It answers one question: does a cheaper model finish the same tasks at the same quality, for less money?

The harness needs only Node and git. It has no dependencies and no network of its own.

## What it measures

Each run starts one headless `copilot` worker with the `coding:caarlos0` agent and a factory-style brief. The task is cut from this repository's history, so the fix is known and hidden.

| Task | Role | Source |
| --- | --- | --- |
| INV-1, INV-3 | investigation | Trace a bug at a commit before its fix. Expected verdict: `implement`. |
| INV-2 | investigation | A trap. The bug is already fixed. The correct verdict is not `implement`. |
| IMPL-1, IMPL-2, IMPL-3 | implementation | Re-do a real fix on the parent commit. |

Pass rules:

- Implementation: the fix commit's tests pass on the worker's tree, **and** the parent commit's tests still pass. The worker never sees the tests.
- Investigation: right verdict, every required fact in the result, no forbidden claim.
- Protocol (reported, not part of pass): complete result file plus an accepted `worker.result` event.
- Contamination: a worker that reads the coordinator state, the session store, the real repo, or the fix commit is excluded from the rates and counted.
- Infra: quota, rate-limit and unknown-model failures are excluded from the rates and counted.

The brief for IMPL-1 gives the exact error text, because the hidden test checks it. Every model gets the same brief.

## Run

Print the plan first. This writes nothing:

```sh
node bench/model-benchmark/run.mjs --models claude-sonnet-5.5,gemini-4-argon,gemini-3.8-flash --tasks IMPL-1 --reps 1 --max-aic 100 --dry-run
```

Smoke run (3 runs, about 110 AIC in total). It checks the harness, not the models:

```sh
node bench/model-benchmark/run.mjs --models claude-sonnet-5.5,gemini-4-argon,gemini-3.8-flash --tasks IMPL-1 --reps 1 --max-aic 100
```

Full screen: all six tasks, five repeats per model.

```sh
node bench/model-benchmark/run.mjs --models claude-sonnet-5.5,gemini-4-argon,gemini-4-carbon,gemini-4-hydrogen,gemini-3.8-flash --reps 5
node bench/model-benchmark/report.mjs
```

Runs go one at a time, in a seeded random order, so models interleave. Ctrl-C stops the current worker and the batch.

Output goes to `$BENCH_OUT`, else `~/.local/state/copilot-coordinator/bench`:

- `ledger.jsonl`: one record per run.
- `<batch>/<run_id>/`: logs, usage, transcript, result, events, record.

`score.mjs` scores one tree or one result file by hand:

```sh
node bench/model-benchmark/score.mjs --task IMPL-2 --work DIR
node bench/model-benchmark/score.mjs --task INV-1 --result FILE
```

## Cost

One AI credit (AIC) is 1e9 nano AIU. The report shows `$` with `--usd-per-aic` (default 0.01). That rate is an assumption, not a verified price.

Price in AIC per 1M tokens:

| Model | Input | Cache read | Cache write | Output |
| --- | --- | --- | --- | --- |
| claude-sonnet-5.5 | 200 | 10 | 250 | 1000 |
| claude-haiku-5.5 | 10 | 1 | 12.5 | 50 |
| gemini-4-argon | 200 | 10 | n/a | 1000 |
| gemini-4-carbon | 200 | 10 | n/a | 1000 |
| gemini-4-hydrogen | 150 | 7.5 | n/a | 750 |
| gemini-3.8-flash | 75 | 7.5 | n/a | 375 |

gemini-4-carbon doubles on 2026-12-01 (400 / 20 / 2000). gemini-3.8-flash is a promotional price until 2026-12-31 and has no usage data. gemini-4-neon has no known price.

Estimates: the full screen is about 8.2k AIC. A second Sonnet batch as a noise baseline is about 1.7k AIC. `--max-aic` is a soft cap, and Copilot accepts 30 at minimum. The default caps are 250 AIC and 25 minutes for implementation, 200 AIC and 15 minutes for investigation.

## Keep bar

`report.mjs` groups by role and model. A candidate is kept only if all of these hold against the baseline:

1. Pass rate is at most 10 points below the baseline, and the Wilson 95% lower bound is at least 0.75.
2. Protocol compliance is 100% and contamination is 0.
3. Tool-failure rate is at most 5 points above the baseline.
4. AIC per passing run is at most 0.8 times the baseline.
5. Wall time p50 is at most 1.5 times the baseline.

Otherwise the verdict is `reject`, with the failed lines named. At least 12 runs per role are needed before any model can pass line 1. Five repeats over three tasks give 15.

Run the baseline model twice, in two batches, to see the noise between identical runs.

## Isolation

- Each run gets a fresh directory under the real path of `$TMPDIR`: the base tree as a one-commit git repo (no history), a pinned read-only copy of the factory tools, and a scratch factory file.
- The worker gets no Rex variables and the `git stash` and `rex` commands are denied. The deny list is checked against `plugins/factory/skills/lifecycle/SKILL.md` by a test.
- The fix commit is never in the scratch repo.

## Known limits

- The regression step runs the whole lifecycle test suite, except `serve-lan.test.cjs`. Some tests (the dashboard ones) use loopback sockets. In a sandbox that blocks loopback, or one that sets a proxy, these fail on any tree. Run the benchmark where loopback works.
- Session lookup reads `~/.copilot/session-state`. If a session is not found, the ledger has no tool counts for that run, and contamination cannot be checked.
- The usage file shape is read from `--usage-output-file`. A run without it shows `usage_missing` and no AIC.
- The harness has never run against a live model. Run the smoke command first.

## Tests

```sh
node --test bench/model-benchmark
```

The tests use synthetic repositories. They never call `copilot` and need no network.
