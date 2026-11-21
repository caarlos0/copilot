# caarlos0/copilot

Agents and skills for [GitHub Copilot CLI](https://github.com/features/copilot/cli).
They help you write code, review code, find vulnerabilities, and run many
Copilot workers at the same time.

Each plugin is small and does one job. Install only the ones you need.

## Plugins

| Plugin | What it gives you |
| --- | --- |
| [`coding`](plugins/coding) | Agents and skills for development, review, performance, and maintenance |
| [`security`](plugins/security) | Agents for secure design, vulnerability hunting, and report triage |
| [`terminals`](plugins/terminals) | Skills for command-line and terminal UI design |
| [`coordination`](plugins/coordination) | Coordinators that run workers in Rex panes, with a task board |
| [`factory`](plugins/factory) | A task lifecycle with GitHub issues, Rex workers, and a dashboard |
| [`fitness`](plugins/fitness) | A personal trainer that reads your Hevy log |
| [`home`](plugins/home) | An agent for household electricity, solar, and battery planning |

## Install

1. Add the marketplace:

   ```sh
   copilot plugin marketplace add caarlos0/copilot
   ```

2. Install a plugin:

   ```sh
   copilot plugin install coding@caarlos0
   ```

3. Start Copilot with one of its agents:

   ```sh
   copilot --agent coding:caarlos0
   ```

Agent names have the form `<plugin>:<agent>`. To update all plugins, run
`copilot plugin update --all`.

## Companions

Copilot does not install plugin dependencies. Install these yourself when a
plugin needs them.

- `coding` uses the skills of `terminals` for command-line and TUI work.
- `security` agents use the skills of `coding`.
- `coordination` and `factory` need Rex, and they start `coding` workers.
- `factory` also needs [github/lever](https://github.com/github/lever):

  ```sh
  copilot plugin marketplace add github/lever
  copilot plugin install lever@lever
  ```

- Some agents preload the external `i-have-adhd` skill:

  ```sh
  gh skill install ayghri/i-have-adhd i-have-adhd --agent github-copilot --scope user --force
  ```

- Stacked pull requests use the `gh-stack` skill:

  ```sh
  gh skill install github/gh-stack --agent github-copilot --all --scope user --force
  ```

The plugins do not change your settings. They do not grant tool or file access.
Machine settings stay in [dotfiles](https://github.com/caarlos0/dotfiles).

## Develop

Load a plugin from a checkout without installing it:

```sh
copilot --plugin-dir /path/to/copilot/plugins/coding
```

Use a new session after each edit. Do not load an installed copy of the same
plugin at the same time.

Run the tests from the repository root. `factory` and `coordination` need the
Bun version in `.bun-version` first:

```sh
bun install --cwd plugins/factory --frozen-lockfile
bun install --cwd plugins/coordination --frozen-lockfile
node --test plugins scripts
```

Run `task setup` once in each clone. It enables the pre-commit hook that
rebuilds the generated `.mjs` bundles. Never edit those bundles by hand. Read
[AGENTS.md](AGENTS.md) for the full rules.

## Release

From a clean `main` branch, with Task, svu, and jq installed:

```sh
task release:coding
```

Use `task release:<plugin>` for any plugin. The task picks the next version
with `svu`, updates the manifest and marketplace entry of that plugin, and
pushes a signed-off release commit and the `<plugin>/v<version>` tag. Other
plugins keep their versions.

## License

[MIT](LICENSE.md)
