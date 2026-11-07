# caarlos0/copilot

Personal Copilot agents and reusable skills, split into installable plugins.

| Plugin | Contents |
| --- | --- |
| `coding` | Development, code review, performance, and maintainer tools |
| `security` | Secure design, vulnerability research, and security triage agents |
| `fitness` | Personal trainer |
| `terminals` | Rex, CLI design, and TUI design |
| `coordination` | Worker coordinators, durable handoffs, and task board |
| `home` | Electricity, solar, and battery planning |

## Install

Register the marketplace once, then install the plugins you want:

```sh
copilot plugin marketplace add caarlos0/copilot
copilot plugin install coding@caarlos0
copilot plugin install terminals@caarlos0
copilot plugin install coordination@caarlos0
```

The other plugins use the same `<plugin>@caarlos0` form.
Coordination uses coding workers and the terminals plugin's Rex skill.
Coding uses the terminals plugin for CLI/TUI work. Security agents use coding
skills for language conventions and reviews. Install those companion plugins
for these workflows; Copilot does not install them as dependencies.

Some coding and coordination agents preload the external `i-have-adhd` skill.
Install it separately with GitHub CLI:

```sh
gh skill install ayghri/i-have-adhd i-have-adhd --agent github-copilot --scope user --force
```

The `gh-stack` skill is also used for stacked pull requests:

```sh
gh skill install github/gh-stack --agent github-copilot --all --scope user --force
```

Machine settings, personal instructions, and these external skill installs
remain in [dotfiles](https://github.com/caarlos0/dotfiles).
Dotfiles setup installs all six plugins. The plugins do not apply settings or
grant tool or filesystem access.

## Use

Agent names include their plugin namespace:

```sh
copilot --agent coding:caarlos0
copilot --agent security:security-engineer
copilot --agent fitness:personal-trainer
copilot --agent coordination:coordinator
copilot --agent home:electric-engineer
```

Coordination also provides `coordination:implementation-coordinator` and
`coordination:review-coordinator`. Coordinators require Rex and preload the
shared coordinator skill. That skill cannot be invoked independently.

## Update

```sh
copilot plugin update coding@caarlos0
```

Use `copilot plugin update --all` to update all installed plugins.

## Release

From a clean `main` branch, with Task, svu, and jq installed:

```sh
task release
```

The task uses `svu next` to choose the next tag. All six plugin manifests and
marketplace entries receive the same version, without the tag's `v` prefix.
It creates a signed-off `release: <tag>` commit and an annotated tag, then
pushes `main` and that tag to `origin` in one atomic push.

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

Run the coordinator board checks from the repository root:

```sh
node --test plugins/coordination/skills/coordinator/board.test.cjs
```
