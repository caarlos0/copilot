# AGENTS.md: factory plugin

Plugin-specific rules. Repository-wide rules are in the root `AGENTS.md`.

## Factory

The factory coordinator never does work or investigation; it always delegates.
It may only take in work, create tasks, write briefs, launch and monitor
workers, verify results, record state, merge verified worker branches, release
panes, and report. It never edits product files, investigates, scans, writes
fixes, or resolves a worker's code conflicts, even for a one-line change. A
branch that is not a fast-forward of the default branch goes back to a worker
to run `git rebase main`. It never uses
the `task`, `read_agent` or `write_agent` tools for factory work. Every worker,
including backlog, discovery, and improve workers, is a Copilot session in a
Rex tab with a brief, a result file, and `broker.mjs emit`. Keep this rule
in `agents/general.agent.md` and the lifecycle skill's "Delegate every task to
workers" section in sync.

`blocked` is only for a user decision or an outside action. A worker never waits
on another task or an unmerged branch: for a conflict, a missing dependency, or
a broken default branch it rebases onto the default branch (`git rebase main`,
never merge) and makes the small fix, or the coordinator creates a new task.
The coordinator sends a follow-up (or relaunches) at once for a blocked task
with a worker-fixable cause, and verifies receipt by pane identity, then a new
result or event.

Task branches keep a linear history. A worker runs `git rebase main` (never
merge main) before it reports a head, and the factory lands a local branch with
`git merge --ff-only`, so no merge commit is created. When the default branch
moves, the worker rebases again, and the factory sends one follow-up per move.
The root rule that humans merge, not rebase, when integrating upstream into a
feature branch does not apply to factory task branches.

Standing worker rules: never use `git stash`, because the stash list is shared
by all worktrees. To compare against the base, use a scratch worktree or
`git diff > $TMPDIR/x.patch`. Workers use `claude-sonnet-5.5`
(`--model claude-sonnet-5.5` in the launch command); use a bigger model only
when the user asks for it. Two opus sessions caused 32% of spend.

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

`hooks.json` ships one `sessionStart` hook that gives every session the Rex
terminal context (`rex __internal session-start`). It runs on every session
start where the plugin is enabled, and it is silent unless `REX_SESSION` is set
and `rex` and `jq` exist. Keep `--feature-session-naming=false`: the factory
never renames a Rex session. The user-level dotfiles hook does the same, so
with both installed the context appears twice; remove one.

Workers start with their brief in the launch command
(`copilot ... --model claude-sonnet-5.5 -i 'Read <brief> and do it.'`), so there is no fixed sleep and no
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

The investigation step never implements. Its only job is to validate and
hydrate a task before work starts: check the claim, find related PRs, add
context, and set a verdict. Every task that needs work goes `initial` to
`investigation` to `implementation`; a task with an existing PR may go straight
to `review`. The investigation worker is one-shot and read-only, runs in
the primary checkout, and never uses `wt`, a worktree, or a branch. It never
edits product files, commits, pushes, opens a PR, or fixes. Its brief says "do
not change anything" and forbids writes outside the result path and `$TMPDIR`.
A clear, small task still gets a quick read-only investigation that confirms
`verdict: implement` and hydrates the brief. Implementation work never runs
under an investigation worker record; `factory.mjs` refuses an investigation
worker with `mode: continuous` or a `worktree`, and a worktree on a task in
`investigation`. Keep this rule in `agents/general.agent.md` and the lifecycle
skill's "Investigation worker" in sync.

State is one `<owner.repo>-factory.json` (`factory/v1`) per project under
`~/.local/state/copilot-factory/` (or the legacy `~/.local/state/copilot-coordinator/`,
resolved per file), with one agent owner guarded by
`<project>-factory.lock`. Agent and dashboard writes share `factory.mjs` and
its short-lived `<file>.write.lock`. It validates the
state flow (`initial`, `investigation`, `implementation`, `review`, `blocked`,
`resolved`), keeps history, and replaces the file atomically. A task links a
GitHub issue, or has `issue: null` for work without one. An issue-less task
uses every state without a PR: review covers its local branch `head`, and a
local `git merge --ff-only` resolves it as `merged` with the landed head SHA in
`details.merge_commit`. Tasks with an issue keep the PR flow. `factory-data.mjs` holds the
schema and is shared by the writer,
`migrate.mjs`, `serve.mjs` (port 8766, lists only `*-factory.json`), and
`dashboard.html`. `state-dir.mjs` resolves per file, not per directory: a
factory file may live in either directory, even when both exist. The new
directory wins, then the legacy one; a file in neither is created in the new
directory. `serve.mjs` lists and serves the factories of both directories
(deduped by name, the new one wins) and writes the file where it lives; it
caches each parsed file and sends an `ETag` (mtime, size, inode) on
`/api/factory` and `/api/factories`, answering `If-None-Match` with 304, and the
dashboard skips load and redraw on a 304;
`migrate.mjs` reads each handoff the same way and writes the factory file to
the new directory. The lock, events log, waiter PID, archive, and sessions file
sit beside the factory file, so they follow it. An explicit `--directory` means
only that directory. Nothing moves files out of the legacy
directory. `migrate.mjs` moves the implementer and coordinator handoffs
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

The dashboard sidebar sorts factories with `compareFactories` in `factory-data.mjs`:
active with open tasks, then paused or blocked with open tasks, then nothing open,
then finished; ties go by name without case, then file.
The dashboard opens task lists, and the read-only "Find work" rules and skipped
list, in one panel docked on the right edge, beside the flowchart (the
flowchart shrinks while it is open) and can move a task back or directly
to `resolved` with an operator comment. Manual resolution requires a non-merge
outcome; it does not merge or close GitHub items. Cmd+K or Ctrl+K opens a task
palette (`rankTasks` in `factory-data.mjs`) that docks the chosen task's list and
focuses its row; the shortcut is ignored while another dialog is open. Resolved tasks with pending
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
The chevron segment joined to the factory name opens one settings dialog. It edits the optional
root `budget.max_parallel_workers` (the most workers running at once over all
roles; absent means no total cap, a new file gets 10), `limits.investigation`
and `limits.implementation` (integers 1 to 100), and the optional root `lever`
ceilings `spend` (`standard`, `high`, `max`) and `autonomy_cap` (`L0` to `L5`).
It saves through `POST /api/settings` and the shared writer. A write carries,
for each changed field, the value the browser saw (`--expected-budget`,
`--expected-limits`, `--expected-lever`); a different current value is a
conflict for that field. It emits `budget.updated`, `limits.updated`, and
`lever.updated` with source `dashboard`. The coordinator reads these from the
file and never exceeds the budget or a ceiling; lowering one stops no worker. Lever values are
ceilings only: they narrow the resolved dials, never raise them, and `null`
means no ceiling. The dashboard never writes grants or Lever's dials files.

Implementation workers use `pr-shepherd` and are the sole landing writers.
They run `autonomy-dial`'s `may_merge` before every landing attempt. There is no
extra per-head approval when a resolved grant covers it; PR comments never
raise authority. Store grant provenance and spend in `details.lever`, and the
head-specific decision in `merge` with `source: "lever"`. New heads clear the
decision, not the standing grant. Legacy `comment` and `factory-session`
records remain readable but are not authority on recovery.

When task file lists overlap, record each task's validated default-branch SHA
in `details.validated_base_sha`. After one lands, the remaining worker rebases
onto the new base (never merges it), reruns affected checks on the combined code, and
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
worker using `keep-the-pool-full`). A PR the user gives for review skips
`initial`: the task is created in `review` with `--pr`, and a review worker
launches at once (`initial` to `review` is allowed only with a PR). A rule with
`every` runs on a schedule only
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

The factory waits with `broker.mjs wait`. The broker keeps one
append-only JSONL log, `<owner.repo>-factory-events.jsonl` (mode 0600), beside
the factory file. Events are typed notifications (`task.moved`, `task.updated`,
`feedback.pending`, `budget.updated`, `limits.updated`, `lever.updated`, `worker.result`, `worker.blocked`, `pr.merged`; `rule.due` and `reconcile.due` are computed by
`wait --due` and never stored), each with a `source`. A cursor is a byte offset,
so no event is lost between two `wait` calls. `factory.mjs` emits after every
successful write (source `coordinator`, or `dashboard` for operator moves), and
the factory waits with `--exclude-source coordinator` so its own writes never
wake it. Workers write their result file atomically, then run
`broker.mjs emit worker.result` (or `worker.blocked`). After a PR merge, the
implementation worker also emits `pr.merged`, a hint: the factory verifies the
merge on GitHub, resolves the task, and releases its panes and worktree, and
`reconcile.mjs` stays the backstop for a missed event, and while the run is
`active`, `wait --due` returns `reconcile.due` every 5 minutes per waiter so the
factory runs it even when no event arrives. The factory JSON stays the
only task tracker and the result files stay evidence; events are only
notifications and the worker-to-factory channel. The factory must re-arm
`wait` immediately after handling events. A failed
emit never fails a state write; `reconcile.mjs` catches whatever an event
missed.

Every turn of a non-finished factory ends with exactly one armed `broker.mjs
wait` (async bash, latest cursor), after a wake, a merge, a test run, a tool
completion, and a user message alike. Arm it first in a turn with a long step,
not last. `wait` records its PID in `<owner.repo>-factory-waiter.pid` beside
the factory file and removes it on exit. A second `wait` for the same factory
is refused with exit 1 unless the first PID is dead. `broker.mjs armed FILE`
exits 0 when a waiter is alive and 1 otherwise, and `reconcile.mjs` reports
`no-waiter` while the run is `active` or a task is open. Keep the rule in
`agents/general.agent.md` and the lifecycle skill's "Receive worker events"
in sync.

The skill must not depend on files in the coordination plugin.
`serve.mjs` repeats the small state-directory confinement code of the coordinator
server on purpose: the two plugins load independently.

`reconcile.mjs` is a read-only sweep that prints JSON findings: complete results
newer than their task, open issue-less task branches ahead of the default
branch, clean worktrees of merged tasks whose HEAD is in the default branch
(`merged-worktree`: remove with `wt NAME --delete`, only if the run created it;
never `wt --cleanup`), open Rex windows of resolved tasks, finished rule workers
whose window is open or whose status is still `running` (`rule-worker-done`),
`running` workers whose window is not in the live Rex session
(`worker-missing`, plus `rex-session-missing` once when the session is gone;
the factory relaunches them in their existing worktrees, never creating or
renaming a session), and a missing waiter (`no-waiter`). The
factory runs it at startup, on every wake and user message, and before every
report, so a missed waiter wake cannot leave finished work unmerged. The waiter
is re-armed after each wake or user message, and `broker.mjs cursor` is taken
and the waiter armed before the startup sweep. Closing a task's panes belongs to the step that records
`resolved`.

On every wake, drain all actionable tasks and reconcile results/worktrees,
fill free worker slots before waiting, and run enabled search/backlog rules
when the queue is empty and capacity is free. Keep one waiter armed unless the
run is truly finished; never mark it finished while a task, result, worktree,
or scheduled rule remains actionable.

## Validation

Run `node --test plugins/factory/skills/lifecycle/*.test.cjs` from the
repository root for factory data, writer, migration, server, dashboard, and
result notification changes. Run `node --test plugins/factory/*.test.cjs` for
the session hook.
