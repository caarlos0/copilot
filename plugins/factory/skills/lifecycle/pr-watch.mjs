#!/usr/bin/env node
// Watches one pull request with one GraphQL call per tick and exits on the
// first typed event. Dependency-free; talks to GitHub only through `gh`.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const USAGE = `Usage: pr-watch.mjs [PR] [--repo OWNER/REPO] [--merge] [--interval S] [--timeout S]

Watch a pull request and print one JSON line on the first event.

  PR               number or URL; default: the PR of the current branch
  --repo, -R REPO  repository, OWNER/REPO (GH_REPO is honored)
  --merge          only report merged or closed
  --interval S     seconds between checks, default 30, minimum 15
                   (PR_WATCH_MIN_INTERVAL overrides the minimum)
  --timeout S      print a timeout event and exit 0 after S seconds
  -h, --help       print this help

Events: merged, closed, checks (a required check failed, was cancelled, or all
passed), head, review, conflict, draft, base, timeout, rate_limited, error.
Exit codes: 0 event, 1 error, 2 usage, 3 rate limited (retry_at in the JSON).
A PR that already merged, closed, or has a failed required check exits at once.`;

const QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      state merged mergeCommit { oid } headRefOid baseRefOid isDraft
      mergeable mergeStateStatus reviewDecision
      reviews(last: 1) { nodes { id state } }
      reviewThreads(first: 100) { nodes { isResolved } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion isRequired(pullRequestNumber: $number) }
        ... on StatusContext { context state isRequired(pullRequestNumber: $number) }
      } } } } } }
    }
  }
}`;

const FAILED = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const RATE_LIMIT = /rate limit|abuse detection|HTTP 429|RATE_LIMITED/i;
const RETRY_AFTER = 5 * 60;

function usageError(message) {
  process.stderr.write(`pr-watch: ${message}\n${USAGE}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { pr: null, repo: null, merge: false, interval: 30, timeout: null };
  const minimum = process.env.PR_WATCH_MIN_INTERVAL === undefined ? 15 : Number(process.env.PR_WATCH_MIN_INTERVAL);
  const number = (flag, value, min) => {
    const n = Number(value);
    if (value === undefined || !Number.isFinite(n) || n <= 0 || n < min) {
      usageError(`${flag} needs a number of seconds${min > 0 ? ` of at least ${min}` : " greater than 0"}`);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (arg === "--merge") opts.merge = true;
    else if (arg === "--repo" || arg === "-R") {
      opts.repo = argv[++i];
      if (!opts.repo) usageError(`${arg} needs OWNER/REPO`);
    } else if (arg === "--interval") opts.interval = number(arg, argv[++i], minimum);
    else if (arg === "--timeout") opts.timeout = number(arg, argv[++i], 0);
    else if (arg.startsWith("-")) usageError(`unknown flag ${arg}`);
    else if (opts.pr === null) opts.pr = arg;
    else usageError("only one PR is allowed");
  }
  return opts;
}

class RateLimited extends Error {
  constructor(message, retryAt) {
    super(message);
    this.retryAt = retryAt;
  }
}

async function gh(args) {
  try {
    return (await run("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch (error) {
    const text = [error.stderr, error.stdout].filter(Boolean).join("\n").trim() || error.message;
    if (RATE_LIMIT.test(text)) throw new RateLimited(text.split("\n")[0], retryAt(text));
    throw new Error(error.code === "ENOENT" ? "gh is not installed or not on PATH" : text);
  }
}

function retryAt(text) {
  const after = /retry-after:?\s*(\d+)/i.exec(text);
  const reset = /x-ratelimit-reset:?\s*(\d+)/i.exec(text);
  const seconds = after ? Number(after[1]) : reset ? Number(reset[1]) - Date.now() / 1000 : RETRY_AFTER;
  return new Date(Date.now() + Math.max(seconds, 1) * 1000).toISOString();
}

async function resolve({ pr, repo }) {
  const args = ["pr", "view", ...(pr ? [pr] : []), ...(repo ? ["--repo", repo] : []), "--json", "number,url"];
  const { number, url } = JSON.parse(await gh(args));
  const { hostname, pathname } = new URL(url);
  const [owner, name] = pathname.split("/").filter(Boolean);
  return { host: hostname, owner, repo: name, number, url };
}

function checkState(node) {
  if (node.__typename === "CheckRun") {
    if (node.status !== "COMPLETED") return "pending";
    if (node.conclusion === "SUCCESS") return "passed";
    if (FAILED.has(node.conclusion)) return "failed";
    return node.conclusion === "CANCELLED" ? "cancelled" : "other";
  }
  if (node.state === "SUCCESS") return "passed";
  return FAILED.has(node.state) ? "failed" : "pending";
}

// Only required checks count. An empty required set is "none", never "passed".
function summarizeChecks(contexts) {
  const required = contexts
    .filter((node) => node.isRequired)
    .map((node) => ({ name: node.name ?? node.context, state: checkState(node) }));
  const names = (state) => required.filter((check) => check.state === state).map((check) => check.name);
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

async function fetchSnapshot(target) {
  const out = await gh([
    "api", "graphql", "--hostname", target.host,
    "-f", `query=${QUERY}`, "-f", `owner=${target.owner}`, "-f", `repo=${target.repo}`, "-F", `number=${target.number}`,
  ]);
  const { data } = JSON.parse(out);
  const pr = data.repository.pullRequest;
  const commit = pr.commits.nodes[0]?.commit;
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
        unresolved: pr.reviewThreads.nodes.filter((thread) => !thread.isResolved).length,
      },
      checks: summarizeChecks(commit?.statusCheckRollup?.contexts.nodes ?? []),
    },
    limit: data.rateLimit,
  };
}

// Compares a tick with the startup snapshot. Terminal states win, then a failed
// required check, then the rest. Noise (updatedAt, title, body, labels,
// comments, non-required checks) is not in the snapshot, so it never wakes.
function detect(base, now, mergeOnly) {
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
function startupEvent(snapshot, mergeOnly) {
  if (snapshot.state === "MERGED" || snapshot.state === "CLOSED") return detect(snapshot, snapshot, mergeOnly);
  if (!mergeOnly && snapshot.checks.state === "failed") return { event: "checks" };
  return null;
}

function report(target, snapshot, extra) {
  const out = {
    ...extra,
    pr: target.number,
    url: target.url,
    head: snapshot?.head ?? null,
    state: snapshot?.state ?? null,
    checks: snapshot ? { state: snapshot.checks.state, failed: snapshot.checks.failed, cancelled: snapshot.checks.cancelled } : null,
    review: snapshot ? { decision: snapshot.review.decision, latest: snapshot.review.latest } : null,
    mergeable: snapshot?.mergeable ?? null,
    at: new Date().toISOString(),
  };
  if (extra.event === "merged") out.merge_commit = snapshot.mergeCommit;
  if (extra.event === "closed" || extra.event === "merged") out.merged = snapshot.merged;
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function watch(opts) {
  const target = await resolve(opts);
  const deadline = opts.timeout === null ? Infinity : Date.now() + opts.timeout * 1000;
  let base = null;
  let last = null;
  for (;;) {
    const { snapshot, limit } = await fetchSnapshot(target);
    last = snapshot;
    let event;
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
    const remaining = deadline - Date.now();
    if (remaining <= 0) return report(target, last, { event: "timeout", timeout: true });
    // Jitter keeps several lanes from hitting GitHub on the same second.
    await sleep(Math.min(opts.interval * 1000 * (0.9 + Math.random() * 0.2), remaining));
  }
}

const opts = parseArgs(process.argv.slice(2));
try {
  await watch(opts);
} catch (error) {
  if (error instanceof RateLimited) {
    process.stdout.write(`${JSON.stringify({ event: "rate_limited", retry_at: error.retryAt, reason: error.message })}\n`);
    process.exitCode = 3;
  } else {
    process.stdout.write(`${JSON.stringify({ event: "error", message: error.message })}\n`);
    process.stderr.write(`pr-watch: ${error.message}\n`);
    process.exitCode = 1;
  }
}
