# Hook payload fixtures

Real payloads from Copilot CLI hooks, captured for the attention feature.
Ids, paths, and timestamps are redacted. Shapes and key names are unchanged.

Produced by: GitHub Copilot CLI **1.0.112-0** (cached package, run with
`--yolo --sandbox --model claude-sonnet-5.5`) on macOS, with a throwaway plugin
that logged each hook's stdin and environment. The same hook payloads also appear
as `hook.start` events in `events.jsonl`.

| File | Source |
| --- | --- |
| `notification-permission.json` | `notification` hook stdin, `permission_prompt`, sandbox-bypass request |
| `notification-elicitation.json` | `notification` hook stdin, `elicitation_dialog`, `ask_user` form |
| `permission-request-sandbox-bypass.json` | `permissionRequest` hook stdin, second call (the one with `requestSandboxBypass`) |
| `pre-tool-use-sandbox-bypass.json` | `preToolUse` hook stdin for the same bash call |
| `pre-tool-use-ask-user.json` | `preToolUse` hook stdin for `ask_user` (message and options) |
| `session-log-events.json` | `events.jsonl` lines: `permission.requested`, notification `hook.start`, `permission.completed`, `ask_user` start and complete |

## Verified

- `notification` fires with `permission_prompt` when a sandbox-bypass prompt is
  shown, in an interactive session and in `-p` mode.
- `notification` fires with `permission_prompt` for a normal (non-yolo) shell prompt.
- `notification` fires with `elicitation_dialog` for `ask_user`.
- Notification stdin has only `sessionId`, `timestamp`, `cwd`, `message`, `title`,
  `hook_event_name`, `notification_type`. The `message` is `Run command: <command>`
  for permissions and the fixed text `Information requested` for `ask_user`. There
  is no tool name, command field, request ID, or option list.
- The `events.jsonl` `hook.start` input uses `notificationType` (camelCase) and has no
  `hook_event_name`. The hook's stdin uses `notification_type`.
- Structured text lives elsewhere. `permissionRequest` stdin has `toolName`,
  `toolInput.command`, `toolInput.requestSandboxBypass`, and
  `requestSandboxBypassReason`. `preToolUse` for `ask_user` has `toolArgs.message`
  and `toolArgs.requestedSchema` with the enum options.
- `permissionRequest` fires twice for a bypass command: first without
  `requestSandboxBypass`, then with it. It does not fire for `ask_user`.
- Order: `preToolUse`, `permissionRequest`, then `permission.requested` and the
  `notification` hook within a few milliseconds.
- Env vars reach the hook: variables set on the `copilot` command (for example
  `FACTORY_TASK`), `REX_SESSION`, `PLUGIN_ROOT`, `COPILOT_PLUGIN_ROOT`,
  `CLAUDE_PLUGIN_ROOT`, `COPILOT_HOOK_DIR`, `COPILOT_PROJECT_DIR`.
  `COPILOT_AGENT_SESSION_ID` is inherited from the parent shell, not the hook's
  session. Use `sessionId` from stdin.
- A hook can append to a file in a directory its sandbox allows (tested in `$TMPDIR`).
- The "answered" signal is only in `events.jsonl`: `permission.completed` with
  `decisionSource: human_response` and `result.kind: approved`, and
  `tool.execution_complete` for `ask_user` (`User responded: red`). No notification
  or hook reports an answer.
- In `-p` mode the prompt is denied at once (`unattended_fallback`,
  `denied-no-approval-rule-and-could-not-request-from-user`), and the
  notification still fires.

## Still unverified

- Appending to the real factory state dir (`~/.local/state/copilot-factory/`) from a
  hook inside a factory worker's sandbox. Only `$TMPDIR` was tested.
- Which tool kinds besides shell (read, write, URL, MCP) produce a `permission_prompt`
  notification, and their `message` text.
- Notification for MCP elicitation or consent (separate from `ask_user`).
- Whether the notification fires while the TUI window is focused versus not. All
  runs were in a pty that the runner drove.
- Multi-field or multi-question `ask_user` forms. Only one enum field was tested.
- The `~/.bin/copilot` dev build (`0.0.1`). It could not start inside the command
  sandbox, so only the released CLI was tested. The stable CLI version in use
  with the factory should be rechecked when it changes.
