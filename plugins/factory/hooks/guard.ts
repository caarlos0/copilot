// preToolUse guard for the factory coordinator and workers. Reads the hook
// payload on stdin and prints a deny decision only when a rule matches.
// Coordinator sessions get all rules; factory workers (see gate.ts) get only
// no-relative-escape. Anything else, including any parse error, prints nothing,
// which allows the call.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isCoordinator, isWorker } from "../skills/lifecycle/gate.ts";

const DENIED_TOOLS = ["task", "read_agent", "write_agent", "run_dynamic_workflow"];
const WRITE_TOOLS = ["edit", "create", "str_replace_editor", "apply_patch"];
const PATH_TOOLS = ["view", "edit", "create", "str_replace_editor", "apply_patch", "grep", "glob"];

const isCopilot = (c: string) => /^copilot\s/.test(c);

type Rule = { name: string; reason: string; deny: (command: string) => boolean };
type Decision = Pick<Rule, "name" | "reason">;

// Matches a `..` path segment, including malformed `..$TMPDIR` / `..$HOME`
// forms where the variable is joined directly onto `..` without a slash.
const CMD_PREFIX = /^(?:(?:\w+=\S*|sudo|env|command|exec|time|nohup|setsid)\s+)+/;
const PARENT_SEG = /(?:^|\/)\.\.(?:$|\/|\$(?:(?:TMPDIR|HOME)(?![A-Za-z0-9_])|\{(?:TMPDIR|HOME)\}))/;
const KNOWN_VAR = /\$(?:(TMPDIR|HOME)(?![A-Za-z0-9_])|\{(TMPDIR|HOME)\})/g;
const LEADING_VAR = /^\$(?:(TMPDIR|HOME)(?![A-Za-z0-9_])|\{(TMPDIR|HOME)\})(?=$|\/)/;

// Pure text-printing or no-op commands whose positional arguments are not paths.
const NON_PATH_CMDS = new Set(["echo", "printf", "true", "false", ":"]);

// Command-specific flags whose next argument is text, a pattern, or inline code
// rather than a filesystem path.
const SKIP_VALUE_FLAGS: Record<string, Set<string>> = {
  git: new Set(["-m", "--message", "--grep", "--format", "--pretty", "-S", "-G", "--author", "--committer"]),
  gh: new Set([
    "-t",
    "--title",
    "-b",
    "--body",
    "-m",
    "--message",
    "-q",
    "--jq",
    "-S",
    "--search",
    "--template",
    "-l",
    "--label",
    "-a",
    "--assignee",
  ]),
  grep: new Set(["-e", "--regexp", "-m", "--max-count", "-A", "-B", "-C"]),
  egrep: new Set(["-e", "--regexp", "-m", "--max-count", "-A", "-B", "-C"]),
  fgrep: new Set(["-e", "--regexp", "-m", "--max-count", "-A", "-B", "-C"]),
  rg: new Set(["-e", "--regexp", "-g", "--glob", "-t", "--type", "-T", "--type-not", "-A", "-B", "-C", "-m", "--max-count"]),
  ag: new Set(["-G", "-A", "-B", "-C", "-m", "--max-count"]),
  sed: new Set(["-e", "--expression"]),
  awk: new Set(["-v", "-F"]),
  node: new Set(["-e", "--eval", "-p", "--print"]),
  bun: new Set(["-e", "--eval", "-p", "--print"]),
  python: new Set(["-c"]),
  python3: new Set(["-c"]),
  ruby: new Set(["-e"]),
  perl: new Set(["-e", "-E"]),
  sh: new Set(["-c"]),
  bash: new Set(["-c"]),
  zsh: new Set(["-c"]),
};

const FACTORY_TEXT_FLAGS = new Set(["--note", "--comment", "--reason", "--summary", "--prompt", "--title", "--detail", "--message"]);
const TWO_ARG_SKIP_FLAGS: Record<string, Set<string>> = {
  jq: new Set(["--arg", "--argjson"]),
};
const PATTERN_CMDS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "sed", "awk", "jq"]);
const PATTERN_GIVEN_FLAGS = new Set(["-e", "--regexp", "--expression", "-f", "--file", "--from-file", "--files"]);

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
];

// Extracts `$(...)` and backtick substitutions from a double-quoted or unquoted
// here-document body line.
function extractSubstitutions(text: string, subs: string[]) {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
    } else if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      const stop = end < 0 ? text.length : end;
      subs.push(text.slice(i + 1, stop));
      i = stop;
    } else if (ch === "$" && text[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")" && --depth === 0) break;
      }
      subs.push(text.slice(i + 2, j));
      i = j;
    }
  }
}

// Splits a line at `; & | `` and newlines outside quotes, so an argument such
// as 'shell(git stash)' or "$(a | b)" stays in its command. A `$(...)`,
// backtick substitution, or unquoted `(...)` subshell is returned in `subs`.
// Preserves `>|` redirects and skips literal here-document bodies (while still
// scanning unquoted here-document bodies for command substitutions).
function split(line: string) {
  const segs: string[] = [];
  const subs: string[] = [];
  const heredocs: { delim: string; stripTabs: boolean; quoted: boolean }[] = [];
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
    } else if (ch === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
      cur += "<<";
      let k = i + 2;
      const stripTabs = line[k] === "-";
      if (stripTabs) k++;
      while (k < line.length && (line[k] === " " || line[k] === "\t")) k++;
      let delim = "";
      let dq = "";
      let quoted = false;
      for (; k < line.length; k++) {
        const c = line[k];
        if (dq) {
          if (c === dq) dq = "";
          else delim += c;
        } else if (c === "'" || c === '"') {
          dq = c;
          quoted = true;
        } else if (c === "\\" && k + 1 < line.length) {
          quoted = true;
          delim += line[++k];
        } else if (/[\s;&|()<>]/.test(c)) {
          break;
        } else {
          delim += c;
        }
      }
      if (delim) heredocs.push({ delim, stripTabs, quoted });
      i++;
    } else if (ch === "(") {
      let depth = 0;
      let j = i;
      let sq = "";
      for (; j < line.length; j++) {
        const c = line[j];
        if (c === "\\" && sq !== "'") {
          j++;
        } else if (sq) {
          if (c === sq) sq = "";
        } else if (c === "'" || c === '"') {
          sq = c;
        } else if (c === "(") {
          depth++;
        } else if (c === ")" && --depth === 0) {
          break;
        }
      }
      subs.push(line.slice(i + 1, j));
      cur += line.slice(i, j + 1);
      i = j;
    } else if (ch === "&" && line[i + 1] === "&") {
      segs.push(cur);
      cur = "";
      i++;
    } else if (ch === "&" && (line[i + 1] === ">" || cur.endsWith(">") || cur.endsWith("<"))) {
      cur += ch;
    } else if (ch === "&") {
      segs.push(`${cur} &`);
      cur = "";
    } else if (ch === "|" && cur.endsWith(">")) {
      cur += ch;
    } else if (ch === "\n") {
      segs.push(cur);
      cur = "";
      for (let doc = heredocs.shift(); doc && i + 1 < line.length; doc = heredocs.shift()) {
        while (i + 1 < line.length) {
          const nl = line.indexOf("\n", i + 1);
          const end = nl < 0 ? line.length : nl;
          let bodyLine = line.slice(i + 1, end).replace(/\r$/, "");
          if (doc.stripTabs) bodyLine = bodyLine.replace(/^\t+/, "");
          i = end;
          if (bodyLine === doc.delim) break;
          if (!doc.quoted) extractSubstitutions(bodyLine, subs);
        }
      }
    } else if (";|`".includes(ch)) {
      segs.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  segs.push(cur);
  return { segs, subs };
}

function unwrapInner(seg: string): string | null {
  const inner = seg.match(/^rex\b.*?\s--\s+(.+)$/)?.[1] ?? seg.match(/^(?:ba|z)?sh\s+(?:-\w+\s+)*-c\s+(.+)$/)?.[1];
  return inner ? inner.replace(/^['"]|['"]$/g, "") : null;
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
    seg = seg.trim().replace(CMD_PREFIX, "");
    if (!seg) continue;
    if (detached && !seg.endsWith(" &")) seg += " &";
    out.push(seg);
    const inner = unwrapInner(seg);
    if (inner) out.push(...commands(inner));
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

function varBase(name: string) {
  return name === "TMPDIR" ? resolve(process.env.TMPDIR || tmpdir()) : resolve(homedir());
}

function expandLeadingVar(p: string) {
  if (/^~(?=$|\/)/.test(p)) return homedir() + p.slice(1);
  const m = p.match(LEADING_VAR);
  if (!m) return p;
  const base = varBase(m[1] || m[2]);
  const tail = p.slice(m[0].length);
  return tail ? `${base}${tail}` : base;
}

function isInsideRoot(target: string, root: string, realRoot: string) {
  return (
    root === sep ||
    target === root ||
    target.startsWith(root + sep) ||
    (realRoot !== root && (target === realRoot || target.startsWith(realRoot + sep)))
  );
}

function denyEscape(raw: string, suggested: string): Decision {
  return {
    name: "no-relative-escape",
    reason: `${raw} leaves the working directory. Use the absolute path ${suggested} instead.`,
  };
}

// Returns a deny decision when `raw` contains a `..` segment that resolves
// outside `cwd` (or uses `..` to reach `$TMPDIR` or `$HOME`). Paths whose `..`
// segments stay inside `cwd`, and plain absolute paths, return null.
function escapeDecision(raw: string, cwd: string, curDir = resolve(cwd)): Decision | null {
  const parentMatch = raw.match(PARENT_SEG);
  if (!parentMatch || parentMatch.index === undefined) return null;

  // Malformed parent-prefix variable path such as `../../../../$TMPDIR/x` or
  // `/abs/.../..$TMPDIR/x`: always deny and name the expanded absolute path.
  KNOWN_VAR.lastIndex = 0;
  for (const m of raw.matchAll(KNOWN_VAR)) {
    if (m.index !== undefined && m.index > parentMatch.index) {
      const base = varBase(m[1] || m[2]);
      const rest = raw.slice(m.index + m[0].length).replace(/^\/+/, "");
      return denyEscape(raw, rest ? resolve(base, rest) : base);
    }
  }

  // Check both initial cwd (matching Copilot's static sandbox check on each
  // command segment) and tracked curDir (so suggested paths reflect prior cd).
  const root = resolve(cwd);
  const realRoot = real(root);
  const expanded = expandLeadingVar(raw);
  const fromCwd = resolve(root, expanded);
  const fromCur = resolve(curDir, expanded);
  if (isInsideRoot(fromCwd, root, realRoot) && isInsideRoot(fromCur, root, realRoot)) return null;
  return denyEscape(raw, fromCur);
}

type Token = { value: string; redirect: boolean; skip: boolean };

// Tokenizes a single shell command segment into words, marking file redirection
// targets (`redirect: true`) and skipping heredoc delimiters / fd dups.
function tokenize(cmd: string): Token[] {
  const tokens: Token[] = [];
  let cur = "";
  let inWord = false;
  let nextRedirect = false;
  let nextSkip = false;
  let quote = "";

  const flush = () => {
    if (!inWord) return;
    tokens.push({ value: cur, redirect: nextRedirect, skip: nextSkip });
    cur = "";
    inWord = false;
    nextRedirect = false;
    nextSkip = false;
  };

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote === "'") {
      if (ch === "'") quote = "";
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = "";
      else if (ch === "\\" && i + 1 < cmd.length && '"\\$`\n'.includes(cmd[i + 1])) cur += cmd[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i];
      inWord = true;
      continue;
    }
    if (ch === "#" && !inWord) break;
    if (/\s/.test(ch) || ch === ")") {
      flush();
      continue;
    }
    if (!inWord) {
      const redir = cmd.slice(i).match(/^(?:&>>|&>|(?:\d+)?(?:>>|<>|>\||>&|<<-?|<<<|>|<))/);
      if (redir) {
        const op = redir[0];
        nextSkip = /(?:\d+)?(?:>&|<<-?|<<<)$/.test(op);
        nextRedirect = !nextSkip;
        i += op.length - 1;
        continue;
      }
    } else if (ch === ">" || ch === "<") {
      flush();
      i--;
      continue;
    }
    cur += ch;
    inWord = true;
  }
  flush();
  return tokens;
}

function checkSegment(seg: string, cwd: string, state: { curDir: string }): Decision | null {
  const tokens = tokenize(seg);
  for (const tok of tokens) {
    if (tok.redirect) {
      const hit = escapeDecision(tok.value, cwd, state.curDir);
      if (hit) return hit;
    }
  }
  const words = tokens.filter((t) => !t.redirect && !t.skip).map((t) => t.value);
  if (words.length === 0) return null;

  const cmdHit = escapeDecision(words[0], cwd, state.curDir);
  if (cmdHit) return cmdHit;

  const cmd = basename(words[0]);
  if (NON_PATH_CMDS.has(cmd)) return null;

  if (cmd === "cd") {
    let target: string | undefined;
    let afterDash = false;
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (!afterDash && w === "--") {
        afterDash = true;
        continue;
      }
      if (!afterDash && w.startsWith("-") && w !== "-") continue;
      target = w;
      break;
    }
    if (!target) {
      state.curDir = resolve(homedir());
      return null;
    }
    if (target === "-") return null;
    const hit = escapeDecision(target, cwd, state.curDir);
    if (hit) return hit;
    state.curDir = resolve(state.curDir, expandLeadingVar(target));
    return null;
  }

  const isFactoryCli =
    (cmd === "node" || cmd === "bun") && words.find((w, idx) => idx > 0 && !w.startsWith("-"))?.endsWith("factory.mjs");
  const skipFlags = isFactoryCli ? FACTORY_TEXT_FLAGS : SKIP_VALUE_FLAGS[cmd];
  const twoArgFlags = TWO_ARG_SKIP_FLAGS[cmd];
  const isPatternCmd = PATTERN_CMDS.has(cmd);

  let afterDash = false;
  let patternGiven = false;
  let positionalCount = 0;

  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (!afterDash && w === "--") {
      if (cmd === "rex") break;
      afterDash = true;
      continue;
    }
    if (!afterDash && w.startsWith("-") && w !== "-") {
      if (twoArgFlags?.has(w)) {
        i += 2;
        continue;
      }
      if (isPatternCmd && PATTERN_GIVEN_FLAGS.has(w)) patternGiven = true;
      if (skipFlags?.has(w)) {
        i++;
        continue;
      }
      const eq = w.indexOf("=");
      if (eq > 0) {
        const flag = w.slice(0, eq);
        if (isPatternCmd && PATTERN_GIVEN_FLAGS.has(flag)) patternGiven = true;
        if (skipFlags?.has(flag)) continue;
        const hit = escapeDecision(w.slice(eq + 1), cwd, state.curDir);
        if (hit) return hit;
        continue;
      }
      // Attached short flag value such as `git -C../outside` or `tar -C../dir`.
      if (!w.startsWith("--") && w.length > 2) {
        const shortFlag = w.slice(0, 2);
        if (isPatternCmd && PATTERN_GIVEN_FLAGS.has(shortFlag)) patternGiven = true;
        if (skipFlags?.has(shortFlag)) continue;
        const hit = escapeDecision(w.slice(2), cwd, state.curDir);
        if (hit) return hit;
      }
      continue;
    }

    positionalCount++;
    if (isPatternCmd && !patternGiven && positionalCount === 1) continue;
    const hit = escapeDecision(w, cwd, state.curDir);
    if (hit) return hit;
  }
  return null;
}

function bashEscape(script: string, cwd: string, startDir = resolve(cwd)): Decision | null {
  const { segs, subs } = split(script);
  for (const sub of subs) {
    const hit = bashEscape(sub, cwd, startDir);
    if (hit) return hit;
  }
  const state = { curDir: startDir };
  for (let seg of segs) {
    seg = seg.trim().replace(CMD_PREFIX, "");
    if (!seg) continue;
    const hit = checkSegment(seg, cwd, state);
    if (hit) return hit;
    const inner = unwrapInner(seg);
    if (inner) {
      const innerHit = bashEscape(inner, cwd, state.curDir);
      if (innerHit) return innerHit;
    }
  }
  return null;
}

function rawTargets(tool: string, args: ToolArgs): string[] {
  const paths: string[] = [];
  if (typeof args.path === "string") paths.push(args.path);
  if (typeof args.paths === "string") paths.push(args.paths);
  else if (Array.isArray(args.paths)) {
    for (const p of args.paths) {
      if (typeof p === "string") paths.push(p);
    }
  }
  if (tool === "apply_patch") {
    for (const m of JSON.stringify(args).matchAll(/\*\*\* (?:(?:Add|Update|Delete) File|Move to): ([^\\"]+)/g)) {
      paths.push(m[1]);
    }
  }
  return paths;
}

function targets(tool: string, args: ToolArgs, cwd: string) {
  return rawTargets(tool, args).map((p) => resolve(cwd, p.replace(/^~(?=$|\/)/, homedir())));
}

type ToolArgs = { path?: unknown; paths?: unknown; command?: unknown };
type Payload = { toolName?: string; toolArgs?: string | ToolArgs | null; cwd?: string };

function decide({ toolName = "", toolArgs, cwd = process.cwd() }: Payload, coordinator: boolean): Decision | null {
  if (coordinator && DENIED_TOOLS.includes(toolName)) {
    return { name: "no-subagents", reason: "The factory uses Rex workers. Never use subagents or workflows." };
  }
  const args = typeof toolArgs === "string" ? JSON.parse(toolArgs) : (toolArgs ?? {});
  if (toolName === "bash") {
    const script = String(args.command ?? "");
    if (coordinator) {
      for (const command of commands(script)) {
        const rule = BASH_RULES.find((r) => r.deny(command));
        if (rule) return rule;
      }
    }
    const hit = bashEscape(script, cwd);
    if (hit) return hit;
  }
  if (PATH_TOOLS.includes(toolName)) {
    for (const raw of rawTargets(toolName, args)) {
      const hit = escapeDecision(raw, cwd);
      if (hit) return hit;
    }
  }
  if (coordinator && WRITE_TOOLS.includes(toolName)) {
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
    const coordinator = isCoordinator(input);
    const hit = coordinator || isWorker(input) ? decide(input, coordinator) : null;
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
