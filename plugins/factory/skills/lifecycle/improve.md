# Factory self-improve worker

Use this procedure only when the factory gives you a brief for an `improve`
rule. You are a one-shot, read-only worker. You find what slows the factory or
wastes money. You propose exactly one change, or none. You change nothing
yourself.

This is the `run-health-review` discipline of Lever, applied to the sessions of
the factory. Check the prediction of the last run first. Change one thing. State
how to verify it. Use `prompt-mirror` only for the "ask less of the user"
signal.

## Inputs

The brief gives you `WINDOW_START` (an ISO time) and absolute paths for:

- the metrics file, `<project>-self-improve-metrics.json`. The factory
  generated it with `session-metrics.mjs --active-since WINDOW_START`. Your
  sandbox can fail to read session logs, so do not run the tool;
- the sessions registry, `<owner.repo>-factory-sessions.jsonl`, to find the role
  and task of a session;
- the factory file, read only;
- your result file, `<project>-<rule>-result.json`. If it exists, it is the
  previous run. Read it before you write anything.

## Privacy

- Read only sessions that are in the registry.
- Use the metrics file from the brief. It shows counts and names, not content.
  Read the event log of a session yourself only to explain a number. Never copy
  its text.
- Put session IDs and metric values in the result. Never put prompts, replies,
  commands, file contents, or secrets in the result, an issue, a PR, or a
  comment.

## Session history queries

If you use `session_store_sql`, obey these rules:

- Use `source: "local"` with SQLite syntax. Do not use `INTERVAL` or `ILIKE`.
  Example: `substr(created_at,1,10) >= date('now','-7 days')`.
- Put a time limit on every query. Cloud queries time out after 60 seconds.
- Select IDs and summaries first. Then get the details for only those IDs.
- If a query fails, do not repeat it. Count events in `events.jsonl` instead.

## Steps

1. **Check the previous run.** If the result file has a `change`, read the
   top-level `decision.status` that the factory added (`applied`, `declined`, or
   `noted`). If it is `applied`, measure the metric that the change named, in
   the sessions after `decision.at`. Then set a verdict: `confirmed`,
   `refuted`, or `inconclusive`. If it is not `applied`, the verdict is
   `not-applied`. After a `declined`, do not propose the same change again.
2. **Measure.** Read the metrics file. Its sessions were active in the window.
   `started_before_window` names the sessions that began earlier. Their numbers
   count only the events in the window. Compare the window with the window
   before it when that data exists. Group the sessions by `role`.
3. **Look for these signals:**

   | Signal | Where it shows | Typical change |
   | --- | --- | --- |
   | Spend | `usage.cost`, tokens, low `cache_read_tokens` | Make a brief narrower; set smaller worker caps; use fewer review models |
   | Speed | `wall_minutes` and `turns` per resolved task | Remove a step; start workers sooner |
   | Idle time | `idle.minutes`, `over_10_minutes`, `longest_minutes` | Use a shorter wait or no wait; use the waiter instead of manual checks |
   | Polling | `commands.sleep`, `commands.status_reads` high; `gh_wait` and `watch` low | Use `pr-watch.mjs` (`gh_wait` counts it); use `gh pr checks --watch --fail-fast` for a one-off check |
   | Questions to the user | `tools.ask_user.calls`, `user_messages` in worker sessions | Give the worker a default answer, or decide in the brief |
   | Failures | `tools.<name>.failures` | Correct the tool profile or the brief; a tool that fails every call is a config bug |
   | User waits | `attention.requested` per `role`, and the median time to the `attention.resolved` for the same `session`, in the events log `<owner.repo>-factory-events.jsonl` beside the factory file | Give the worker a default answer, or allow the tool in its profile |

   Four of these signals have a standing line in every implementation brief
   ("Standing cost lines" in the skill). If the signal is still high, the brief
   does not have the line, or the worker ignores it. Say which one. Do not
   propose the line again:

   | Signal | Standing line |
   | --- | --- |
   | `commands.sleep`, `commands.status_reads`, `tools.manage_schedule.calls` | Never poll: no sleep loops, no self-wake under 20 minutes; wait with `pr-watch.mjs` or the blocking waiter |
   | `tools.create.failures`, `tools.edit.failures` | View a file before editing it; edit, not create, for a file that exists |
   | `user_messages` per worker (steering) | The brief has the default for every decision; the factory batches its nudges into one message |
   | `idle.over_10_minutes`, high `idle.minutes` in an implementation session after the PR goes to review | Save a `waiting` result; the factory closes the pane and starts a fresh worker for follow-ups |

   The event log does not record the run times of tools. Do not claim that a
   tool was slow. "Idle" is the time between turns, so it includes the waits for
   the user and for notifications. A session that started before the window has
   numbers for the window only. Its tool calls that began before the window do
   not count as failures. The session of the factory is long-lived. If the
   factory ran the tool without `--active-since`, its totals are cumulative over
   the whole session. Compare them with the previous result, not with the
   window.
4. **Pick one change, or none.** Choose the change with the largest expected
   effect on one metric. If the window has fewer than 3 worker sessions, prefer
   no change. If the cause is outside the factory (for example a CI outage), say
   so and propose nothing.
5. **Write the result** (below), atomically. Write a temporary file in the same
   directory, then rename it. End with the result path.

## Change kinds

| Kind | What it is | Who applies it |
| --- | --- | --- |
| `rule` | A rule's `every`, `enabled`, `query`, or `prompt` | The factory, with `--rules`, after the user accepts it in the dashboard |
| `limit` | The worker caps in `limits`, or the total `budget` | The factory, with `--limits` or `--budget`, after the user accepts it in the dashboard |
| `process` | How the factory or its workers behave, such as a brief line | The factory, in later briefs, after the user accepts it in the dashboard |
| `skill` | A text change to the factory skill or agent files | The user. The factory only reports it |

## Result

```json
{
  "format": "factory-improve/v1",
  "window": { "from": "2026-05-01T00:00:00Z", "to": "2026-05-08T00:00:00Z", "sessions": 6 },
  "previous": {
    "change": "Use pr-watch.mjs in implementation briefs",
    "decision": "applied",
    "metric": "commands.status_reads per review session",
    "before": 14,
    "after": 3,
    "verdict": "confirmed"
  },
  "change": {
    "kind": "process",
    "summary": "Tell implementation workers to wait with pr-watch.mjs instead of sleeping.",
    "apply": "Add one line to the implementation brief.",
    "evidence": [
      { "metric": "commands.sleep", "value": 21, "sessions": ["11111111-1111-4111-8111-111111111111"] }
    ],
    "prediction": "sleep commands per implementation session fall from 7 to 1 or less",
    "verify": "Run session-metrics --active-since the decision time, at the next run"
  },
  "findings": [
    { "class": "polling", "summary": "Three implementation sessions poll CI with sleep.", "evidence": [] }
  ]
}
```

`previous` is `null` on the first run. `change` is `null` for no change. Keep
`findings`, so the next run knows what you saw. The factory shows `change` in the
"Waiting for you" list of the dashboard as a proposal with Accept and Decline
buttons. Write `summary` and `evidence` for a person who reads only that row.
The factory adds `decision` (`status`, `at`, `note`) after the user answers. Do
not write it yourself.
