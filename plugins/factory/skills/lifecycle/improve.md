# Factory self-improve worker

Use this procedure only when the factory briefs you for an `improve` rule. You
are a one-shot, read-only worker. You find what slows the factory or wastes
money, and you propose exactly one change, or none. You change nothing yourself.

This is Lever's `run-health-review` discipline applied to the factory's own
sessions: check last run's prediction first, change one thing, state how to
verify it. Use `prompt-mirror` only for the "ask less of the user" signal.

## Inputs

The brief gives you `WINDOW_START` (an ISO time) and absolute paths for:

- the sessions registry, `<owner.repo>-factory-sessions.jsonl`;
- `session-metrics.mjs`, beside this file;
- the factory file, read only;
- your result file, `<project>-<rule>-result.json`. If it exists, it is the
  previous run. Read it before you write anything.

## Privacy

- Read only sessions that are in the registry.
- Use `session-metrics.mjs`. It prints counts and names, not content. Read a
  session's event log yourself only to explain a number, and never copy its
  text.
- Put session IDs and metric values in the result. Never put prompts, replies,
  commands, file contents, or secrets in the result, an issue, a PR, or a
  comment.

## Session history queries

If you use `session_store_sql`, follow these rules:

- Use `source: "local"` with SQLite syntax. Do not use `INTERVAL` or `ILIKE`.
  Example: `substr(created_at,1,10) >= date('now','-7 days')`.
- Time-bound every query. Cloud queries time out after 60 seconds.
- Select IDs and summaries first. Then fetch details for only those IDs.
- If a query fails, do not repeat it. Count events in `events.jsonl` instead.

## Steps

1. **Check the previous run.** If the result file has a `change`, read the
   top-level `decision.status` the factory added (`applied`, `declined`, or
   `noted`). If it was applied, measure
   the metric it named, in the sessions after `decision.at`, and set a verdict:
   `confirmed`, `refuted`, or `inconclusive`. If it was not applied, the
   verdict is `not-applied`. Do not propose the same change again after a
   `declined`.
2. **Measure.** Run `node session-metrics.mjs --registry REGISTRY --since
   WINDOW_START`. Compare it with the window before it when that data exists.
   Group by session `role`.
3. **Look for these signals:**

   | Signal | Where it shows | Typical change |
   | --- | --- | --- |
   | Spend | `usage.cost`, tokens, low `cache_read_tokens` | Narrow a brief; smaller worker caps; fewer review models |
   | Speed | `wall_minutes` and `turns` per resolved task | Cut a step; start workers sooner |
   | Idle time | `idle.minutes`, `over_10_minutes`, `longest_minutes` | Shorter or no wait; use the waiter instead of manual checks |
   | Polling | `commands.sleep`, `commands.status_reads` high; `gh_wait` and `watch` low | Use `gh wait`, `gh pr checks --watch --fail-fast` |
   | Questions to the user | `tools.ask_user.calls`, `user_messages` in worker sessions | Give the worker a default answer, or decide in the brief |
   | Failures | `tools.<name>.failures` | Fix the tool profile or the brief; a tool that fails every call is a config bug |

   The event log does not record tool run times. Do not claim a tool was slow.
   "Idle" is the time between turns, so it includes waits for the user and for
   notifications. Metrics are whole-session totals. The factory's own session
   is long-lived and registered once, so its numbers are cumulative; compare
   them with the previous result, not with the window.
4. **Pick one change, or none.** Choose the change with the largest expected
   effect on one metric. With fewer than 3 worker sessions in the window,
   prefer no change. If the cause is outside the factory (for example a CI
   outage), say so and propose nothing.
5. **Write the result** (below), atomically: write a temporary file in the same
   directory, then rename it. End with the result path.

## Change kinds

| Kind | What it is | Who applies it |
| --- | --- | --- |
| `rule` | A rule's `every`, `enabled`, `query`, or `prompt` | The factory, with `--rules`, after the user agrees |
| `limit` | The worker caps in `limits`, or the total `budget` | The factory, with `--limits` or `--budget`, after the user agrees |
| `process` | How the factory or its workers behave, such as a brief line | The factory, in later briefs, after the user agrees |
| `skill` | A text change to the factory skill or agent files | The user. The factory only reports it |

## Result

```json
{
  "format": "factory-improve/v1",
  "window": { "from": "2026-05-01T00:00:00Z", "to": "2026-05-08T00:00:00Z", "sessions": 6 },
  "previous": {
    "change": "Use gh wait in review briefs",
    "decision": "applied",
    "metric": "commands.status_reads per review session",
    "before": 14,
    "after": 3,
    "verdict": "confirmed"
  },
  "change": {
    "kind": "process",
    "summary": "Tell implementation workers to wait with gh pr checks --watch --fail-fast.",
    "apply": "Add one line to the implementation brief.",
    "evidence": [
      { "metric": "commands.sleep", "value": 21, "sessions": ["11111111-1111-4111-8111-111111111111"] }
    ],
    "prediction": "sleep commands per implementation session fall from 7 to 1 or less",
    "verify": "Run session-metrics for sessions after the change, at the next run"
  },
  "findings": [
    { "class": "polling", "summary": "Three implementation sessions poll CI with sleep.", "evidence": [] }
  ]
}
```

`previous` is `null` on the first run. `change` is `null` for no change; keep
`findings` so the next run knows what you saw. The factory adds `decision`
(`status`, `at`, `note`) after the user answers. Do not write it yourself.
