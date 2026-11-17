# AGENTS.md

Personal Copilot agents and reusable skills. Keep this file current when
structure or workflows change.

## Layout

- `.github/plugin/marketplace.json` exposes seven plugins under `plugins/`:
  coding, security, fitness, terminals, coordination, factory, and home. Keep each
  marketplace version in sync with its plugin's `plugin.json`.
- Each plugin uses the supported legacy Copilot format with default `agents/`
  and `skills/` locations. Include its own copy of `LICENSE.md`.
- `Taskfile.yml` provides `task release:<plugin>`. From a clean `main`, it uses
  `svu next` scoped to that plugin's tags and directory, updates only its manifest
  and marketplace entry, creates a signed-off release commit and annotated
  `<plugin>/v<version>` tag, and pushes both atomically.
- `plugins/<plugin>/agents/*.agent.md` defines agent roles and model choices.
  Keep roles distinct and put reusable procedures in skills.
- `plugins/<plugin>/skills/<name>/SKILL.md` contains reusable procedures.
  Keep supporting scripts, references, and assets beside the skill.
- Machine settings and personal instructions remain in `caarlos0/dotfiles`.
  Do not add them to the plugin or assume this file is loaded by consumers.

## Conventions

- Use Conventional Commits with scope and explicit sign-off (`git commit -s`).
  Wait for an explicit commit request. Integrate upstream with merge, not rebase.
- Use short agent and skill names within their plugin namespace, such as
  `coding:simplifier`, `coding:review`, or `security:engineer`. Do not repeat
  code context already supplied by the namespace. Keep the shared `coordinator`
  skill name. Update paths, launchers, references, and preloads
  together when renaming entries. Preserve preload behavior.
  Skill preload names remain unqualified. `i-have-adhd` is an external skill;
  do not vendor it.
- The `caarlos0` agent routes bounded research to `scout` and substantial
  decision checkpoints to `advisor`. Their models live in agent frontmatter.
- GitHub CLI procedures live in the coding plugin's `gh-cli` skill. Use native
  required-check fail-fast watching for CI, `gh wait` for PR changes or
  default-branch commits, and `gh wait --merge` for completed merges.
  Do not add sleep-and-poll loops.
- Review policy lives in the coding plugin's `review` skill.
  Assess need and solution placement before implementation details.
- Resolve bundled assets relative to the loaded skill directory, not
  `~/.copilot/skills/` or a checkout path.
- Keep worker and subagent file discovery inside their assigned cwd and its
  descendants. Do not search parent directories or sibling worktrees for
  instructions, agents, or skills. Pass this boundary in delegated prompts;
  external task artifacts and loaded skill assets use their exact paths.

## Coordinators

`coordination:general`, `coordination:implement`, and `coordination:review` are
thin agents over `plugins/coordination/skills/coordinator/SKILL.md`. It owns pane
operations, durable briefs/results, monitoring, recovery, and cleanup.
Reviews use Rex session `reviews`; implementations use `work`.
Rex and an available session are required. Rex installs its own skill in
`~/.agents/skills/`, which Copilot discovers; do not vendor it.
Coordinators and workers preserve shared Rex session names. Every worker loads
this rule through task-specific startup instructions before its first prompt;
task titles name Copilot sessions and Rex tabs only.

The skill disables model/user invocation; agents preload it through `skills:`.
Each project has one writer per role and a persistent `<project>-reviewer.json`,
`<project>-implementer.json`, or `<project>-coordinator.json` under
`~/.local/state/copilot-coordinator/`. The board reads that same handoff.
Workers atomically save cumulative results. The bundled `wait.mjs` notifies
unscheduled coordinators of content changes without a state-polling loop.
Scheduled passes remain finite; general one-shot workers do not watch GitHub.

The skill ships `board.html`, `handoff.example.json`, and a dependency-free
loopback server. Run `node serve.mjs` from the resolved coordinator skill
directory, or use Bun. Use one server for all runs; do not generate HTML per run.
Shared JSON validation lives beside the skill in `board-data.mjs`.
Coordinators must write handoffs with the bundled `handoff.mjs` flags. It
validates the complete state and atomically replaces the file. The handoff
stores its project once; tasks merge by ID and preserve unfinished work. Adding
a new task removes existing `done` tasks last updated more than seven days ago,
without deleting artifact files. Keep the project/role owner lock while using
it. Workers still write their own cumulative result files.
Task `blocker` text is valid only with `blocked` status; clear it
when the status changes. Store all known issue/PR URLs in task `links`; the board
shows them and the legacy `pr` field as `#<number>` links.

Worker Copilot sessions and Rex tabs share the issue/PR title, or a descriptive
title from the prompt. Shorten to 100 characters and pass `--name` as one literal
quoted argument for direct Copilot launches. PR reviews run `review -k` for the
authenticated user's PRs and `review` for other authors. Review wrappers load
task briefs through startup custom instructions; preserve their generated
Copilot name until it can be renamed at an idle prompt. The user's review panes
and implementation panes stay through merge; other authors' review panes close
after verified results. Blocked retained panes stay open. Waiting does not
grant merge authority. Worktree removal is separate and preserves reused
worktrees and unfinished work.

## Factory

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
root `rex_session` field.

State is one `<owner.repo>-factory.json` (`factory/v1`) per project under
`~/.local/state/copilot-coordinator/`, with one agent owner guarded by
`<project>-factory.lock`. Agent and dashboard writes share `factory.mjs` and
its short-lived `<file>.write.lock`. It validates the
state flow (`initial`, `investigation`, `implementation`, `review`, `blocked`,
`resolved`), keeps history, and replaces the file atomically. Every task has a
GitHub issue. `factory-data.mjs` holds the schema and is shared by the writer,
`migrate.mjs`, `serve.mjs` (port 8766, lists only `*-factory.json`), and
`dashboard.html`. `migrate.mjs` moves the implementer and coordinator handoffs
into the factory file. It refuses to run against a live legacy lock.

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
The factory waiter watches its state file even when all workers are blocked.
Dashboard changes do not stop workers, resume a paused run, or grant authority.

Implementation workers use `pr-shepherd` and are the sole landing writers.
They run `autonomy-dial`'s `may_merge` before every landing attempt. There is no
extra per-head approval when a resolved grant covers it; PR comments never
raise authority. Store grant provenance and spend in `details.lever`, and the
head-specific decision in `merge` with `source: "lever"`. New heads clear the
decision, not the standing grant. Legacy `comment` and `factory-session`
records remain readable but are not authority on recovery.

Review workers use `cross-model-review`, not the local `review` wrapper.
Review depth follows the shared spend budget. A clean precision result is not
a GitHub approval, and `review` state can have no optional model reviewer.
Do not start a second Lever delivery coordinator, cloud runner, schedule,
or autopilot merely because factory is running.

The producer ("Find work") is not a task state. It feeds `initial` from three
sources: user links, `search` rules, and `backlog` rules (a one-shot read-only
worker using `keep-the-pool-full`). A rule with `every` runs on a schedule only
while the factory is active and running; `wait.mjs --due FACTORY_FILE` wakes the
factory when one is due. The factory stamps `--rule ID --ran` before it
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

The skill bundles its own copy of the coordinator's `wait.mjs` and tests for
result notifications; it must not depend on files in the coordination plugin.
The factory copy adds `--due`. Without it, keep the two copies behaviorally
aligned.
`serve.mjs` repeats the small state-directory confinement code of the coordinator
server on purpose: the two plugins load independently.

## Validation

Load local changes with `copilot --plugin-dir /path/to/copilot/plugins/coding`
in a new session. Avoid also loading an installed copy.

Run `node --test plugins/coordination/skills/coordinator/board.test.cjs`
for board changes,
`node --test plugins/coordination/skills/coordinator/handoff.test.cjs`
for handoff writes,
`node --test plugins/coordination/skills/coordinator/wait.test.cjs`
for result notification changes, and
`node --test plugins/factory/skills/lifecycle/*.test.cjs`
for factory data, writer, migration, server, dashboard, and result notification
changes. Check discovery with
`copilot --plugin-dir /path/to/copilot/plugins/coding skill list --json`.
