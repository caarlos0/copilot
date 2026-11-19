import { factoryTaskId } from "./score.mjs";

export const resultName = (task) => `${factoryTaskId(task)}-${task.role}-result.json`;

const costLines = (prWatch) => `Standing cost lines:
1. Never poll. No sleep loops and no self-wake schedule shorter than 20
   minutes. Wait with \`node ${prWatch}\` or the blocking waiter.
2. View a file before you edit it. Use edit, not create, for a file that
   exists.
3. This brief has the default for every decision you may hit. Use it and do
   not ask. The factory sends all its nudges in one message.
4. When the PR is handed to review and you have nothing to do, save a
   \`waiting\` result, emit it, and stop. The factory closes your pane and starts
   a fresh worker with a short handoff for any follow-up. Do not stay alive
   across hours of idle waiting.`;

function resultSection(task, paths) {
  const fields = task.role === "investigation"
    ? '"verdict": "implement|already-fixed|invalid|blocked", "summary": "one line", "evidence": { "reproduction": "", "checks": "", "gaps": "" }'
    : '"summary": "one line", "head": "full SHA", "evidence": { "reproduction": "", "checks": "", "gaps": "" }';
  const emit = task.role === "implementation"
    ? `"role":"implementation","outcome":"complete","head":"FULL SHA","result":"${paths.resultName}","feedback_id":null,"summary":"one line"`
    : `"role":"investigation","outcome":"complete","result":"${paths.resultName}","feedback_id":null,"summary":"one line"`;
  return `## Result
Atomically write the result (write a temp file in the same directory, then rename it) to this exact path: ${paths.result}
Keep this shape; write it when you finish, or earlier with outcome \`working\` or \`blocked\`:
\`\`\`json
{ "task": "${factoryTaskId(task)}", "role": "${task.role}", "updated_at": "ISO 8601 with timezone", "outcome": "complete", "feedback_id": null, ${fields} }
\`\`\`
Then run, right after the final write:
node ${paths.tools}/broker.mjs emit ${paths.factory} worker.result --task ${factoryTaskId(task)} --data '{${emit}}'
Then stop. No Rex pane operations. No sleep-and-poll.`;
}

function implementationBrief(task, paths) {
  return `# Implementation: ${factoryTaskId(task)}
Repo (your assigned worktree, the ONLY writable root): ${paths.work}
Branch: ${paths.branch}
The only other writable paths are the result path and \`$TMPDIR\`. Do not create a worktree, do not switch or check out a branch in another checkout, and do not edit ${paths.tools}.
Run \`pwd\` and \`git branch --show-current\` before the first edit. If either differs from this brief, write a \`blocked\` result and do not edit.
Read plugins/factory/AGENTS.md before the first edit.

## Task
${task.brief}

## Defaults
- Keep the change to this one concern. Do not fix unrelated problems.
- Run the tests of the files you touch with \`node --test FILE\`. If an unrelated test fails, record it in evidence.gaps and go on.
- Finish with one commit on the branch (\`git commit -s\`). Report its full SHA as \`head\`.
- Before you report, run \`git rebase main\` (never merge main). Never use \`git stash\`: the stash list is shared by all worktrees. To compare against the base, use a scratch worktree or \`git diff > $TMPDIR/x.patch\`.

${costLines(`${paths.tools}/pr-watch.mjs`)}

${resultSection(task, paths)}
`;
}

function investigationBrief(task, paths) {
  return `# Investigation: ${factoryTaskId(task)}
You are an investigation worker. Do not change anything. You are forbidden to write anywhere except the result path and \`$TMPDIR\`: no product file edits, no commits, no pushes, no PR, no branch, no worktree, no fix.
Checkout: ${paths.work} (read-only). Keep file discovery inside it. Read plugins/factory/AGENTS.md first.
${task.brief}
Verdict: implement|already-fixed|invalid|blocked. Verify the claim on the code in the checkout before you answer.

${resultSection(task, paths)}
`;
}

export const buildBrief = (task, paths) => (task.role === "implementation" ? implementationBrief : investigationBrief)(task, paths);
