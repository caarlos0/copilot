# factory

A task factory for Copilot. Each task has a GitHub issue. Workers run as tabs
in your Rex session. A dashboard shows the state of every task.

## Install

You need Rex and [github/lever](https://github.com/github/lever). The factory
uses the skills and templates of Lever. It does not bundle copies.

```sh
copilot plugin marketplace add github/lever
copilot plugin install lever@lever
copilot plugin marketplace add caarlos0/copilot
copilot plugin install factory@caarlos0
```

Install the `coding` plugin too. Some agents preload the external
`i-have-adhd` skill. Install it with
`gh skill install ayghri/i-have-adhd i-have-adhd --agent github-copilot --scope user --force`.

## Agents

Start the factory in a Rex session with `copilot --agent factory:general`.

| Agent | Use it to |
| --- | --- |
| `general` | Accept work, create tasks, start and watch workers, and report. It never does the work itself |

The agent preloads its private `lifecycle` skill, and the Lever skills
`autonomy-dial` and `progress-contract`.

## How it works

A task moves through `initial`, `investigation`, `implementation`, `review`,
and `resolved`. `blocked` is a side state. Every task has a GitHub issue.

- Workers use Lever's brief template. Implementation workers use `pr-shepherd`.
  Review workers use `cross-model-review`.
- Lever's autonomy dial controls writes and merges. Without a merge grant, the
  factory stays at L2 or below.
- The factory keeps its state in `<owner.repo>-factory.json` in
  `~/.local/state/copilot-factory/`.
- Each abnormal stop (a blocked task, a quiet worker, a repeated prompt or
  conflict) becomes one `stop.recorded` event and one cause task. The
  `improve` worker reads the stops and proposes a prevention, not only a retry.

## Dashboard

Run the server from the directory of the `lifecycle` skill:

```sh
node factory.mjs serve
```

The dashboard shows an animated flowchart. You can move a task to an earlier
state, unblock it, or resolve it, with a comment for the factory. The dashboard
does not stop workers. It does not merge or grant authority.

## Skills

The `lifecycle` skill holds the procedure of the factory. The agent preloads
it. You cannot call it yourself.

## Develop

The code is TypeScript. Users need only Node. From this directory:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build
```

Edit the `.ts` files, then build. The build writes two `.mjs` bundles
(`factory.mjs` and `dashboard.mjs`). Never edit them by hand. Use the Bun
version in `.bun-version`. From the repository root, run
`node --test plugins/factory`. Read [AGENTS.md](AGENTS.md) for the rules.
