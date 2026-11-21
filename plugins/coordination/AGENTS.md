# AGENTS.md: coordination plugin

Plugin-specific rules. Repository-wide rules are in the root `AGENTS.md`.
Keep the shared `coordinator` skill name; it is not namespaced by the plugin.

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
Workers atomically save cumulative results. The bundled `coordinator.mjs wait` command notifies
unscheduled coordinators of content changes without a state-polling loop.
Scheduled passes remain finite; general one-shot workers do not watch GitHub.

The skill ships `board.html`, `handoff.example.json`, and a dependency-free
loopback server. Run `node coordinator.mjs serve` from the resolved coordinator skill
directory. Use one server for all runs; do not generate HTML per run.
Shared JSON validation lives beside the skill in `board-data.mjs`, a valibot
schema bundled in (stages end at each cross-field rule, so the first error keeps
the field order).
Coordinators must write handoffs with the bundled `coordinator.mjs handoff` flags. It
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

## Generated modules

`board-data`, `handoff`, `wait`, `serve` and `coordinator` in `skills/coordinator/` are
TypeScript, checked with `strict` on. Edit the `.ts`, run `bun run build` in
`plugins/coordination`, and commit the `.ts` and the two generated bundles together.
Do not edit a `.mjs` file. Only two `.mjs` files are committed, and both are generated:
`coordinator.mjs` and `board-data.mjs`. A fresh checkout needs
`bun install --frozen-lockfile` in `plugins/coordination` before you build, typecheck
or test (CI pins Bun 1.4.5). The pre-commit hook rebuilds the bundles when you stage a
non-test `.ts` file, and `.gitattributes` marks them as generated.
`coordinator.mjs` is a dispatcher: it loads `handoff`, `wait` or `serve` only when
you name it (`node coordinator.mjs wait ARGS`). It needs no Bun and no
`node_modules`. The skill and the tests use it. Each of these three modules exports
`main(argv)`, and the dispatcher calls it. A module has no `process.argv[1]` guard.
Modules import each other as `./name.ts`. Tests import the `.ts` sources, or spawn
`coordinator.mjs`.
`serve` reads `import.meta.url` to find `board.html` and `board-data.mjs` beside it.
This is the path of `coordinator.mjs` in the bundle, so `coordinator.mjs` must stay
in `skills/coordinator/`. `board-data.mjs` is also the browser bundle. `serve` serves it, so
it must not import `node:` modules.
The build fails when a coordination module imports a file outside this plugin,
so it stays independent of the factory plugin.

## Validation

Run these in `plugins/coordination` after `bun install --frozen-lockfile`:

- `bun run typecheck` for all TypeScript changes.
- `bun run build`, then `git diff --exit-code`, to check that the committed
  bundles match the sources.

Run from the repository root:

- `node --test plugins/coordination/skills/coordinator/board.test.ts` for board
  changes.
- `node --test plugins/coordination/skills/coordinator/handoff.test.ts` for
  handoff writes.
- `node --test plugins/coordination/skills/coordinator/wait.test.ts` for
  result notification changes.
