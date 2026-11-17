# AGENTS.md: factory plugin

Plugin-specific rules. Repository-wide rules are in the root `AGENTS.md`.

## Factory

The factory coordinator never does work or investigation; it always delegates.
It may only take in work, create tasks, write briefs, launch and monitor
workers, verify results, record state, merge verified worker branches, release
panes, and report. It never edits product files, investigates, scans, writes
fixes, or resolves a worker's code conflicts, even for a one-line change. A
conflicting merge goes back to a worker to run `git merge main`. Keep this rule
in `agents/general.agent.md` and the lifecycle skill's "Delegate every task to
workers" section in sync.

`factory:general` is a thin agent over
`plugins/factory/skills/lifecycle/SKILL.md`. It preloads `lifecycle`, which
disables model/user invocation. It also preloads `autonomy-dial` and
`progress-contract` from the external `lever@lever` plugin (`github/lever`).
Do not vendor Lever skills or templates. Factory owns panes and state; Lever
owns autonomy, spend, brief templates, PR shepherding, and review procedures.
The coordination plugin stays unchanged, and the reviewer handoff stays with
`coordination:review`.
The factory runs every worker in the Rex session it started in (`$REX_SESSION`).
It never creates or renames a Rex session; it records the session in the
root `rex_session` field. Only the factory manages Rex panes. Workers run
commands with their own shell tool and never create, close, or type into Rex
windows, tabs, splits, or panes; the launch instructions carry this rule, and
release closes verified stray windows. The `REX_*` variables stay set for
workers. Implementation worktrees come from the local default branch: launch
plain `wt NAME` in the main checkout, never `wt NAME --main`, which uses
`origin/<default>` and loses unpushed local commits.

Workers start with their brief in the launch command
(`copilot ... -i 'Read <brief> and do it.'`), so there is no fixed sleep and no
`rex send` for the first message; `rex send` is only for follow-ups to idle
workers. The planned role with `unknown` status is in the factory file before
launch, and the pane and window IDs are written right after it. The short gap
between them cannot be removed.

Every brief sets a write boundary. The worker's assigned worktree is the only
writable root; the result path and `$TMPDIR` are the only other writable
paths. Workers never create a worktree, switch or check out a branch in
another checkout, or edit or commit on the primary checkout or default branch.
A brief never gives the primary checkout as the repo path of a writing worker.
A worker whose cwd or branch differs from its brief writes a `blocked` result
and does not edit. Every brief tells the worker to read
`plugins/factory/AGENTS.md` before its first edit.

State is one `<owner.repo>-factory.json` (`factory/v1`) per project under
`~/.local/state/copilot-coordinator/`, with one agent owner guarded by
`<project>-factory.lock`. Agent and dashboard writes share `factory.mjs` and
its short-lived `<file>.write.lock`. It validates the
state flow (`initial`, `investigation`, `implementation`, `review`, `blocked`,
`resolved`), keeps history, and replaces the file atomically. A task links a
GitHub issue, or has `issue: null` for work without one. An issue-less task
uses every state without a PR: review covers its local branch `head`, and a
local `git merge` resolves it as `merged` with the merge commit SHA in
`details`. Tasks with an issue keep the PR flow. `factory-data.mjs` holds the
schema and is shared by the writer,
`migrate.mjs`, `serve.mjs` (port 8766, lists only `*-factory.json`), and
`dashboard.html`. `migrate.mjs` moves the implementer and coordinator handoffs
into the factory file. It refuses to run against a live legacy lock.

The factory file is the only task tracker. Create every task there before
launching its worker. Before each launch, result disposition, head change,
merge, or release, write the planned action with `factory.mjs`; write the
observed result in the same turn before the next action. A refused write stops
the work until the file is reread and drift is reconciled. Never track task
state only in chat, session SQL, another board, or another file. At startup,
every wake, and before reporting, compare the file with `git worktree list`,
branches merged into the default branch, Rex panes, PRs, and worker results.
Repair drift through `factory.mjs`, including local issue-less merges with
`resolution: merged` and the full merge SHA in `details.merge_commit`.

The dashboard opens task lists in a modal and can move a task back or directly
to `resolved` with an operator comment. Manual resolution requires a non-merge
outcome; it does not merge or close GitHub items. Resolved tasks with pending
feedback are not archived. Archived tasks go to
`<owner.repo>-factory-archive/YYYY-MM-DD.json`, are never deleted, and come
back only through `factory.mjs --restore` after the user agrees. Task
`revision` protects stale reads; old files start at zero.
Comments remain in source-tagged history; `feedback` tracks the latest ID and
acknowledgement. Reconcile all pending comments before worker results, include
the current feedback ID in worker briefs/results, and acknowledge only after
workers are safely rebriefed or parked. CLI writes after dashboard feedback need
`--expected-revision` plus `--ack-feedback` or `--feedback-id`.
The factory waits on dashboard events even when all workers are blocked.
Dashboard changes do not stop workers, resume a paused run, or grant authority.

Implementation workers use `pr-shepherd` and are the sole landing writers.
They run `autonomy-dial`'s `may_merge` before every landing attempt. There is no
extra per-head approval when a resolved grant covers it; PR comments never
raise authority. Store grant provenance and spend in `details.lever`, and the
head-specific decision in `merge` with `source: "lever"`. New heads clear the
decision, not the standing grant. Legacy `comment` and `factory-session`
records remain readable but are not authority on recovery.

When task file lists overlap, record each task's validated default-branch SHA
in `details.validated_base_sha`. After one lands, the remaining worker merges
the new base (never rebases), reruns affected checks on the combined code, and
refreshes head-specific evidence before landing. Prefer an existing repository
merge queue. For local-only tasks, use the current local default branch, not
`origin`; independent tasks stay parallel.

Review workers use `cross-model-review`, not the local `review` wrapper.
Review depth follows the shared spend budget. A clean precision result is not
a GitHub approval, and `review` state can have no optional model reviewer.
Do not start a second Lever delivery coordinator, cloud runner, schedule,
or autopilot merely because factory is running.

The producer ("Find work") is not a task state. It feeds `initial` from three
sources: user links, `search` rules, and `backlog` rules (a one-shot read-only
worker using `keep-the-pool-full`). A rule with `every` runs on a schedule only
while the factory is active and running; `broker.mjs wait --due` returns a
`rule.due` event when one is due. The factory stamps `--rule ID --ran` before it
dispatches. The `ignored` list holds skipped archive matches. The dashboard
shows rules and skipped work read-only.

An `improve` rule is maintenance, not work finding. Its one-shot, read-only
worker follows `improve.md` and Lever's `run-health-review`, and proposes at
most one change. The factory asks the user, applies `rule` and `limit` changes
only after the answer, and never edits plugin files. `factory.mjs` keeps
`<owner.repo>-factory-sessions.jsonl` (IDs, roles, task or rule names; mode 0600)
from `--session` and worker records. `session-metrics.mjs` reads those sessions'
`events.jsonl` and prints counts only, never content. It cannot measure tool run
times, and "idle" means time between turns.

The factory waits with `broker.mjs wait`, not `wait.mjs`. The broker keeps one
append-only JSONL log, `<owner.repo>-factory-events.jsonl` (mode 0600), beside
the factory file. Events are typed notifications (`task.moved`, `task.updated`,
`feedback.pending`, `worker.result`, `worker.blocked`; `rule.due` is computed by
`wait --due` and never stored), each with a `source`. A cursor is a byte offset,
so no event is lost between two `wait` calls. `factory.mjs` emits after every
successful write (source `coordinator`, or `dashboard` for operator moves), and
the factory waits with `--exclude-source coordinator` so its own writes never
wake it. Workers write their result file atomically, then run
`broker.mjs emit worker.result` (or `worker.blocked`). The factory JSON stays the
only task tracker and the result files stay evidence; events are only
notifications and the worker-to-factory channel. This exists to cut idle time:
the factory must re-arm `wait` immediately after handling events. A failed
emit never fails a state write; `reconcile.mjs` catches whatever an event
missed.

The skill still bundles `wait.mjs` and its tests, deprecated in favor of the
broker; keep it working until it is removed. It must not depend on files in the
coordination plugin. The factory copy adds `--due`. Without it, keep the two
copies behaviorally aligned.
`serve.mjs` repeats the small state-directory confinement code of the coordinator
server on purpose: the two plugins load independently.

`reconcile.mjs` is a read-only sweep that prints JSON findings: complete results
newer than their task, open issue-less task branches ahead of the default
branch, clean worktrees of merged tasks whose HEAD is in the default branch
(`merged-worktree`: remove with `wt NAME --delete`, only if the run created it;
never `wt --cleanup`), and open Rex windows of resolved tasks. The factory runs
it at startup, on every wake and user message, and before every report, so a
missed waiter wake cannot leave finished work unmerged. The waiter is re-armed
after each wake or user message, and `broker.mjs cursor` is taken before the
startup sweep. Closing a task's panes belongs to the step that records
`resolved`.

On every wake, drain all actionable tasks and reconcile results/worktrees,
fill free worker slots before waiting, and run enabled search/backlog rules
when the queue is empty and capacity is free. Keep one waiter armed unless the
run is truly finished; never mark it finished while a task, result, worktree,
or scheduled rule remains actionable.

## Validation

Run `node --test plugins/factory/skills/lifecycle/*.test.cjs` from the
repository root for factory data, writer, migration, server, dashboard, and
result notification changes.
