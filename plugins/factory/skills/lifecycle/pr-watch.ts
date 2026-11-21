#!/usr/bin/env node
// Watches one pull request with one GraphQL call per tick (one more per extra
// page of 100 checks or review threads) and exits on the first typed event.
// Where `gh event listen` works, a listener only wakes the next tick; the
// classification is the same either way. Dependency-free; talks to GitHub only
// through `gh`.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);

type Options = { pr: string | null; repo: string | null; merge: boolean; interval: number; timeout: number | null };
type Target = { host: string; owner: string; repo: string; number: number; url: string };
type Node = {
  __typename: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  isRequired: boolean;
};
type ChecksSummary = { state: string; failed: string[]; cancelled: string[] };
type Review = { decision: string | null; latest: { id: string; state: string } | null; unresolved: number };
type Snapshot = {
  state: string;
  merged: boolean;
  mergeCommit: string | null;
  head: string;
  base: string;
  draft: boolean;
  mergeable: string;
  mergeState: string;
  review: Review;
  checks: ChecksSummary;
};
type Limit = { cost: number; remaining: number; resetAt: string };
type Event = { event: string; [key: string]: unknown };

const USAGE = `Usage: node factory.mjs pr-watch [PR] [--repo OWNER/REPO] [--merge] [--interval S] [--timeout S]

Watch a pull request. Print one JSON line at the first event.

  PR               number or URL. Default: the PR of the current branch
  --repo, -R REPO  repository, OWNER/REPO (the command also reads GH_REPO)
  --merge          report only merged or closed
  --interval S     seconds between checks. Default 30, minimum 15
                   (PR_WATCH_MIN_INTERVAL changes the minimum). The command
                   uses it only when "gh event listen" is not available
  --timeout S      after S seconds, print a timeout event and exit 0
  -h, --help       print this help

Events: merged, closed, checks (a required check failed, was cancelled, or all
passed), head, review, conflict, draft, base, timeout, rate_limited, error.
Exit codes: 0 event, 1 error, 2 usage, 3 rate limited (retry_at in the JSON).
The next check retries a transient failure (HTTP 502/503/504, connection reset,
timeout, EOF). The fifth failure in a row is an error.
If the PR is already merged or closed, or a required check failed, the command
exits at once.
On github.com, "gh event listen" (preview) starts each check. It replaces the
interval, with a safety check every 5 minutes. If "gh event listen" fails, the
command polls on the interval.`;

// Both connections are paged. The first call has no cursors; a PR with 100 items
// or fewer needs no other call.
const QUERY = `query($owner: String!, $repo: String!, $number: Int!, $threadsAfter: String, $contextsAfter: String) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      state merged mergeCommit { oid } headRefOid baseRefOid isDraft
      mergeable mergeStateStatus reviewDecision
      reviews(last: 1) { nodes { id state } }
      reviewThreads(first: 100, after: $threadsAfter) { pageInfo { hasNextPage endCursor } nodes { isResolved } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100, after: $contextsAfter) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on CheckRun { name status conclusion isRequired(pullRequestNumber: $number) }
          ... on StatusContext { context state isRequired(pullRequestNumber: $number) }
        }
      } } } } }
    }
  }
}`;

const FAILED = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const RATE_LIMIT = /rate limit|abuse detection|HTTP 429|RATE_LIMITED/i;
const TRANSIENT = /HTTP 50[234]\b|bad gateway|service unavailable|gateway time-?out|ECONNRESET|connection reset|ETIMEDOUT|timed? ?out|\bEOF\b/i;
const MAX_TRANSIENT = 5;
const RETRY_AFTER = 5 * 60;
const SAFETY_CHECK = 5 * 60 * 1000;
const EVENTS = [
  "review.submitted.v1",
  "state.changed.v1",
  "head.changed.v1",
  "merge_conflict.v1",
  "check_suite.status.changed.v1",
].map((type) => `com.github.pull_request.${type}`).join(",");

function usageError(message: string): never {
  process.stderr.write(`pr-watch: ${message}\n${USAGE}\n`);
  process.exit(2);
}

function parseOptions(argv: string[]): Options {
  const opts: Options = { pr: null, repo: null, merge: false, interval: 30, timeout: null };
  const minimum = process.env.PR_WATCH_MIN_INTERVAL === undefined ? 15 : Number(process.env.PR_WATCH_MIN_INTERVAL);
  const number = (flag: string, value: string | boolean | undefined, min: number) => {
    const n = Number(value);
    if (typeof value !== "string" || !Number.isFinite(n) || n <= 0 || n < min) {
      usageError(`${flag} needs a number of seconds${min > 0 ? ` of at least ${min}` : " greater than 0"}`);
    }
    return n;
  };
  const { tokens } = parseArgs({
    args: argv,
    strict: false,
    allowPositionals: true,
    tokens: true,
    options: {
      help: { type: "boolean", short: "h" },
      merge: { type: "boolean" },
      repo: { type: "string", short: "R" },
      interval: { type: "string" },
      timeout: { type: "string" },
    },
  });
  // Tokens keep the order of the arguments, so the first bad argument is the one reported.
  for (const token of tokens) {
    if (token.kind === "option-terminator") usageError("unknown flag --");
    if (token.kind === "positional") {
      if (token.value.startsWith("-")) usageError(`unknown flag ${token.value}`);
      if (opts.pr !== null) usageError("only one PR is allowed");
      opts.pr = token.value;
      continue;
    }
    const { name, rawName, value } = token;
    const known = ["help", "merge", "repo", "interval", "timeout"].includes(name);
    const boolean = name === "help" || name === "merge";
    if (!known || (boolean && token.inlineValue)) usageError(`unknown flag ${rawName}${token.inlineValue ? `=${value}` : ""}`);
    if (name === "help") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (name === "merge") opts.merge = true;
    else if (name === "repo") {
      if (typeof value !== "string" || !value) usageError(`${rawName} needs OWNER/REPO`);
      opts.repo = value;
    } else if (name === "interval") opts.interval = number(rawName, value, minimum);
    else opts.timeout = number(rawName, value, 0);
  }
  return opts;
}

class RateLimited extends Error {
  retryAt: string;

  constructor(message: string, retryAt: string) {
    super(message);
    this.retryAt = retryAt;
  }
}

class Transient extends Error {}

async function gh(args: string[]) {
  try {
    return (await run("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    const text = [failure.stderr, failure.stdout].filter(Boolean).join("\n").trim() || failure.message;
    if (RATE_LIMIT.test(text)) throw new RateLimited(text.split("\n")[0], retryAt(text));
    if (failure.code === "ENOENT") throw new Error("gh is not installed or is not on PATH");
    throw new (TRANSIENT.test(text) ? Transient : Error)(text);
  }
}

function retryAt(text: string) {
  const after = /retry-after:?\s*(\d+)/i.exec(text);
  const reset = /x-ratelimit-reset:?\s*(\d+)/i.exec(text);
  const seconds = after ? Number(after[1]) : reset ? Number(reset[1]) - Date.now() / 1000 : RETRY_AFTER;
  return new Date(Date.now() + Math.max(seconds, 1) * 1000).toISOString();
}

async function resolve({ pr, repo }: Options): Promise<Target> {
  const args = ["pr", "view", ...(pr ? [pr] : []), ...(repo ? ["--repo", repo] : []), "--json", "number,url"];
  const { number, url } = JSON.parse(await gh(args));
  const { hostname, pathname } = new URL(url);
  const [owner, name] = pathname.split("/").filter(Boolean);
  return { host: hostname, owner, repo: name, number, url };
}

function checkState(node: Node) {
  if (node.__typename === "CheckRun") {
    if (node.status !== "COMPLETED") return "pending";
    if (node.conclusion === "SUCCESS") return "passed";
    if (FAILED.has(node.conclusion as string)) return "failed";
    return node.conclusion === "CANCELLED" ? "cancelled" : "other";
  }
  if (node.state === "SUCCESS") return "passed";
  return FAILED.has(node.state as string) ? "failed" : "pending";
}

// Only required checks count. An empty required set is "none", never "passed".
function summarizeChecks(contexts: Node[]): ChecksSummary {
  const required = contexts
    .filter((node) => node.isRequired)
    .map((node) => ({ name: (node.name ?? node.context) as string, state: checkState(node) }));
  const names = (state: string) => required.filter((check) => check.state === state).map((check) => check.name);
  const failed = names("failed");
  const cancelled = names("cancelled");
  let state = "passed";
  if (required.length === 0) state = "none";
  else if (failed.length) state = "failed";
  else if (cancelled.length) state = "cancelled";
  else if (names("pending").length) state = "pending";
  else if (required.some((check) => check.state === "other")) state = "other";
  return { state, failed, cancelled };
}

// Follows both cursors until neither connection has another page. A finished
// connection keeps its last cursor and returns an empty page. A failed page
// throws, so a partial list is never summarized.
async function fetchPages(target: Target) {
  let first: any = null;
  let threads: { isResolved: boolean }[] = [];
  let contexts: Node[] = [];
  let threadsAfter: string | null = null;
  let contextsAfter: string | null = null;
  for (;;) {
    const out = await gh([
      "api", "graphql", "--hostname", target.host,
      "-f", `query=${QUERY}`, "-f", `owner=${target.owner}`, "-f", `repo=${target.repo}`, "-F", `number=${target.number}`,
      ...(threadsAfter ? ["-f", `threadsAfter=${threadsAfter}`] : []),
      ...(contextsAfter ? ["-f", `contextsAfter=${contextsAfter}`] : []),
    ]);
    const { data } = JSON.parse(out);
    const pr = data.repository.pullRequest;
    first ??= pr;
    if (pr.headRefOid !== first.headRefOid) throw new Transient("head changed while paging");
    const rollup = pr.commits.nodes[0]?.commit?.statusCheckRollup?.contexts;
    threads = threads.concat(pr.reviewThreads.nodes);
    contexts = contexts.concat(rollup?.nodes ?? []);
    if (!pr.reviewThreads.pageInfo.hasNextPage && !rollup?.pageInfo.hasNextPage) {
      return { pr: first, limit: data.rateLimit, threads, contexts };
    }
    threadsAfter = pr.reviewThreads.pageInfo.endCursor;
    contextsAfter = rollup?.pageInfo.endCursor ?? null;
  }
}

async function fetchSnapshot(target: Target): Promise<{ snapshot: Snapshot; limit: Limit }> {
  const { pr, limit, threads, contexts } = await fetchPages(target);
  const review = pr.reviews.nodes[0];
  return {
    snapshot: {
      state: pr.state,
      merged: pr.merged,
      mergeCommit: pr.mergeCommit?.oid ?? null,
      head: pr.headRefOid,
      base: pr.baseRefOid,
      draft: pr.isDraft,
      mergeable: pr.mergeable,
      mergeState: pr.mergeStateStatus,
      review: {
        decision: pr.reviewDecision,
        latest: review ? { id: review.id, state: review.state } : null,
        unresolved: threads.filter((thread) => !thread.isResolved).length,
      },
      checks: summarizeChecks(contexts),
    },
    limit,
  };
}

// Compares a tick with the startup snapshot. Terminal states win, then a failed
// required check, then the rest. Noise (updatedAt, title, body, labels,
// comments, non-required checks) is not in the snapshot, so it never wakes.
function detect(base: Snapshot, now: Snapshot, mergeOnly: boolean): Event | null {
  if (now.state === "MERGED") return { event: "merged" };
  if (now.state === "CLOSED") return { event: "closed" };
  if (mergeOnly) return null;
  if (now.checks.state === "failed" && base.checks.state !== "failed") return { event: "checks" };
  if (now.head !== base.head) return { event: "head", previous_head: base.head };
  if (now.checks.state === "cancelled" && base.checks.state !== "cancelled") return { event: "checks" };
  const a = base.review;
  const b = now.review;
  if (a.decision !== b.decision || a.latest?.id !== b.latest?.id || a.latest?.state !== b.latest?.state || a.unresolved !== b.unresolved) {
    return { event: "review" };
  }
  if (now.mergeable !== "UNKNOWN" && now.mergeable !== base.mergeable) return { event: "conflict" };
  if (now.draft !== base.draft) return { event: "draft" };
  if (now.base !== base.base) return { event: "base", previous_base: base.base };
  if (now.checks.state === "passed" && base.checks.state !== "passed") return { event: "checks" };
  return null;
}

// A PR that is already terminal or has a failed required check is not a wait.
function startupEvent(snapshot: Snapshot, mergeOnly: boolean): Event | null {
  if (snapshot.state === "MERGED" || snapshot.state === "CLOSED") return detect(snapshot, snapshot, mergeOnly);
  if (!mergeOnly && snapshot.checks.state === "failed") return { event: "checks" };
  return null;
}

function report(target: Target | null, snapshot: Snapshot | null, extra: Event) {
  const out: Record<string, unknown> = {
    ...extra,
    pr: target?.number ?? null,
    url: target?.url ?? null,
    head: snapshot?.head ?? null,
    state: snapshot?.state ?? null,
    checks: snapshot ? { state: snapshot.checks.state, failed: snapshot.checks.failed, cancelled: snapshot.checks.cancelled } : null,
    review: snapshot ? { decision: snapshot.review.decision, latest: snapshot.review.latest } : null,
    mergeable: snapshot?.mergeable ?? null,
    at: new Date().toISOString(),
  };
  if (extra.event === "merged") out.merge_commit = snapshot?.mergeCommit;
  if (extra.event === "closed" || extra.event === "merged") out.merged = snapshot?.merged;
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One `gh event listen --follow` child, used only as a wake-up signal: events
// are not replayed, so the caller reads the PR once attached and after each wake.
// The child ending for any reason means the feature is unavailable or broken.
class Listener {
  alive = true;
  attached = false;
  pending = false;
  error = "";
  child: ChildProcess;
  #wake: (() => void) | null = null;

  constructor(url: string) {
    this.child = spawn("gh", ["event", "listen", "--follow", "--resource", url, "--event", EVENTS], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout?.on("data", () => {
      this.pending = true;
      this.#wake?.();
    });
    // The first stderr line is the attach message, or the reason for failing.
    this.child.stderr?.on("data", (chunk) => {
      this.error ||= String(chunk).trim().split("\n")[0];
      this.attached = true;
      this.#wake?.();
    });
    const end = (error?: Error) => {
      this.alive = false;
      this.error ||= error?.message ?? "";
      this.#wake?.();
    };
    this.child.on("error", end);
    this.child.on("exit", () => end());
  }

  // Returns when ready() holds, the child ended, or ms passed.
  async until(ready: () => boolean, ms: number) {
    if (ready() || !this.alive) return;
    let timer: ReturnType<typeof setTimeout>;
    await new Promise<void>((resolve) => {
      this.#wake = resolve;
      timer = setTimeout(resolve, ms);
    });
    clearTimeout(timer!);
    this.#wake = null;
  }

  async wait(ms: number) {
    await this.until(() => this.pending, ms);
    this.pending = false;
  }

  stop() {
    this.child.kill();
  }
}

async function watch(opts: Options) {
  const deadline = opts.timeout === null ? Infinity : Date.now() + opts.timeout * 1000;
  let target: Target | null = null;
  let base: Snapshot | null = null;
  let last: Snapshot | null = null;
  let failures = 0;
  // undefined: not tried; null: unavailable, poll.
  let listener: Listener | null | undefined;
  try {
    for (;;) {
      let fetched: { snapshot: Snapshot; limit: Limit } | null = null;
      try {
        target ??= await resolve(opts);
        if (listener === undefined) {
          listener = target.host === "github.com" ? new Listener(target.url) : null;
          await listener?.until(() => listener!.attached, Math.min(deadline - Date.now(), SAFETY_CHECK));
        }
        fetched = await fetchSnapshot(target);
        failures = 0;
      } catch (error) {
        // A transient failure retries on the next tick; the Nth in a row is an error.
        if (!(error instanceof Transient) || ++failures >= MAX_TRANSIENT) throw error;
        process.stderr.write(`pr-watch: transient failure ${failures}/${MAX_TRANSIENT}: ${error.message.split("\n")[0]}\n`);
      }
      if (fetched) {
        const { snapshot, limit } = fetched;
        last = snapshot;
        let event: Event | null;
        if (base === null) {
          base = snapshot;
          event = startupEvent(snapshot, opts.merge);
        } else {
          if (base.mergeable === "UNKNOWN") base.mergeable = snapshot.mergeable;
          event = detect(base, snapshot, opts.merge);
        }
        if (event) return report(target, snapshot, event);
        if (limit.remaining < limit.cost * 2) {
          throw new RateLimited(`only ${limit.remaining} GraphQL points left`, new Date(limit.resetAt).toISOString());
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return report(target, last, { event: "timeout", timeout: true });
      if (listener && !listener.alive) {
        process.stderr.write(`pr-watch: gh event listen is unavailable, polling: ${listener.error.split("\n")[0]}\n`);
        listener = null;
      }
      // After a transient failure, retry on the interval rather than wait for an event.
      if (listener && failures === 0) await listener.wait(Math.min(SAFETY_CHECK, remaining));
      // Jitter keeps several lanes from hitting GitHub on the same second.
      else await sleep(Math.min(opts.interval * 1000 * (0.9 + Math.random() * 0.2), remaining));
    }
  } finally {
    listener?.stop();
  }
}

export async function main(argv: string[]) {
  const opts = parseOptions(argv);
  try {
    await watch(opts);
  } catch (error) {
    if (error instanceof RateLimited) {
      process.stdout.write(`${JSON.stringify({ event: "rate_limited", retry_at: error.retryAt, reason: error.message })}\n`);
      process.exitCode = 3;
    } else {
      const { message } = error as Error;
      process.stdout.write(`${JSON.stringify({ event: "error", message })}\n`);
      process.stderr.write(`pr-watch: ${message}\n`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main(process.argv.slice(2));
