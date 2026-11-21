# coordination

Coordinator agents that run Copilot workers in Rex panes. Each worker gets its
own git worktree. A task board shows the state of the work.

## Install

You need Rex and a Rex session. Rex installs its own skill in
`~/.agents/skills/`, and Copilot finds it there.

```sh
copilot plugin marketplace add caarlos0/copilot
copilot plugin install coordination@caarlos0
```

Install the `coding` plugin too. Coordinators start `coding` workers.
Some agents preload the external `i-have-adhd` skill. Install it with
`gh skill install ayghri/i-have-adhd i-have-adhd --agent github-copilot --scope user --force`.

## Agents

Start one with `copilot --agent coordination:<name>`.

| Agent | Use it to |
| --- | --- |
| `general` | Run workers for any parallel task |
| `implement` | Run implementation workers in the Rex session `work`. It owns validation, blockers, and authorized commits, pushes, and pull requests |
| `review` | Run read-only review workers in the Rex session `reviews`. It tracks reviewed heads and GitHub publication. It never fixes code or merges |

A coordinator keeps its own pane and gives the work to workers. Workers save
cumulative result files. The coordinator keeps handoff files in
`~/.local/state/copilot-coordinator/`.

Review workers run a `review` command for your own pull requests. That command
comes from your machine setup, not from this plugin.

## Skills

The `coordinator` skill holds the shared worker lifecycle. The agents preload
it. You cannot call it yourself.

## Task board

Run the board server from the directory of the `coordinator` skill:

```sh
node coordinator.mjs serve
```

One server shows all runs.

## Develop

The code is TypeScript. Users need only Node. From this directory:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build
```

Edit the `.ts` files, then build. The build writes the `.mjs` bundles
(`coordinator.mjs` and `board-data.mjs`). Never edit them by hand. Use the Bun
version in `.bun-version`. From the repository root, run
`node --test plugins/coordination`. Read [AGENTS.md](AGENTS.md) for the rules.
