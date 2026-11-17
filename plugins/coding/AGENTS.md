# AGENTS.md: coding plugin

Plugin-specific rules. Repository-wide rules are in the root `AGENTS.md`.

- The `caarlos0` agent routes bounded research to `scout` and substantial
  decision checkpoints to `advisor`. Their models live in agent frontmatter.
- GitHub CLI procedures live in the `gh-cli` skill. Use native
  required-check fail-fast watching for CI, `gh wait` for PR changes or
  default-branch commits, and `gh wait --merge` for completed merges.
  Do not add sleep-and-poll loops.
- Review policy lives in the `review` skill.
  Assess need and solution placement before implementation details.
