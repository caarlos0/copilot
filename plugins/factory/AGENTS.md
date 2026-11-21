# AGENTS.md: factory plugin

Plugin-specific rules. Repository-wide rules are in the root `AGENTS.md`.

## Factory

The factory coordinator never does work or investigation. It always delegates.
It can only accept work, create tasks, write briefs, start and monitor
workers, verify results, record state, merge verified worker branches, release
panes, and report. It never edits product files, investigates, scans, writes
fixes, or resolves a worker's code conflicts, even for a one-line change. If a
branch is not a fast-forward of the default branch, the coordinator sends it back
to a worker to run `git rebase main`. The coordinator never uses
the `task`, `read_agent` or `write_agent` tools for factory work. Every worker,
including backlog, discovery, and improve workers, is a Copilot session in a
Rex tab. Each worker has a brief, a result file, and `factory.mjs broker emit`. Keep this
rule the same in `agents/general.agent.md` and in the lifecycle skill's
"Delegate every task to workers" section.

`blocked` is only for a user decision or an outside action. Its `--blocker` JSON
carries a `class` (`user-decision`, `outside-action`, `external-wait`,
`ci-infra`, `approval`) and an `owner` (a GitHub login or `operator`); both are
optional, so old blockers stay valid. The dashboard shows them. The Blocked
box lists one row per class. It also lists "No class" for old blockers. It shows
zero counts, like the Resolved outcome rows. A click on a row filters the list
(`#blocked/<class>`, `none` for no class). A second click clears the filter, and
so does the box. A worker never waits
on another task or an unmerged branch. For a conflict, a missing dependency, or
a broken default branch, the worker incorporates the default branch (`git rebase main`
for a task without a PR; `git merge` for a task with a PR) and makes the small fix.
Alternatively, the coordinator creates a new task.
For a blocked task with a worker-fixable cause, the coordinator immediately sends
a follow-up (or relaunches). It verifies receipt by pane identity, then by a new
result or event.

A task without a PR keeps a linear history. Its worker runs `git rebase main`
(never merge main) before it reports a head. The factory lands the local
branch with `git merge --ff-only`, so it creates no merge commit. When the
default branch moves, the worker rebases again (see the landing queue below).
After every local `git merge --ff-only` landing, the coordinator runs
`node --test` at the repo root and records the result. If the default branch
fails its tests, the coordinator never runs `git reset` (a reset drops other
landed commits). It sends the worker a follow-up or creates a fix or revert task.
A task with a PR follows the root rule: the worker merges
the default branch into its branch with `git merge`, never rebases, and never force-pushes,
because a rebase disrupts reviewers and stacked PRs. GitHub mergeability and the
PR checks control the merge, so `emit` does not check that its head descends from
the default branch.

Standing worker rules: never use `git stash`, because the stash list is shared
by all worktrees. To compare against the base, use a scratch worktree or
`git diff > $TMPDIR/x.patch`. Tests that run git in a temp repo must ignore the
global git config (signing, hooks, templates). Workers use `claude-sonnet-5.5`
(`--model claude-sonnet-5.5` in the launch command). Use a larger model only
when the user asks for it. Two opus sessions caused 32% of spend.

Every implementation brief also carries the four standing cost lines from the
lifecycle skill's "Brief the workers". First, never poll: use no sleep loops and
no self-wake under 20 minutes, and wait with `factory.mjs pr-watch` or the blocking waiter.
Second, view a file before you edit it, and use edit, not create, for an existing
file. Third, give a default for every decision, and combine nudges into one message.
Fourth, save a `waiting` result at hand-off to review. Then the factory closes the
pane and starts a fresh worker for follow-ups. `improve.md` maps each line to the
metric it addresses.

Every implementation brief for a UI change also carries this line: "For a UI
change, when a browser is available, run `factory.mjs shot` and name the screenshot path in
the result, or save a partial result that says what was not seen."
`factory.mjs shot` serves a private copy of `factory.example.json` with
`factory.mjs serve` on a free port (never 8766). It runs headless Chrome or Edge at
`--widths` (default 1280 and 390) and writes `dashboard-<width>.png` to `--out`
(default `$TMPDIR`). Its test covers argument handling only. The macOS worker
sandbox denies the Mach bootstrap lookup that Chrome, Edge and WebKit need, so
no browser starts there. A worker in that sandbox saves a partial result.

`factory:general` is a thin agent that uses
`plugins/factory/skills/lifecycle/SKILL.md`. It preloads `lifecycle`, which
disables invocation by the model or the user. It also preloads `autonomy-dial` and
`progress-contract` from the external `lever@lever` plugin (`github/lever`).
Do not vendor Lever skills or templates. Factory owns panes and state. Lever
owns autonomy, spend, brief templates, PR shepherding, and review procedures.
The coordination plugin stays unchanged, and the reviewer handoff stays with
`coordination:review`.
The factory runs every worker in the Rex session where it started (`$REX_SESSION`).
It never creates or renames a Rex session. It records the session in the
root `rex_session` field. Only the factory manages Rex panes. Workers run
commands with their own shell tool. They never create, close, or type into Rex
windows, tabs, splits, or panes. The launch instructions carry this rule, and
release closes verified stray windows. The `REX_*` variables stay set for
workers. Implementation worktrees come from the local default branch.
`factory.mjs worktree create NAME` in the main checkout branches from
local `HEAD`, never from `origin`, so it keeps unpushed local commits. The helper
reads `worktreePathTemplate` from `$COPILOT_HOME/settings.json` and prints the
path and branch that the factory records. It needs no other tool.
`factory.mjs worker-name` prints each worker's `--name` as
`<Verb> <ref>: <summary>` (see "Launch rules" in the lifecycle skill). The
factory never formats a name by hand.

`hooks.json` ships a `sessionStart` hook that gives every session the Rex
terminal context (`rex __internal session-start`). It runs at every session
start where the plugin is enabled. It is silent unless `REX_SESSION` is set
and `rex` and `jq` exist. Keep `--feature-session-naming=false`: the factory
never renames a Rex session. The user-level dotfiles hook does the same, so
the context appears twice when you install both. Remove one.

`hooks.json` also ships one `agentStop` hook, `factory.mjs hook stop`.
It blocks the end of a coordinator turn when the run is not `finished` and either no
waiter is armed (the same check as `factory.mjs broker armed`) or `factory.mjs reconcile`
reports findings. The block is `decision: "block"` with a `reason`. The model
reads the `reason` as its next prompt. A missing waiter blocks every time.
Findings block once per turn (`stop_hook_active` allows the next stop), because
some findings need the user. Copilot ends the turn after 8 consecutive blocks.
The hook cannot arm the waiter or wake an idle agent. It only forces the model to
do these actions. The hook runs in every session of every user, so a gate
(`gate.mjs`) controls it. It does nothing
unless the project's owner lock (`<project>-factory.lock`, beside the factory
file) records the Copilot session in the hook payload (`sessionId`). The lock
holds `owner.json` with `copilot_session`. The hook still reads the older text
file `owner` (`session ID pane ID`). The payload has no agent name, so the
session ID is the only identity. No launcher must set a variable. The hook
ignores a session that has no lock or that has the lock of another session.
`FACTORY_COORDINATOR=1` forces the hooks on for any session, and
`FACTORY_COORDINATOR=0` forces them off. `factory.mjs reconcile` reports
`hooks-inactive` when the lock exists but the hooks would not run for the
session that runs it (no recorded session, another session, or `=0`). The
factory file comes from `FACTORY_FILE`. Otherwise it is
`<owner.repo>-factory.json` in the state directory, named from the
`origin` remote of the session cwd. If there is no file, the hook allows the
stop. It also allows the stop on any error, a bad payload, or a reconcile
timeout (15 seconds).

Every hook (`sessionStart` too) has a 25 second timeout. Each hook script runs
in about 0.1 second (Node start is nearly all of it). But Copilot counts the
time from its own scheduling. A busy host (many workers, 30 second
`session.eventLog.read` calls in its log) can delay a hook by more than 5 seconds.
Copilot skips a guard that times out. A `sessionStart` hook that times out shows
as failed, even when its output arrived. Keep the limit much higher than the real
cost.

Workers start with their brief in the launch command
(`copilot ... --model claude-sonnet-5.5 -i 'Read <brief> and do it.'`). So there
is no fixed sleep and no
`rex send` for the first message. Use `rex send` only for follow-ups to idle
workers. The factory file holds the planned role with `unknown` status before
launch. The factory writes the pane and window IDs immediately after the launch.
The short gap between these two writes cannot be removed.

Every worker launch also sets `FACTORY_TASK` (absent for a rule worker),
`FACTORY_ROLE` and `FACTORY_FILE` with `env` before `copilot`. The attention hook
reads them (see below).

`hooks.json` ships three hooks for `factory.mjs hook attention`: `notification`,
`permissionRequest`, and a second `preToolUse` entry. The `preToolUse` entry runs
the script only when the payload mentions `ask_user` (a shell `case`, so other
tool calls cost no Node start). The script does nothing, silently, and exits 0
on any error, unless the session belongs to the factory. A session belongs to the
factory when `FACTORY_TASK` or `FACTORY_ROLE` is set. Otherwise, the
payload `sessionId` must be the owner lock's session (the coordinator) or a
`workers.*.session` in the factory file. The factory file comes from
`FACTORY_FILE`. Otherwise it comes from the `origin` remote, like `gate.mjs`. A `notification`
(`permission_prompt` or `elicitation_dialog`) appends one `attention.requested`
event (source `attention`) with `factory.mjs broker emit`. In the event, `kind` is
`permission`, `sandbox-bypass` or `ask-user`. The `kind` is `sandbox-bypass` when
the message says sandbox, or when a fresh `permissionRequest` for
the same command had `requestSandboxBypass`. The `text` is the
message, plus the bypass reason, or the `ask_user` question with its enum
`options`. The event has `role` and `pane` (`REX_BLOCK`, else the file) when known.
The two observers only write a note in `$TMPDIR` (valid 30 seconds, used once).
Any other notification type (`new_inbox_message`, `shell_completed`, and so on)
is not a wait for the user. For these types the hook records nothing, and
`attention.mjs` skips `other` items that older logs hold. Tests
are in `hooks/attention.test.ts`. The payloads are in `hooks/fixtures/`.

Every worker launch carries the same deny flags (the worker deny constant).
Keep it identical to the one in the lifecycle skill's "Launch rules". The flags
block `git stash` and every Rex pane, window, block, and session command. They
override `--yolo`:

```text
--deny-tool='shell(git stash)' --deny-tool='shell(rex window:*)' --deny-tool='shell(rex block:*)' --deny-tool='shell(rex session:*)' --deny-tool='shell(rex new:*)' --deny-tool='shell(rex run:*)' --deny-tool='shell(rex split:*)' --deny-tool='shell(rex send:*)' --deny-tool='shell(rex send-key:*)' --deny-tool='shell(rex kill:*)' --deny-tool='shell(rex do:*)' --deny-tool='shell(rex api:*)' --deny-tool='shell(rex focus:*)' --deny-tool='shell(rex zoom:*)' --deny-tool='shell(rex move:*)' --deny-tool='shell(rex swap:*)' --deny-tool='shell(rex resize:*)'
```

Every worker launch also carries these flags after `--sandbox`, so reads of
session logs, other worktrees, and the state directory do not cause sandbox-bypass
prompts. The worktree root comes from `worktreePathTemplate`. The last path is
the factory state directory. Keep the flags identical to the lifecycle skill's
"Launch rules":

```text
--add-dir "$HOME/.copilot" --add-dir "$HOME/Developer/worktrees" --add-dir "<state directory>"
```

`hooks.json` also ships a `preToolUse` guard (`factory.mjs hook guard`) for the
coordinator. It uses the same gate as the stop hook (owner lock session, with
the `FACTORY_COORDINATOR` override). It does nothing for any other session.
The hook denies the following calls, with a reason that names the
rule: the `task`, `read_agent`, `write_agent` and `run_dynamic_workflow` tools;
`edit`, `create` and `apply_patch` outside `~/.local/state/copilot-coordinator`,
`~/.local/state/copilot-factory`, the session directory and `$TMPDIR`; and bash
commands `gh pr merge`, `git merge` without `--ff-only`, `rex new`, `rex session
new|create|rename`, a `copilot` launch with `--autopilot` or without `--model
claude-sonnet-5.5`. The guard holds the rules in one table.
`hooks/guard.test.ts` tests them. The hook matches the command text only, so it
catches model slips, not a deliberate bypass (the hook unwraps `sh -c`; it does
not unwrap a launcher script). It allows every other call and any call it cannot
parse. The script path comes from `PLUGIN_ROOT`. If no root variable is set, the
hook allows the call and prints a warning on stderr.

Every brief sets a write boundary. The worker's assigned worktree is the only
writable root. The result path and `$TMPDIR` are the only other writable
paths. Workers never create a worktree. They never switch or check out a branch in
another checkout. They never edit or commit on the primary checkout or default branch.
A brief never gives the primary checkout as the repo path of a writing worker.
If the cwd or branch of a worker differs from its brief, the worker writes a
`blocked` result and does not edit. Every brief tells the worker to read
`plugins/factory/AGENTS.md` before its first edit.

The investigation step never implements. Its only job is to validate and
hydrate a task before work starts. It checks the claim, finds related PRs, adds
context, and sets a verdict. Every task that needs work goes from `initial` to
`investigation` to `implementation`. A task with an existing PR can go directly
to `review`. The investigation worker is one-shot and read-only. It runs in
the primary checkout. It never uses `factory.mjs worktree`, a worktree, or a branch. It never
edits product files, commits, pushes, opens a PR, or fixes. Its brief says "do
not change anything" and forbids writes outside the result path and `$TMPDIR`.
A clear, small task still gets a quick read-only investigation. The investigation
confirms `verdict: implement` and hydrates the brief. Implementation work never runs
under an investigation worker record. `factory.mjs write` refuses an investigation
worker with `mode: continuous` or a `worktree`. It also refuses a worktree on a
task in `investigation`. Keep this rule the same in `agents/general.agent.md` and
in the lifecycle skill's "Investigation worker" section.

State is one `<owner.repo>-factory.json` (`factory/v1`) per project under
`~/.local/state/copilot-factory/` (or the legacy `~/.local/state/copilot-coordinator/`,
resolved per file). One agent owner holds the file, guarded by
`<project>-factory.lock`. Agent and dashboard writes share `factory.mjs write` and
its short-lived `<file>.write.lock`, which holds the owner PID. The writer clears
the lock of a dead owner. It also clears a lock with no PID after 10 minutes.
`factory.mjs write` validates the
state flow (`initial`, `investigation`, `implementation`, `review`, `blocked`,
`resolved`), keeps history, and replaces the file atomically. A task links a
GitHub issue, or has `issue: null` for work without one. An issue-less task
uses every state without a PR. Review covers its local branch `head`. A
local `git merge --ff-only` resolves it as `merged`, with the landed head SHA in
`details.merge_commit`. Tasks with an issue keep the PR flow. `factory-data.mjs`
holds the schema. The writer,
`factory.mjs migrate`, `factory.mjs serve` (port 8766, lists only `*-factory.json`), and
`dashboard.html` share it. `state-dir.mjs` resolves per file, not per directory.
A factory file can be in either directory, even when both exist. The new
directory wins, then the legacy one. If a file is in neither, the writer creates
it in the new directory. `factory.mjs serve` lists and serves the factories of both
directories (one entry for each name; the new one wins) and writes the file where
it lives. By default, it binds `127.0.0.1` with no token. A non-loopback `--host`
(to reach the dashboard from another device) requires a token on every request.
The token is `--token`, else the one saved with mode 0600 as `dashboard-token` in
the first state directory.
`factory.mjs migrate` reads each handoff the same way and writes the factory file to
the new directory. The lock, events log, waiter PID, archive, and sessions file
are beside the factory file, so they follow it. An explicit `--directory` means
only that directory. Nothing moves files out of the legacy
directory. `factory.mjs migrate` moves the implementer and coordinator handoffs
into the factory file. It refuses to run against a live legacy lock.

The factory file is the only task tracker. Create every task there before
launching its worker. Write the planned action with `factory.mjs write` before each
launch, result disposition, head change, merge, or release. Write the
observed result in the same turn, before the next action. If the writer refuses
a write, stop the work until you read the file again and reconcile the drift.
Never track task
state only in chat, session SQL, another board, or another file. At startup, at
every wake, and before each report, compare the file with `git worktree list`,
branches merged into the default branch, Rex panes, PRs, and worker results.
Repair drift through `factory.mjs write`, including local issue-less merges with
`resolution: merged` and the full merge SHA in `details.merge_commit`.

The dashboard task cards show one worker summary (`cardSummary` in
`factory-data.mjs`). It shows the role that matches the task state, else the newest role by
`summary_at`. The coordinator mirrors each result's `summary` into the optional
`workers.<role>.summary` (at most 2000 characters) and `summary_at`. The
dashboard reads only the factory file. A `--workers` write that sets a worker
`running` with a different `pane` or `window` (a relaunch) first drops its stored
`session`, `summary` and `summary_at`. `result` stays, because it is the planned filename.
A worker's `result` link (history step, Find work) opens a popup with the result file,
pretty-printed and highlighted (`highlightText`, built with `textContent`). The card summary has no result link. A worker's `brief` link opens the same popup
with the brief rendered as GitHub-style Markdown (`renderMarkdown`). `marked` (GFM) parses the brief,
and DOMPurify always sanitizes the output (http(s) links only; raw HTML shows as text).
`linkify()` then runs on the text nodes, never inside code or existing links. Every link gets
`target="_blank" rel="noopener noreferrer"`. Both libraries are the npm packages `marked` and `dompurify` (normal dependencies in
`plugins/factory/package.json`). `dashboard.ts` re-exports them with `factory-data.ts`. `bun run build` (in `plugins/factory`) bundles and minifies it to
`skills/lifecycle/dashboard.mjs`, with the full licence text of both packages in its header.
The dashboard imports `marked`, `DOMPurify` and the `factory-data` names from it. `factory.mjs serve` serves it at
`/dashboard.mjs` from the same origin. There is no `/factory-data.mjs` route, no CDN and no `vendor/` route. Consumers
need no `node_modules`. To update the libraries, run `bun update marked dompurify` in
`plugins/factory` and rebuild.
The test DOM uses the real `marked` and stubs DOMPurify. Both popups load the
file through `/api/artifact`, so the access checks of the server apply. The coordinator records only
`result` in a worker record, so `factory.mjs serve` finds the brief of each task worker by the first of
these names whose file exists: a recorded `brief`, `<project>-<task>-<role>-brief.md`, then the brief of
the task itself, `briefs/<task>.md`. It sends the names whose file exists as
`briefs` (`{task: {role: name}}`, in the ETag). `/api/artifact` serves the same names. The
brief of the task itself, `briefs/<task>.md` in the state directory, is also in the map under the role
`task`, so a task with no worker record (most resolved tasks) has its link. It sits on the first
history step. This is the only folder that the server reads. A link out of it is refused. The
dashboard shows the `brief` link, on every task state, only for a name in that map. A brief that
`factory.mjs archive clean` deleted has no link. The popup shows only the
title, a close button and the document. The links keep their `href`, so a modified click still
opens the raw file in a new tab. A task card has no "Task details" section. The history steps
carry the worker lines (`stepExtras`). Each worker sits on the latest step of its role's state
(else the last step) with its status, name, usage,
`brief` and `result`. The latest review step carries the merge decision (open tasks with a PR).
The latest implementation step carries the "Copy worktree path" link (only while the task is not
`resolved`). The copy link is a plain text link that shows "Copied" for a short time. The
"Evidence and task details" link under the history opens the result popup with the task's
`details` from the factory file.

The chip row of a task card shows usage. The chips are "Elapsed" (first history entry to
`resolved`, or live while the task is open), "Cost: $N.NN" (or "Tokens: ..." when a log has no
credits), one chip per model, and "Active" (first to last session event). The tooltip of the cost
chip has the AIC value and lists each worker role. Each worker line on a history step shows the
model chip and the cost chip of that worker. The tooltip of that cost chip has the AIC value. An
unknown value shows no chip. `usage.mjs` computes the usage on the server for
`/api/factory` (`usage`, keyed by task ID, in the ETag). It reads only the logs of the session IDs
in the factory file. The logs are in `$FACTORY_SESSION_STATE` (default
`~/.copilot/session-state`). It reads them through `session-metrics.mjs` `measureFile` (streamed,
no log over 512 MiB, four logs at a time). It caches by file mtime and size (at most 1024 logs, and
it drops the oldest first). It does not read a changing log again within 30 seconds. Credits are
`totalNanoAiu` of the `session.usage_record` events divided by 1e9 (verified: the log's
`costPerBatch` rates equal GitHub's published per-token prices at 1 AI credit = $0.01). `usd` is
credits times `usdPerCredit` in `usage.mjs`. A log without credits shows tokens instead. A task
total shows credits only when every session has credits. A missing or unreadable session is `null`
and shows nothing. Only numbers and model names leave the module.

The dashboard sorts and groups factories in the sidebar with `compareFactories`
and `factorySection` in `factory-data.mjs`. `paused`, `blocked`, and `finished`
show in the Find work panel note ("Scheduled rules do not run while the factory
is ..."). The dashboard opens task lists, and the read-only "Find work" rules and
skipped list, in one panel docked on the right edge. The dashboard can move a task back or
directly to `resolved` with an operator comment. Manual resolution requires a
non-merge outcome. It does not merge or close GitHub items. The factory does not archive resolved
tasks with pending feedback. Archived tasks go to
`<owner.repo>-factory-archive/YYYY-MM-DD.json`. The factory never deletes them. They return
only through `factory.mjs write --restore` after the user agrees. Task
`revision` protects against stale reads. Old files start at zero.
Comments remain in source-tagged history. `feedback` tracks the latest ID and
acknowledgement. Reconcile all pending comments before worker results. Include
the current feedback ID in worker briefs and results. Acknowledge only after
the workers have a new brief or are parked. CLI writes after dashboard feedback need
`--expected-revision` plus `--ack-feedback` or `--feedback-id`.
The factory waits on dashboard events even when all workers are blocked.
Dashboard changes do not stop workers, resume a paused run, or grant authority.
The "Settings" item pinned at the bottom of the sidebar opens one settings dialog. It edits the optional
root `budget.max_parallel_workers` (the most workers that run at once over all
roles; absent means no total cap; a new file gets 10), `limits.investigation`
and `limits.implementation` (integers 1 to 100), and the optional root `lever`
ceilings `spend` (`standard`, `high`, `max`) and `autonomy_cap` (`L0` to `L5`).
It saves through `POST /api/settings` and the shared writer. For each changed field, a write
carries the value that the browser saw (`--expected-budget`,
`--expected-limits`, `--expected-lever`). A different current value is a
conflict for that field. It emits `budget.updated`, `limits.updated`, and
`lever.updated` with source `dashboard`. The coordinator reads these from the
file and never exceeds the budget or a ceiling. A lower value stops no worker. Lever values are
ceilings only. They narrow the resolved dials and never raise them. `null`
means no ceiling. The dashboard never writes grants or Lever's dials files.

Implementation workers use `pr-shepherd` and are the sole landing writers.
They run `autonomy-dial`'s `may_merge` before every landing attempt. There is no
extra per-head approval when a resolved grant covers the landing. PR comments never
raise authority. Store grant provenance and spend in `details.lever`. Store the
head-specific decision in `merge` with `source: "lever"`. A new head clears the
decision, not the standing grant. Legacy `comment` and `factory-session`
records remain readable, but they are not authority on recovery.

When task file lists overlap, record the validated default-branch SHA of each task
in `details.validated_base_sha`. After one task lands, the remaining worker rebases
onto the new base (a task with a PR merges the base instead). Then it runs the affected checks
again on the combined code and
refreshes the head-specific evidence before landing. Landing queue: overlapping
tasks land one at a time. After each landing, the factory sends the "main moved,
rebase" follow-up only to the task that lands next, not to every waiting
worker. This replaces "one follow-up per move" for queued workers. Prefer an existing repository
merge queue. For local-only tasks, use the current local default branch, not
`origin`. Independent tasks stay parallel.

`factory.mjs archive clean FACTORY_FILE [--older-than 14d] [--run]` is the retention
tool for the state directory. It is a dry run unless you give `--run`. For tasks
that resolved longer ago than the threshold (live or archived), it deletes their
`<project>-<task>-<role>-brief*.md`, `-result*.json` and `-instructions/`
artifacts. It never deletes a file that an open task names, a task with pending
feedback, or anything that changed in the last 24 hours. It also deletes, by file age
alone (the same threshold), the `<project>-<rule>-brief*.md` and
`<project>-<rule>-result*.json` files of each rule whose worker is not `running`.
It also deletes worker scratch files (`completion<N>…`, `discovery-…`/`discovery<N>…`, `queue-…`; `.json` and `.txt`
only, no directories). It never touches a file that an open task names or a rule with a
running worker. The result has `counts` per category (`task`, `rule`, `worker`).
It reports files over
100 MB that no factory file names as `stale-large` and never deletes them.
Artifacts stay flat. Grouping them under `<project>-tasks/<task>/` is a
documented follow-up. Tests are in `archive.test.ts`.

PR watching goes through `factory.mjs pr-watch`. The factory
ships it, and workers call it by absolute path (like `factory.mjs broker`). It makes one
GraphQL call per tick (one more per extra page of 100 checks or review threads).
A page that fails is an error, never a pass. It prints one typed JSON event. It exits 3 on a rate limit
instead of sleeping. On github.com it keeps one `gh event listen --follow` child
only as a wake-up signal (every wake is the same GraphQL read, with a 5 minute
safety check). If that child ends, it polls on the interval, with no retry.
Run one watcher per PR. The review worker runs none. It is
a native watcher, so its own loop uses a timer, and its tests never sleep or poll
(a fake `gh` is on `PATH`; tests never call GitHub). `factory.mjs session-metrics`
counts it under `gh_wait`.

Review workers use `cross-model-review`.
Review depth follows the shared spend budget. A clean precision result is not
a GitHub approval, and `review` state can have no optional model reviewer.
Do not start a second Lever delivery coordinator, cloud runner, schedule,
or autopilot only because the factory is running.

The producer ("Find work") is not a task state. It feeds `initial` from three
sources: user links, `search` rules, and `backlog` rules (a one-shot read-only
worker that uses `keep-the-pool-full`). A PR that the user gives for review skips
`initial`. The factory creates the task in `review` with `--pr` and starts a review worker
at once (`initial` to `review` is allowed only with a PR). A rule with
`every` runs on a schedule only
while the factory is active and running. `factory.mjs broker wait --due` returns a
`rule.due` event when a rule is due. The factory stamps `--rule ID --ran` before it
dispatches. The `ignored` list holds skipped archive matches. The dashboard
shows rules and skipped work read-only.

An `improve` rule is maintenance, not work finding. Its one-shot, read-only
worker follows `improve.md` and Lever's `run-health-review`, and proposes at
most one change. The factory does not ask in chat. It emits `improve.proposed`
(source `improve`). The user accepts or declines in the "Waiting
for you" list of the dashboard. The factory applies `rule` and `limit` changes only after
`improve.decided`, and never edits plugin files. `factory.mjs write` keeps
`<owner.repo>-factory-sessions.jsonl` (IDs, roles, task or rule names; mode 0600)
from `--session` and worker records. `factory.mjs session-metrics` reads the `events.jsonl` of those sessions
and prints counts only, never content. It cannot measure tool run
times, and "idle" means time between turns. The coordinator runs it before it
starts the improve worker, with `--active-since WINDOW_START`. This option counts every session
with an event in the window, including long-lived sessions that started earlier,
for the window only. The coordinator passes the output file
`<project>-self-improve-metrics.json` in the brief. The sandbox of the worker may not
read session logs, so the worker never runs the tool. Without `--active-since`, the
totals of a long session are cumulative over its whole life.

The factory waits with `factory.mjs broker wait`. The broker keeps one
append-only JSONL log, `<owner.repo>-factory-events.jsonl` (mode 0600), beside
the factory file. Events are typed notifications (`task.moved`, `task.updated`,
`feedback.pending`, `budget.updated`, `limits.updated`, `lever.updated`, `worker.result`, `worker.blocked`, `pr.merged`, `attention.requested`, `attention.resolved`, `improve.proposed`, `improve.decided`; `rule.due` and `reconcile.due` are computed by
`wait --due` and never stored), each with a `source`. A cursor is a byte offset,
so no event is lost between two `wait` calls. `factory.mjs write` emits after every
successful write (source `coordinator`, or `dashboard` for operator moves). The
factory waits with `--exclude-source coordinator --exclude-source attention --exclude-source improve`.
So its own writes, its `improve.proposed` events, and the attention events never wake it. Attention events have no task.
Hooks emit them with source `attention` when a session waits for the user. `improve.decided`
(source `dashboard`) always wakes the factory. Workers write their result file atomically, then run
`factory.mjs broker emit worker.result` (or `worker.blocked`). `emit` validates before it
appends. It exits 1 with a reason when it refuses. A `worker.result` needs
`data.result`, a JSON file in the state directory whose `task`, `role` and
`outcome` match the event. A `complete` implementation result with `data.head`
needs the worktree of the task at that head with no uncommitted changes. For a task without a PR, the head must also descend
from the default branch (`origin/HEAD`, else a local `main` or `master`). After a PR merge, the
implementation worker also emits `pr.merged`, a hint. The factory verifies the
merge on GitHub, resolves the task, and releases its panes and worktree. `factory.mjs reconcile`
stays the backstop for a missed event. While the run is
`active`, `wait --due` returns `reconcile.due` every 5 minutes per waiter, so the
factory runs `factory.mjs reconcile` even when no event arrives. The factory JSON stays the
only task tracker, and the result files stay evidence. Events are only
notifications and the worker-to-factory channel. The factory must arm
`wait` again immediately after it handles events. A failed
emit never fails a state write. `factory.mjs reconcile` catches whatever an event
missed.

Every turn of a non-finished factory ends with exactly one armed `factory.mjs broker
wait` (async bash, latest cursor). This applies after a wake, a merge, a test run, a tool
completion, and a user message alike. In a turn with a long step, arm it first, not last.
`wait` records its PID in `<owner.repo>-factory-waiter.pid` beside
the factory file and removes it on exit. A second `wait` for the same factory
is refused with exit 1 unless the first PID is dead, or no longer belongs to a
`factory.mjs broker wait` process (a recycled PID; checked with `ps -o ppid=,command=`). A
live PID counts as the waiter when `ps` cannot run, as in some sandboxes. An orphaned
waiter (ppid 1, its parent gone) is not armed either. Nobody reads its output, so its
wake never reaches the agent. `wait` itself exits 2 when stdout is a file or `/dev/null`.
The guard rule `waiter-async-bash` denies a bash `factory.mjs broker wait` with `&`, `nohup`,
`setsid` or a redirect. The
file stays a bare PID. `factory.mjs broker armed FILE`
exits 0 when a waiter is alive and 1 otherwise. `factory.mjs reconcile` reports
`no-waiter` while the run is `active` or a task is open. Keep this rule in
sync with "Receive worker events" in the lifecycle skill.

The skill must not depend on files in the coordination plugin.
`factory.mjs serve` repeats the small state-directory confinement code of the coordinator
server on purpose. The two plugins load independently.

`factory.mjs reconcile` is a sweep that prints JSON findings and changes only the events
log. It reads Rex with `--autostart=false` and a 10 second timeout, so a sweep never starts a Rex server. It appends a missing `attention.resolved` event (source `reconcile`, with a
`reason`) for an attention item that `attention.mjs` finds resolved. It reports complete results
newer than their task. It reports open issue-less task branches ahead of the default
branch. It reports clean worktrees of merged tasks whose HEAD is in the default branch
(`merged-worktree`). Remove such a worktree with `factory.mjs worktree delete NAME`, only if the run created it.
`delete` refuses a dirty or unmerged tree. A task with a PR also gets its squash-merged
worktree flagged. The finding has the exact command, which has `--merged-pr URL` and verifies the
PR with `gh api`. It reports open Rex windows of resolved tasks. It reports finished rule workers
whose window is open or whose status is still `running` (`rule-worker-done`). It reports
`running` workers whose window is not in the live Rex session
(`worker-missing`, plus `rex-session-missing` once when the session is gone).
The factory relaunches these workers in their existing worktrees. It never creates or
renames a session. It reports `running` workers of resolved tasks (`stale-running`, with the
`factory.mjs write` fix command). The writer sets every worker of a task to `closed` when the task
moves to `resolved`, unless the write sets a status. It reports tasks that hold one piece of work
(`duplicate-task`). Two tasks are duplicates when the issue or PR of one task is in the `issue`, `pr` or `links` of the other task.
They are also duplicates when `gh pr view --json closingIssuesReferences` and a `Fixes #N` in the body show that an open PR task
closes the issue of the other task. The sweep skips this `gh` check without error when `gh` fails. The finding names `keep`,
`merge` and the `factory.mjs write --merge-task KEEP --from OTHER` command. This command resolves the
other task as `duplicate` with `details.merged_into` and moves its issue, PR and links. It
refuses two running workers and merged tasks. `factory.mjs write` also refuses a new task whose
issue or PR is in the `links` of another open task. It reports a task blocked longer than
`--blocked-after` (default 24h; `stale-blocked`, which names its blocker class and owner).
It reports an attention item open longer than `--attention-after` (default 30m;
`attention-stale`, which names task, kind, text and pane). It reports a `running` worker whose session log
ends with an `assistant.turn_end` over 10 minutes old and that has no result file newer than
its start (`worker-quiet`, which names task, role and idle minutes). The sweep reads the last
256 KiB of the log with `lastEvent` of `attention.ts`. It reports a decided `improve` proposal whose result file
still has a `change` and no `decision` (`improve-decided-unapplied`). An undecided proposal never
produces a finding. It reports a missing waiter (`no-waiter`). It reports an owner lock whose
session the coordinator hooks would not match (`hooks-inactive`). The
factory runs the sweep at startup, on every wake and user message, and before every
report. So a missed waiter wake cannot leave finished work unmerged. The factory arms the waiter
again after each wake or user message. It takes `factory.mjs broker cursor` and arms
the waiter before the startup sweep. Closing the panes of a task belongs to the step that records
`resolved`.

`attention.mjs` (`openAttention(file)`, shared by reconcile and the dashboard
server) returns the open attention items. An open item is an `attention.requested` event with no later
`attention.resolved` event for its session. It has the task title when known. The function removes an item when a signal
resolves it. One signal is the session log
(`$FACTORY_SESSION_STATE`, default `~/.copilot/session-state/<session>/events.jsonl`):
it shows `permission.completed` or the end of an `ask_user` call after the request.
Logs reach 500 MB, so the function reads the last 256 KiB by byte offset. It reads
further back, up to 64 MiB, until it reaches an event from before the request. A second signal is that the
pane of the item is in no Rex session (`rex ls -q --short=false`, then `rex block ls -s SESSION -q
--short=false` for each). The function skips this signal when Rex fails or lists nothing. Rex resolves a block ID only
inside one session, `$REX_SESSION` or else the default. So `block ls -A` and a bare `-b BLOCK` cannot
reach a pane of another session. An open item carries the `rex_session` that holds its pane. A third signal is that the item is
over 24 hours old. `resolveAttention(file, { source })` also records the
`attention.resolved` event for each session that a signal closes. Reconcile calls it
(source `reconcile`). The dashboard server also calls it (source `attention`, on every
`/api/factory` read, one scan per file at a time). The server reuses a scan for at most 60 seconds while the events
log and the logs of the waiting sessions keep their size and mtime. So an item clears without
waiting for the coordinator to wake. The coordinator never answers an attention
item, never types into its pane, never wakes on it, and reports `attention-stale`
once. Only the user answers, in the pane or with a click in the dashboard.

`/api/factory` adds `attention`
(oldest first; `id` (the request event), `session`, `kind`, `text`, `options`, `role`, `pane`, `task`, `at`)
from `openAttention`. The ETag covers it, so an item that appears or closes
refreshes the browser even when the factory file does not change. The header has a
badge with the count (hidden at 0). The page title gets a `(N) ` prefix. The badge
opens the "Waiting for you" panel (`#attention`) in the right dock. The panel lists the oldest 20
rows: age, kind, text, options, task and role. It does not show the pane ID or any Rex command, and
there is no copy button. Rex registers a `rex` URL
scheme, but the app documents no pane-focus URL, so there is no `rex://` link.
All text is data, set with `textContent`. The dashboard makes no sound or notification.

Only an `ask-user` item with options gets one button per option. Every other item
lists its options as text. The hook records `options`
only for an `ask_user` form with one enum field, so the index of a button is the row
of the form. A click sends `POST /api/attention/answer?file=` with `{id, index}`
(same-origin JSON like the other writes). The server looks the item up among the
pending items by `id`, so it refuses a prompt that closed or was replaced (409). It
also refuses an item without options or without a plain block `pane`,
a pane that no Rex session lists, and an index outside the options. Then it runs
`rex --autostart=false send-key -s SESSION -b PANE down... enter` (`index` times Down, then
Enter) with an argument array, never a shell. An `ask_user` form has no number keys. Down
moves the highlight from the first row, and Enter submits it. Permission and sandbox-bypass
prompts get no buttons. Their rows (for example "approve for the rest of the session")
depend on runtime state that the hook cannot see, and a wrong digit could grant a wider approval.
The row stays until the session log, the pane, or the clock resolves it. Its buttons stay
disabled meanwhile, so one click sends one answer. The coordinator still never answers.

The same panel lists proposed `improve` changes, oldest first, before the attention
rows, and the badge counts them too. `proposals.mjs` (`scanProposals(file)`) reads
`improve.proposed` and `improve.decided` from the events log. The first decision per
`proposal_id` wins, and a proposal never expires. The `/api/factory` payload has
`proposals` (`id`, `rule`, `kind`, `title`, `evidence`, `recommended`, `result`, `at`),
and its ETag covers them. A row has the title, kind, age, evidence, and Accept and
Decline buttons (the recommended button has a label that says so). A click sends
`POST /api/improve/decide?file=` with `{proposal_id, decision: "accepted"|"declined", note?}`
(same-origin JSON). The server appends `improve.decided` (source `dashboard`) once.
A repeat or concurrent click records nothing (`recorded: false`), a bad body gets 400,
and an unknown proposal gets 404. The decision wakes the factory, which applies it.

On every wake, drain all actionable tasks and reconcile the results and worktrees.
Fill free worker slots before waiting. Run enabled search and backlog rules
when the queue is empty and capacity is free. Keep one waiter armed unless the
run is truly finished. Never mark the run finished while a task, result, worktree,
or scheduled rule remains actionable.

## Generated modules

`default-branch`, `state-dir`, `worker-name`, `gate`, `proposals`, `sessions`,
`usage`, `session-metrics`, `shot`, `archive`, `attention`, `migrate`,
`reconcile`, `pr-watch`, `worktree`, `factory-data`, `factory`, `tasks`, `conflict`, `broker` and
`serve` in
`skills/lifecycle/`, and `guard`, `attention` and `stop-hook` in `hooks/`, are
TypeScript, checked with `strict` on. Edit the `.ts`, run `bun run build` in `plugins/factory`, and
commit the `.ts` and the generated `.mjs` together. The other modules are still
hand-written `.mjs`. A hook bundle imports its siblings (`gate.mjs`, `broker.mjs`)
as external `.mjs` files. `attention` loads `broker.mjs` lazily, so a hook
that exits early pays no start cost for it. `stop-hook` and `serve` read
`import.meta.url` to find their files (`skills/lifecycle/` for `stop-hook`;
`dashboard.html` is served from `skills/lifecycle/` beside `serve.mjs`). Both stay
valid because a bundle sits at the path of its source. `dashboard.html` is a
static asset, not TypeScript. `dashboard.ts` is the browser entry. `scripts/build.ts`
bundles it for the browser with `factory-data`, `marked` and `dompurify` inlined (see the brief popup above).
`factory-data.ts` exports the `factory/v1` types (`Factory`,
`Task`, `Worker`, and the others). `factory-data.mjs` stays, because the Node
bundles import it. The dashboard loads only `dashboard.mjs` in the browser. So
`factory-data.ts` and the other sources of `dashboard.ts` must not import `node:` modules.

`factory.ts` is a dispatcher: `factory.mjs COMMAND ARGS`. It loads the module of
each command with `await import()` only when the command runs. The commands are
`write` (the writer, in `tasks.ts`), `broker`, `reconcile`, `serve`, `worktree`,
`worker-name`, `shot`, `archive`, `session-metrics`, `migrate` and `pr-watch`.
`hook guard|attention|stop` runs a hook. Each module exports `main(argv)`. If the
first argument is not a command, `factory.mjs FILE ARGS` runs `write`, as the old
writer did. Hooks, docs, usage text and tests call `factory.mjs`. The old bundles
stay for now, but nothing runs them. `serve.mjs` imports `update` and `ConflictError`
from it, so `factory.mjs` exports both (`factory.d.mts` has their types). `update`
loads the writer when it is first called. The build of `factory.ts` bundles the
`.ts` source of each `.mjs` import, so the file does not need its siblings. It
removes the final `if (process.argv[1] ...)` guard of every module, because
inside `factory.mjs` the guard of each module would be true. The waiter check of
`broker.ts` accepts `broker.mjs wait` and `factory.mjs broker wait`.
`dispatcher.test.ts` runs every command and hook.

## Validation

Run `node --test plugins/factory/skills/lifecycle/*.test.ts` from the
repository root for factory data, writer, migration, server, dashboard, and
result notification changes. Run `node --test plugins/factory/hooks/*.test.ts` for
the session, stop, and guard hooks.
