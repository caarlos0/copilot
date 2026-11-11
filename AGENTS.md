# AGENTS.md

Personal Copilot agents and reusable skills. Keep this file current when
structure or workflows change.

## Layout

- `.github/plugin/marketplace.json` exposes six plugins under `plugins/`:
  coding, security, fitness, terminals, coordination, and home. Keep each
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

## Validation

Load local changes with `copilot --plugin-dir /path/to/copilot/plugins/coding`
in a new session. Avoid also loading an installed copy.

Run `node --test plugins/coordination/skills/coordinator/board.test.cjs`
for board changes and
`node --test plugins/coordination/skills/coordinator/wait.test.cjs`
for result notification changes. Check discovery with
`copilot --plugin-dir /path/to/copilot/plugins/coding skill list --json`.
