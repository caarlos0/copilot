// preToolUse guard for the factory coordinator. Reads the hook payload on
// stdin and prints a deny decision only for a coordinator session (see
// gate.ts) and only when a rule below matches. Anything
// else, including any parse error, prints nothing, which allows the call.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { isCoordinator } from "../skills/lifecycle/gate.ts";

const DENIED_TOOLS = ["task", "read_agent", "write_agent", "run_dynamic_workflow"];
const WRITE_TOOLS = ["edit", "create", "str_replace_editor", "apply_patch"];

const isCopilot = (c: string) => /^copilot\s/.test(c);
const isLaunch = (c: string) => isCopilot(c) && /\s(?:-i|--interactive|-p|--prompt)\b/.test(c);

type Rule = { name: string; reason: string; deny: (command: string) => boolean };

// Each rule tests one command (see `commands`), anchored at its start.
const BASH_RULES: Rule[] = [
  {
    name: "gh-pr-merge",
    reason: "The coordinator never merges a PR. An implementation worker lands it.",
    deny: (c) => /^gh\b.*\bpr\s+merge\b/.test(c),
  },
  {
    name: "git-merge-ff-only",
    reason: "The coordinator lands a branch only with `git merge --ff-only`.",
    deny: (c) => /^git(?:\s+-[Cc]\s+\S+)*\s+merge(?![-\w])/.test(c) && !/\s--ff-only\b/.test(c),
  },
  {
    name: "rex-session",
    reason: "The factory runs in the Rex session where it started. Never create or rename a Rex session.",
    deny: (c) => /^rex\s+new\b/.test(c) || /^rex\s+session\s+(?:new|create|rename)\b/.test(c),
  },
  {
    name: "waiter-async-bash",
    reason:
      "Run `factory.mjs broker wait` as async bash and read its output. A waiter that runs with `&`, nohup, setsid, or disown, or with stdout sent to a file, has no reader. Its wake never reaches you.",
    deny: (c) => /^(?:\S*\/)?(?:node|bun)\s+\S*factory\.mjs\s+broker\s+wait\b/.test(c) && (/\s&$/.test(c) || /(?:^|\s)(?:1|&)?>>?\s*(?!&)\S/.test(c)),
  },
  {
    name: "copilot-autopilot",
    reason: "A worker never runs with --autopilot.",
    deny: (c) => isCopilot(c) && /\s--autopilot\b/.test(c),
  },
  {
    name: "copilot-model",
    reason: "Every worker launch needs `--model claude-sonnet-5.5`.",
    deny: (c) => isLaunch(c) && !/\s--model[ =]claude-sonnet-5\.5(?=\s|$)/.test(c),
  },
];

// Splits a line at `; & | ( `` and newlines outside quotes, so an argument such
// as 'shell(git stash)' or "$(a | b)" stays in its command. A `$(...)` or
// backtick substitution inside double quotes is returned as extra lines.
function split(line: string) {
  const segs: string[] = [];
  const subs: string[] = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && quote !== "'") {
      if (line[i + 1] === "\n") cur += " ";
      else cur += ch + (line[i + 1] ?? "");
      i++;
    } else if (quote === "'") {
      if (ch === "'") quote = "";
      cur += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = "";
      cur += ch;
      if (ch === "`") {
        const end = line.indexOf("`", i + 1);
        const stop = end < 0 ? line.length : end;
        subs.push(line.slice(i + 1, stop));
        cur += line.slice(i + 1, stop + 1);
        i = stop;
      } else if (ch === "$" && line[i + 1] === "(") {
        let depth = 0;
        let j = i + 1;
        for (; j < line.length; j++) {
          if (line[j] === "(") depth++;
          else if (line[j] === ")" && --depth === 0) break;
        }
        subs.push(line.slice(i + 2, j));
        cur += line.slice(i + 1, j + 1);
        i = j;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === "&" && line[i + 1] === "&") {
      segs.push(cur);
      cur = "";
      i++;
    } else if (ch === "&" && (line[i + 1] === ">" || cur.endsWith(">") || cur.endsWith("<"))) {
      cur += ch;
    } else if (ch === "&") {
      segs.push(`${cur} &`);
      cur = "";
    } else if ("\n;|(`".includes(ch)) {
      segs.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  segs.push(cur);
  return { segs, subs };
}

// Splits a shell line into commands: each segment, the command after `--` in
// a `rex` call, and the quoted script of `sh -c`.
function commands(line: string): string[] {
  const out: string[] = [];
  const { segs, subs } = split(line);
  for (const sub of subs) out.push(...commands(sub));
  for (let seg of segs) {
    // nohup and setsid detach the command like a trailing `&`.
    const detached = /^(?:(?:\w+=\S*|sudo|env|command|exec|time)\s+)*(?:nohup|setsid)\s/.test(seg.trim());
    seg = seg.trim().replace(/^(?:(?:\w+=\S*|sudo|env|command|exec|time|nohup|setsid)\s+)+/, "");
    if (!seg) continue;
    if (detached && !seg.endsWith(" &")) seg += " &";
    out.push(seg);
    const inner =
      seg.match(/^rex\b.*?\s--\s+(.+)$/)?.[1] ?? seg.match(/^(?:ba|z)?sh\s+(?:-\w+\s+)*-c\s+(.+)$/)?.[1];
    if (inner) out.push(...commands(inner.replace(/^['"]|['"]$/g, "")));
  }
  return out;
}

// realpath of the deepest existing ancestor, so a file that does not exist yet still resolves
function real(path: string) {
  let head = path;
  const tail: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) {
    tail.unshift(head.slice(dirname(head).length + 1));
    head = dirname(head);
  }
  return join(realpathSync(head), ...tail);
}

function writeRoots() {
  const home = homedir();
  const roots = [
    join(home, ".local/state/copilot-coordinator"),
    join(home, ".local/state/copilot-factory"),
    join(process.env.COPILOT_HOME || join(home, ".copilot"), "session-state"),
    process.env.TMPDIR || tmpdir(),
  ];
  return roots.flatMap((r) => [resolve(r), real(resolve(r))]);
}

function targets(tool: string, args: ToolArgs, cwd: string) {
  const paths: string[] = typeof args.path === "string" ? [args.path] : [];
  if (tool === "apply_patch") {
    for (const m of JSON.stringify(args).matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\\"]+)/g)) paths.push(m[1]);
  }
  return paths.map((p) => resolve(cwd, p.replace(/^~(?=$|\/)/, homedir())));
}

type ToolArgs = { path?: unknown; command?: unknown };
type Payload = { toolName?: string; toolArgs?: string | ToolArgs | null; cwd?: string };

function decide({ toolName = "", toolArgs, cwd = process.cwd() }: Payload): Pick<Rule, "name" | "reason"> | null {
  if (DENIED_TOOLS.includes(toolName)) {
    return { name: "no-subagents", reason: "The factory uses Rex workers. Never use subagents or workflows." };
  }
  const args = typeof toolArgs === "string" ? JSON.parse(toolArgs) : (toolArgs ?? {});
  if (toolName === "bash") {
    for (const command of commands(String(args.command ?? ""))) {
      const rule = BASH_RULES.find((r) => r.deny(command));
      if (rule) return rule;
    }
  }
  if (WRITE_TOOLS.includes(toolName)) {
    const roots = writeRoots();
    for (const path of targets(toolName, args, cwd)) {
      const target = real(path);
      if (!roots.some((r) => target === r || target.startsWith(r + sep))) {
        return {
          name: "write-boundary",
          reason: `${path} is outside the state directories and $TMPDIR. The coordinator never edits product files. Give the change to a worker.`,
        };
      }
    }
  }
  return null;
}

export function main(_argv: string[]) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const hit = isCoordinator(input) ? decide(input) : null;
    if (hit) {
      console.log(
        JSON.stringify({
          permissionDecision: "deny",
          permissionDecisionReason: `factory guard rule ${hit.name}: ${hit.reason}`,
        }),
      );
    }
  } catch {}
}
