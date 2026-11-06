# AGENTS.md

Personal Copilot agents and reusable skills. Keep this file current when
structure or workflows change.

## Layout

- `plugin.json` names the `caarlos0` plugin. It uses the supported legacy
  Copilot format to keep the default `agents/` and `skills/` locations.
- `.github/plugin/marketplace.json` exposes that one plugin as
  `caarlos0@caarlos0`. Keep its version in sync with `plugin.json`.
- `agents/*.agent.md` defines agent roles and model choices. Keep roles
  distinct and put reusable procedures in skills.
- `skills/<name>/SKILL.md` contains reusable procedures. Keep supporting
  scripts, references, and assets beside the skill.
- Machine settings and personal instructions remain in `caarlos0/dotfiles`.
  Do not add them to the plugin or assume this file is loaded by consumers.

## Conventions

- Use Conventional Commits with scope and explicit sign-off (`git commit -s`).
  Wait for an explicit commit request. Integrate upstream with merge, not rebase.
- Preserve agent names, skill names, and frontmatter preload behavior.
  CLI agent selection uses the plugin namespace, such as `caarlos0:coordinator`.
  Skill preload names remain unqualified. `i-have-adhd` is an external skill;
  do not vendor it.
- The `caarlos0` agent routes bounded research to `scout` and substantial
  decision checkpoints to `advisor`. Their models live in agent frontmatter.
- GitHub CLI procedures live in `skills/gh-cli/SKILL.md`. Use native required-check
  fail-fast watching for CI, `gh wait` for PR changes or default-branch commits,
  and `gh wait --merge` for completed merges. Do not add sleep-and-poll loops.
- Review policy lives in `skills/my-code-review/SKILL.md`. Assess need and
  solution placement before implementation details.
- Resolve bundled assets relative to the loaded skill directory, not
  `~/.copilot/skills/` or a checkout path.

## Coordinators

`coordinator`, `implementation-coordinator`, and `review-coordinator` are thin
agents over `skills/coordinator/SKILL.md`. It owns pane operations, durable
briefs/results, monitoring, recovery, and cleanup. Reviews use Rex session
`reviews`; implementations use `work`. Rex and an available session are required.

The skill disables model/user invocation; agents preload it through `skills:`.
Each project has one writer per role and a persistent `<project>-reviewer.json`,
`<project>-implementer.json`, or `<project>-coordinator.json` under
`~/.local/state/copilot-coordinator/`. The board reads that same handoff.
One-shot workers save results without watchers.

The skill ships `board.html`, `handoff.example.json`, and a dependency-free
loopback server. Run `node serve.mjs` from the resolved coordinator skill
directory, or use Bun. Use one server for all runs; do not generate HTML per run.
Shared JSON validation lives in `skills/coordinator/board-data.mjs`.

Worker Copilot sessions and Rex tabs share the issue/PR title, or a descriptive
title from the prompt. Shorten to 100 characters and pass `--name` as one literal
quoted argument. Idle review panes can close without a push or merge; worktree
removal is separate and preserves reused worktrees and unfinished work.

## Validation

Load local changes with `copilot --plugin-dir /path/to/copilot` in a new
session. Avoid also loading an installed copy.

Run `node --test skills/coordinator/board.test.cjs` for board changes.
Check discovery with `copilot --plugin-dir /path/to/copilot skill list --json`.
