# caarlos0/copilot

Personal Copilot agents and reusable skills, packaged as one plugin.

## Install

```sh
copilot plugin marketplace add caarlos0/copilot
copilot plugin install caarlos0@caarlos0
```

Some agents preload the external `i-have-adhd` skill. Install it separately
with GitHub CLI:

```sh
gh skill install ayghri/i-have-adhd i-have-adhd --agent github-copilot --scope user --force
```

The `gh-stack` skill is also used for stacked pull requests:

```sh
gh skill install github/gh-stack --agent github-copilot --all --scope user --force
```

Machine settings, personal instructions, and these external skill installs
remain in [dotfiles](https://github.com/caarlos0/dotfiles).
This plugin does not apply settings or grant tool or filesystem access.

## Use

```sh
copilot --agent caarlos0:caarlos0
copilot --agent caarlos0:coordinator
copilot --agent caarlos0:implementation-coordinator
copilot --agent caarlos0:review-coordinator
```

Coordinator agents require Rex and preload the shared coordinator skill.
That skill cannot be invoked independently.

## Update

```sh
copilot plugin update caarlos0@caarlos0
```

## Develop

Load the checkout without installing it:

```sh
copilot --plugin-dir /path/to/copilot
```

Use a new session after edits. Do not also load an installed copy of the
plugin; disable it first with `copilot plugin disable caarlos0`, and enable it
again after development.

To install an unpublished checkout:

```sh
copilot plugin marketplace add /path/to/copilot
copilot plugin install caarlos0@caarlos0
```

Local marketplace plugins load from the checkout. Use a new session after edits.
Once the repository is published, switch to the GitHub source:

```sh
copilot plugin uninstall caarlos0@caarlos0
copilot plugin marketplace remove caarlos0
copilot plugin marketplace add caarlos0/copilot
copilot plugin install caarlos0@caarlos0
```

Run the coordinator board checks from the repository root:

```sh
node --test skills/coordinator/board.test.cjs
```
