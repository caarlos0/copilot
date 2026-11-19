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
a broken default branch it brings in the default branch (`git rebase main`
for a task without a PR; `git merge` for a task with a PR) and makes the small fix, or the coordinator creates a new task.
The coordinator sends a follow-up (or relaunches) at once for a blocked task
with a worker-fixable cause, and verifies receipt by pane identity, then a new
result or event.

A task without a PR keeps a linear history. Its worker runs `git rebase main`
(never merge main) before it reports a head, and the factory lands the local
branch with `git merge --ff-only`, so no merge commit is created. When the
default branch moves, the worker rebases again, and the factory sends one
follow-up per move. A task with a PR follows the root rule: the worker brings
the default branch in with `git merge`, never rebases, and never force-pushes,
because a rebase breaks reviewers and stacked PRs. GitHub mergeability and the
PR checks gate it, so `emit` does not check that its head descends from `main`.

Standing worker rules: never use `git stash`, because the stash list is shared
by all worktrees. To compare against the base, use a scratch worktree or
`git diff > $TMPDIR/x.patch`. Workers use `claude-sonnet-5.5`
(`--model claude-sonnet-5.5` in the launch command); use a bigger model only
when the user asks for it. Two opus sessions caused 32% of spend.

Every implementation brief also carries the four standing cost lines from the
lifecycle skill's "Brief the workers": never poll (no sleep loops, no self-wake
under 20 minutes; wait with `pr-watch.mjs` or the blocking waiter), view a file
before editing it and use edit, not create, for an existing file, give a default
for every decision and batch nudges into one message, and save a `waiting`
result at hand-off to review so the factory closes the pane and starts a fresh
worker for follow-ups. `improve.md` maps each line to the metric it addresses.

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
workers. Implementation worktrees come from the local default branch:
`skills/lifecycle/worktree.mjs create NAME` in the main checkout branches from
local `HEAD`, never from `origin`, so unpushed local commits are kept. The helper
reads `worktreePathTemplate` from `$COPILOT_HOME/settings.json` and prints the
path and branch that the factory records. It needs no other tool.
`skills/lifecycle/worker-name.mjs` prints each worker's `--name` as
`<Verb> <ref>: <summary>` (see "Launch rules" in the lifecycle skill); the
factory never formats a name by hand.

`hooks.json` ships a `sessionStart` hook that gives every session the Rex
terminal context (`rex __internal session-start`). It runs on every session
start where the plugin is enabled, and it is silent unless `REX_SESSION` is set
and `rex` and `jq` exist. Keep `--feature-session-naming=false`: the factory
never renames a Rex session. The user-level dotfiles hook does the same, so
with both installed the context appears twice; remove one.

`hooks.json` also ships one `agentStop` hook, `hooks/stop-hook.mjs`.
It blocks the end of a coordinator turn (`decision: "block"` with a `reason` the
model reads as its next prompt) when the run is not `finished` and either no
waiter is armed (the same check as `broker.mjs armed`) or `reconcile.mjs`
reports findings. A missing waiter blocks every time; findings block once per
turn (`stop_hook_active` allows the next stop), because some findings need the
user. Copilot ends the turn after 8 consecutive blocks. The hook cannot arm the
waiter or wake an idle agent; it only forces the model to do it. It runs in
every session of every user, so it is gated (`gate.mjs`): it does nothing
unless the project's owner lock (`<project>-factory.lock`, beside the factory
file) records the Copilot session in the hook payload (`sessionId`). The lock
holds `owner.json` with `copilot_session`; the older text file `owner`
(`session ID pane ID`) is still read. The payload has no agent name, so the
session ID is the only identity; no launcher has to set a variable. A session
with no lock, or another session's lock, is untouched.
`FACTORY_COORDINATOR=1` forces the hooks on for any session and
`FACTORY_COORDINATOR=0` forces them off. `reconcile.mjs` reports
`hooks-inactive` when the lock exists but the hooks would not run for the
session that runs it (no recorded session, another session, or `=0`). The
factory file comes from `FACTORY_FILE`, else `<owner.repo>-factory.json` from the
`origin` remote of the session cwd, in the state directory; with no file the
hook allows. It also allows on any error, a bad payload, or a reconcile
timeout (15 seconds).

Workers start with their brief in the launch command
(`copilot ... --model claude-sonnet-5.5 -i 'Read <brief> and do it.'`), so there is no fixed sleep and no
`rex send` for the first message; `rex send` is only for follow-ups to idle
workers. The planned role with `unknown` status is in the factory file before
launch, and the pane and window IDs are written right after it. The short gap
between them cannot be removed.

Every worker launch carries the same deny flags (the worker deny constant;
keep it identical to the one in the lifecycle skill's "Launch rules"). They
block `git stash` and every Rex pane, window, block, and session command, and
they win over `--yolo`:

```text
--deny-tool='shell(git stash)' --deny-tool='shell(rex window:*)' --deny-tool='shell(rex block:*)' --deny-tool='shell(rex session:*)' --deny-tool='shell(rex new:*)' --deny-tool='shell(rex run:*)' --deny-tool='shell(rex split:*)' --deny-tool='shell(rex send:*)' --deny-tool='shell(rex send-key:*)' --deny-tool='shell(rex kill:*)' --deny-tool='shell(rex do:*)' --deny-tool='shell(rex api:*)' --deny-tool='shell(rex focus:*)' --deny-tool='shell(rex zoom:*)' --deny-tool='shell(rex move:*)' --deny-tool='shell(rex swap:*)' --deny-tool='shell(rex resize:*)'
```

`hooks.json` also ships a `preToolUse` guard (`hooks/guard.mjs`) for the
coordinator. It uses the same gate as the stop hook (owner lock session, with
the `FACTORY_COORDINATOR` override), and it does nothing for any other session.
The hook denies, with a reason that names the
rule, the `task`, `read_agent`, `write_agent` and `run_dynamic_workflow` tools;
`edit`, `create` and `apply_patch` outside `~/.local/state/copilot-coordinator`,
`~/.local/state/copilot-factory`, the session directory and `$TMPDIR`; and bash
commands `gh pr merge`, `git merge` without `--ff-only`, `rex new`, `rex session
new|create|rename`, a `copilot` launch with `--autopilot` or without `--model
claude-sonnet-5.5`. Rules are one table in `guard.mjs`,
tested in `hooks/guard.test.cjs`. The hook matches the command text only, so it
catches model slips, not a deliberate bypass (`sh -c` is unwrapped; a launcher
script is not). It allows every other call and any call it cannot parse. The
script path comes from `PLUGIN_ROOT`; if no root variable is set, the hook
allows the call and prints a warning on stderr.

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
the primary checkout, and never uses `worktree.mjs`, a worktree, or a branch. It never
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
dashboard skips load and redraw on a 304; it binds `127.0.0.1` with no token
by default, and a non-loopback `--host` (for reaching the dashboard from
another device) requires a token (random, or `--token`) on every request,
checked in constant time, with a cookie (`HttpOnly; SameSite=Strict`, 30 days) set
after the first `?token=` load or after a `POST /login` from the login form, and
an `Authorization: Bearer` header also accepted. A browser page request without a
valid token gets the login form (401); other requests get a JSON 401, and the
dashboard reloads on a 401 so the form appears. The login redirect keeps a
same-origin path only, a wrong token waits 500 ms, and the bound Host is checked to
block DNS rebinding;
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

The dashboard task cards show one worker summary (`cardSummary` in
`factory-data.mjs`): the role matching the task state, else the newest by
`summary_at`. The coordinator mirrors each result's `summary` into the optional
`workers.<role>.summary` (at most 2000 characters) and `summary_at`; the
dashboard reads only the factory file.

The dashboard sidebar sorts factories with `compareFactories` in `factory-data.mjs`:
active with open tasks, then paused or blocked with open tasks, then nothing open,
then finished; ties go by name without case, then file. It shows them in sections
(`factorySection`): Active (open tasks, running, paused, or blocked), Idle (nothing
open), and Finished, with dimmer text; an empty section has no header, and the 1-9
shortcuts follow the visible order. The dashboard shows no run-status pill above the
flowchart, on any width. `paused`, `blocked`, and `finished` show in the Find work
panel note ("Scheduled rules do not run while the factory is ..."). The sidebar has a fixed width,
`clamp(240px, 22vw, 360px)`; neither a project name nor the selected item changes it (the selected
item changes only colors, never weight or border width). A name that does not fit loses its owner first, then
its start (`fitProjectLabel`); the full name stays in `title` and `aria-label`.
The dashboard opens task lists, and the read-only "Find work" rules and skipped
list, in one panel docked on the right edge, beside the flowchart (the
flowchart shrinks while it is open) and can move a task back or directly
to `resolved` with an operator comment. Manual resolution requires a non-merge
outcome; it does not merge or close GitHub items. Cmd+K or Ctrl+K opens a task
palette (`rankTasks` in `factory-data.mjs`) that docks the chosen task's list and
focuses its row; the shortcut is ignored while another dialog is open. The header
shows "Go to task" and "Refresh now" with an icon and text; at 700px wide or less
they are icon-only 44px buttons. The header has no freshness label. At that width the
sidebar gives way to a project dropdown (the sidebar list, same sort order) with a
settings button beside it. Resolved tasks with pending
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
The "Settings" item pinned at the bottom of the sidebar opens one settings dialog. It edits the optional
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
onto the new base (a task with a PR merges it instead), reruns affected checks on the combined code, and
refreshes head-specific evidence before landing. Prefer an existing repository
merge queue. For local-only tasks, use the current local default branch, not
`origin`; independent tasks stay parallel.

`archive.mjs clean FACTORY_FILE [--older-than 14d] [--run]` is the retention
tool for the state directory. It is a dry run unless `--run` is given. For tasks
resolved longer ago than the threshold (live or archived) it deletes their
`<project>-<task>-<role>-brief*.md`, `-result*.json` and `-instructions/`
artifacts, and never a file that an open task names, a task with pending
feedback, or anything modified in the last 24 hours. It reports files over
100 MB that no factory file names as `stale-large` and never deletes them.
Artifacts stay flat; grouping them under `<project>-tasks/<task>/` is a
documented follow-up. Tests are in `archive.test.cjs`.

PR watching goes through `skills/lifecycle/pr-watch.mjs`, which the factory
ships and workers call by absolute path (like `broker.mjs`). It makes one
GraphQL call per tick, prints one typed JSON event, and exits 3 on a rate limit
instead of sleeping. Run one watcher per PR; the review worker runs none. It is
a native watcher, so its own loop uses a timer and its tests never sleep or poll
(a fake `gh` is on `PATH`; tests never call GitHub). `session-metrics.mjs`
counts it under `gh_wait`.

Review workers use `cross-model-review`.
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
times, and "idle" means time between turns. The coordinator runs it before it
launches the improve worker, with `--active-since WINDOW_START` (every session
with an event in the window, including long-lived ones that started earlier,
counted for the window only), and passes the output file
`<project>-self-improve-metrics.json` in the brief; the worker's sandbox may not
read session logs, so it never runs the tool. Without `--active-since`, a long
session's totals are cumulative over its whole life.

The factory waits with `broker.mjs wait`. The broker keeps one
append-only JSONL log, `<owner.repo>-factory-events.jsonl` (mode 0600), beside
the factory file. Events are typed notifications (`task.moved`, `task.updated`,
`feedback.pending`, `budget.updated`, `limits.updated`, `lever.updated`, `worker.result`, `worker.blocked`, `pr.merged`; `rule.due` and `reconcile.due` are computed by
`wait --due` and never stored), each with a `source`. A cursor is a byte offset,
so no event is lost between two `wait` calls. `factory.mjs` emits after every
successful write (source `coordinator`, or `dashboard` for operator moves), and
the factory waits with `--exclude-source coordinator` so its own writes never
wake it. Workers write their result file atomically, then run
`broker.mjs emit worker.result` (or `worker.blocked`). `emit` validates before it
appends and exits 1 with a reason when it refuses: a `worker.result` needs
`data.result`, a JSON file in the state directory whose `task`, `role` and
`outcome` match the event, and a `complete` implementation result with `data.head`
needs the task's worktree at that head, and, for a task without a PR, descended
from `main`. After a PR merge, the
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
(`merged-worktree`: remove with `worktree.mjs delete NAME`, only if the run created it;
`delete` refuses a dirty or unmerged tree; a task with a PR also gets its squash-merged
worktree flagged, with the exact command that has `--merged-pr URL`, which verifies the
PR with `gh api`), open Rex windows of resolved tasks, finished rule workers
whose window is open or whose status is still `running` (`rule-worker-done`),
`running` workers whose window is not in the live Rex session
(`worker-missing`, plus `rex-session-missing` once when the session is gone;
the factory relaunches them in their existing worktrees, never creating or
renaming a session), a missing waiter (`no-waiter`), and an owner lock whose
session the coordinator hooks would not match (`hooks-inactive`). The
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
result notification changes. Run `node --test plugins/factory/hooks/*.test.cjs` for
the session, stop, and guard hooks.
