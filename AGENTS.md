# AGENTS.md

Personal Copilot agents and reusable skills. Keep this file current when
structure or workflows change.

## Layout

- `.github/plugin/marketplace.json` exposes seven plugins under `plugins/`:
  coding, security, fitness, terminals, coordination, factory, and home. Keep each
  marketplace version in sync with its plugin's `plugin.json`.
- Each plugin uses the supported legacy Copilot format with default `agents/`
  and `skills/` locations. Include its own copy of `LICENSE.md`.
- `Taskfile.yml` provides `task release:<plugin>`. From a clean `main`, it uses
  `svu next` scoped to that plugin's tags and directory, updates only its manifest
  and marketplace entry, creates a signed-off release commit and annotated
  `<plugin>/v<version>` tag, and pushes both atomically.
- `plugins/<plugin>/agents/*.agent.md` defines agent roles and model choices.
  Keep roles distinct and put reusable procedures in skills.
- `plugins/<plugin>/skills/<name>/SKILL.md` contains reusable procedures.
  Keep supporting scripts, references, and assets beside the skill.
- Machine settings and personal instructions remain in `caarlos0/dotfiles`.
  Do not add them to the plugin or assume this file is loaded by consumers.

## Conventions

- Use Conventional Commits with scope and explicit sign-off (`git commit -s`).
  Wait for an explicit commit request. Integrate upstream with merge, not rebase.
- Use short agent and skill names within their plugin namespace, such as
  `coding:simplifier`, `coding:review`, or `security:engineer`. Do not repeat
  code context already supplied by the namespace. Update paths, launchers,
  references, and preloads together when renaming entries. Preserve preload
  behavior. Skill preload names remain unqualified. `i-have-adhd` is an
  external skill; do not vendor it.
- Do not add sleep-and-poll loops. Wait with native watchers or `gh wait`; the
  coding plugin's `AGENTS.md` has the rules.
- Resolve bundled assets relative to the loaded skill directory, not
  `~/.copilot/skills/` or a checkout path.
- Keep worker and subagent file discovery inside their assigned cwd and its
  descendants. Do not search parent directories or sibling worktrees for
  instructions, agents, or skills. Pass this boundary in delegated prompts;
  external task artifacts and loaded skill assets use their exact paths.

## Tooling

Bun and TypeScript are dev and CI tooling only. The root `package.json`,
`bun.lock` and `tsconfig.json` serve this repository, not the plugins. Plugins
ship plain `.mjs` files that run with `node`, so consumers need no Bun and no
`node_modules`. Install with `bun install --frozen-lockfile`, then run
`bun run test` and `bun run typecheck`.

A `.mjs` with a same-named `.ts` beside it is a generated bundle. Edit the
`.ts`, run `bun run build` (`scripts/build.ts`), and commit both files. Never
edit the `.mjs`. CI runs `bun run build && git diff --exit-code`. Sibling
`.mjs` imports stay external, and tests keep running the `.mjs` paths. A
bundle must not read files beside itself through `import.meta.url` or
`__dirname`; check this before you port a module. The build fails when a
plugin module imports a file outside its own plugin directory. A relative
`import type` from a sibling `.ts` is erased, so the build cannot see it; keep
those inside the plugin too. Use the same Bun minor as CI: output differs
between Bun releases (local variable names), so a stale Bun leaves a diff in
unrelated bundles.

Runtime libraries (`write-file-atomic`, `valibot`) are `dependencies` in
`package.json`. The build bundles them into each `.mjs`, so consumers still need
no `node_modules`; the import boundary applies to plugin sources, not to library
files. A module served to the browser (`board-data`, `factory-data`) may use only
libraries that need no `node:` built-ins, and `board-data.mjs` stays under 20 KB.
Add a library only to replace code you would otherwise maintain.

## Plugin instructions

Copilot loads only the root `AGENTS.md` and the one in the current directory.
Before you change a plugin, read its own file. Plugin files hold rules that
apply to that plugin only. Keep them current when that plugin changes.

- `plugins/coding/AGENTS.md`: agent routing, GitHub CLI, and review policy.
- `plugins/coordination/AGENTS.md`: coordinators, Rex panes, and the board.
- `plugins/factory/AGENTS.md`: the factory, its state, dashboard, and Lever use.

A plugin without a file has no rules beyond this one. Add a file only when a
plugin has rules that do not apply elsewhere.

## Validation

Load local changes with `copilot --plugin-dir /path/to/copilot/plugins/coding`
in a new session. Avoid also loading an installed copy. Check discovery with
`copilot --plugin-dir /path/to/copilot/plugins/coding skill list --json`.
Each plugin's `AGENTS.md` lists its own tests.

`.github/workflows/test.yml` runs `node --test` on Ubuntu and macOS for every
pull request and every push to `main`. Node finds every `*.test.cjs` file, so a
new test needs no workflow change. Name test files `*.test.cjs`, and pin action
versions by commit SHA with a version comment.
