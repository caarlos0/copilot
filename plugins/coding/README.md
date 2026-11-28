# coding

Agents and skills for development, code review, performance work, and
repository maintenance.

## Install

```sh
copilot plugin marketplace add caarlos0/copilot
copilot plugin install coding@caarlos0
```

Install the `terminals` plugin too. The `cli-design` and `tui-design` skills
come from it.

## Agents

Start one with `copilot --agent coding:<name>`.

| Agent | Use it to |
| --- | --- |
| `caarlos0` | Make decisions on scope, APIs, CLIs, reviews, and releases. It runs the `simplifier` skill after it writes code |
| `anvil` | Reproduce a claim, make a small change, and report only what tool output proves |
| `advisor` | Get a read-only second opinion on a plan, a repeated failure, or a finished task |
| `scout` | Research a repository or documentation question without changes |
| `issue-auditor` | Check a GitHub issue against the current code and related pull requests |

## Skills

| Group | Skills |
| --- | --- |
| Review and quality | `review`, `simplifier`, `writing-tests`, `change-impact-auditor` |
| Languages | `go-conventions`, `go-doc`, `rust-specialist`, `apple-developer` |
| Performance | `go-performance`, `rust-performance`, `python-performance`, `typescript-performance` |
| Debugging | `runtime-process-debugging` |
| GitHub | `gh-cli`, `issue-validator`, `maintainer-briefing`, `dependabot-merge` |
| Writing | `gh-doc-author`, `dashboard`, `stop-slop` |

Ask Copilot to use a skill by name, or run `/coding:review` or
`/coding:simplifier`.

## Notes

- Agents and skills use short names. The plugin name is the namespace.
- `dependabot-merge` and `go-conventions` fit the `goreleaser` organization and
  the projects of the author.
- Read [AGENTS.md](AGENTS.md) for agent routing, GitHub CLI, and review rules.
