# caarlos0/copilot

Personal Copilot agents and reusable skills, split into installable plugins.

| Plugin | Contents |
| --- | --- |
| `coding` | Development, code review, performance, and maintainer tools |
| `security` | Secure design, vulnerability research, and security triage agents |
| `fitness` | Personal trainer |
| `terminals` | CLI design and TUI design |
| `coordination` | Worker coordinators, durable handoffs, and task board |
| `factory` | Lever-backed task lifecycle, Rex workers, and flowchart dashboard |
| `home` | Electricity, solar, and battery planning |

## Install

Register the marketplace once, then install the plugins you want:

```sh
copilot plugin marketplace add caarlos0/copilot
copilot plugin install coding@caarlos0
copilot plugin install terminals@caarlos0
copilot plugin install coordination@caarlos0
copilot plugin install factory@caarlos0
```

The other plugins use the same `<plugin>@caarlos0` form.
Coordination and factory use coding workers and Rex's own skill, installed in
`~/.agents/skills/` and discovered by Copilot.
Coding uses the terminals plugin for CLI/TUI work. Security agents use coding
skills for language conventions and reviews. Install those companion plugins
for these workflows; Copilot does not install them as dependencies.

Factory also requires [github/lever](https://github.com/github/lever):

```sh
copilot plugin marketplace add github/lever
copilot plugin install lever@lever
```

Factory uses Lever's installed skills and templates, not bundled copies.
Install these companion plugins before starting a factory session.

Some coding, coordination, and factory agents preload the external
`i-have-adhd` skill. Install it separately with GitHub CLI:

```sh
gh skill install ayghri/i-have-adhd i-have-adhd --agent github-copilot --scope user --force
```

The `gh-stack` skill is also used for stacked pull requests:

```sh
gh skill install github/gh-stack --agent github-copilot --all --scope user --force
```

Machine settings, personal instructions, and these external skill installs
remain in [dotfiles](https://github.com/caarlos0/dotfiles).
The plugins do not apply settings or grant tool or filesystem access.

## Use

Agent names include their plugin namespace:

```sh
copilot --agent coding:caarlos0
copilot --agent security:engineer
copilot --agent fitness:personal-trainer
copilot --agent coordination:general
copilot --agent factory:general
copilot --agent home:electric-engineer
```

Coordination also provides `coordination:implement` and
`coordination:review`. Coordinators require Rex and preload the
shared coordinator skill. That skill cannot be invoked independently.

`factory:general` preloads its private `lifecycle` skill plus Lever's
`autonomy-dial` and `progress-contract`. It merges implementation and
coordination into one flow: `initial`, `investigation`, `implementation`,
`review`, and `resolved`, with `blocked` as a side state. Every task has a
GitHub issue.
It takes work from rules or from links you give it, and it runs all workers as
tabs in the Rex session it started in. It never creates or renames sessions.
Worker briefs use Lever's template. Implementation workers use `pr-shepherd`
for CI, feedback, and landing; review workers use `cross-model-review` at the
resolved spend tier. Workers watch a PR with `factory.mjs pr-watch`, not a second
delivery coordinator or an automatic cloud schedule.

Lever's autonomy dial controls writes and merges, capped by repository rules.
Without a merge grant, factory stays at L2 or below. At L3 with a matching
grant or L4, the implementation worker can land after `may_merge` passes on
the exact head, without another per-head approval. PR comments never grant
authority. Existing comment-based records are historical evidence only.
State lives in `<owner.repo>-factory.json` (`factory/v1`) in
`~/.local/state/copilot-factory/` (or the legacy `~/.local/state/copilot-coordinator/`
when only that exists). Run `node factory.mjs serve` from the
`lifecycle` skill directory in the factory plugin for an animated flowchart
dashboard. Click a state for a popup task list. Use a task's **Move** button to return a
task to an earlier state, unblock it, or move it directly to **Resolved**, with
a comment for the factory. Resolution requires an outcome (default: completed)
and does not merge or close GitHub items.
The comment stays in history and is marked pending until the factory has
reconciled its workers. The dashboard does not stop running workers or grant
merge authority. Move an old project with
`node factory.mjs migrate --project owner/repo` from the same directory. It merges the
implementer and coordinator handoffs and leaves the old files in place unless
you pass `--archive`.

Coordination's PR review workers run `review -k` for your own PRs and retain
their panes through merge. Other authors' PRs use `review` and close after
verified review results.
Implementation panes stay open through PR creation and merge. A blocker keeps
these retained panes open; waiting does not authorize a merge. The `review`
command comes from your machine setup, not this plugin.

Workers publish cumulative result files. A bundled filesystem waiter wakes
unscheduled coordinators on result changes, without periodic pane checks or
requiring the board server. Scheduled coordinator passes remain finite.

Use `/coding:review` for code reviews and `/coding:simplifier` for a final
behavior-preserving cleanup pass.

## Update

```sh
copilot plugin update coding@caarlos0
```

Use `copilot plugin update --all` to update all installed plugins.

## Release

From a clean `main` branch, with Task, svu, and jq installed:

```sh
task release:terminals
task release:coding
```

Use `task release:<plugin>` to release one plugin. The task uses `svu next`
with that plugin's tag prefix and directory to choose its next version, with
a patch bump when no commit triggers a larger bump. Only that plugin's manifest
and marketplace entry are updated.
It creates a signed-off `release(<plugin>): <plugin>/v<version>` commit and an
annotated `<plugin>/v<version>` tag, then pushes `main` and that tag to `origin`
in one atomic push. Other plugins keep their versions.

## Develop

Load a plugin checkout without installing it:

```sh
copilot --plugin-dir /path/to/copilot/plugins/coding
```

Use a new session after edits. Do not also load an installed copy of that
plugin; disable it first with `copilot plugin disable coding@caarlos0`, and
enable it again after development.

To install from an unpublished checkout, register its local marketplace
instead of the GitHub source, then use the same install commands:

```sh
copilot plugin marketplace add /path/to/copilot
copilot plugin install coding@caarlos0
```

Local marketplace plugins load from the checkout. Use a new session after
edits. Once the repository is published, uninstall its installed plugins,
remove the local marketplace with `copilot plugin marketplace remove caarlos0`,
then follow the GitHub installation steps.

Run the coordination and factory checks from the repository root:

```sh
node --test plugins/coordination/skills/coordinator/*.test.ts plugins/factory/skills/lifecycle/*.test.ts
```
