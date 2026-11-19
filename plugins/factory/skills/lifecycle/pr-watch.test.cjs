const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { chmod, mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { delimiter, join } = require("node:path");
const { test } = require("node:test");

const script = join(__dirname, "pr-watch.mjs");

// A fake gh that answers `pr view` and replays queued `api graphql` responses.
// With FAKE_GH_PAGE_SIZE it pages both connections like GitHub: the first call
// consumes the next queued response, and a call with a cursor pages through
// that same response without consuming another.
const fakeGh = `
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.FAKE_GH_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), args.join(" ").slice(0, 40) + "\\n");
if (args[0] === "pr") {
  process.stdout.write(JSON.stringify({ number: 7, url: "https://github.com/o/r/pull/7" }));
  process.exit(0);
}
const cursor = (name) => {
  const arg = args.find((a) => a.startsWith(name + "="));
  return arg ? Number(arg.slice(name.length + 1)) : null;
};
const threadsAfter = cursor("threadsAfter");
const contextsAfter = cursor("contextsAfter");
const paging = threadsAfter !== null || contextsAfter !== null;
const counter = path.join(dir, "counter");
let n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
if (!paging) {
  n += 1;
  fs.writeFileSync(counter, String(n));
}
const file = path.join(dir, "responses", n + ".json");
if (!fs.existsSync(file)) {
  process.stderr.write("fake gh: no response " + n);
  process.exit(1);
}
const response = JSON.parse(fs.readFileSync(file, "utf8"));
if (response.exit) {
  process.stderr.write(response.stderr);
  process.exit(response.exit);
}
if (paging && process.env.FAKE_GH_FAIL_PAGING) {
  process.stderr.write("gh: HTTP 404: Not Found");
  process.exit(1);
}
const size = Number(process.env.FAKE_GH_PAGE_SIZE || 0);
const page = (connection, after) => {
  const start = after ?? 0;
  const end = size ? start + size : connection.nodes.length;
  connection.pageInfo = { hasNextPage: end < connection.nodes.length, endCursor: String(Math.min(end, connection.nodes.length)) };
  connection.nodes = connection.nodes.slice(start, end);
};
const pull = response.data.repository.pullRequest;
page(pull.reviewThreads, threadsAfter);
const rollup = pull.commits.nodes[0]?.commit.statusCheckRollup;
if (rollup) page(rollup.contexts, contextsAfter);
process.stdout.write(JSON.stringify(response));
`;

const required = (name, conclusion, status = "COMPLETED") => ({
  __typename: "CheckRun", name, status, conclusion, isRequired: true,
});

function pr(overrides = {}) {
  const { contexts = [], remaining = 4000, ...rest } = overrides;
  return {
    data: {
      rateLimit: { cost: 1, remaining, resetAt: "2030-01-01T00:00:00Z" },
      repository: {
        pullRequest: {
          state: "OPEN", merged: false, mergeCommit: null, headRefOid: "h1", baseRefOid: "b1",
          isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null,
          reviews: { nodes: [] }, reviewThreads: { nodes: [] },
          commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: contexts } } } }] },
          ...rest,
        },
      },
    },
  };
}

async function fixture(t, responses, extraEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pr-watch-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "bin"));
  await mkdir(join(directory, "responses"));
  await writeFile(join(directory, "gh.js"), fakeGh);
  const gh = join(directory, "bin", "gh");
  await writeFile(gh, `#!/bin/sh\nexec "${process.execPath}" "${join(directory, "gh.js")}" "$@"\n`);
  await chmod(gh, 0o755);
  await Promise.all(responses.map((response, i) => writeFile(join(directory, "responses", `${i + 1}.json`), JSON.stringify(response))));
  const watch = (...args) => {
    const out = spawnSync(process.execPath, [script, "--interval", "0.01", ...args], {
      encoding: "utf8",
      env: { ...process.env, ...extraEnv, FAKE_GH_DIR: directory, PR_WATCH_MIN_INTERVAL: "0", PATH: `${join(directory, "bin")}${delimiter}${process.env.PATH}` },
    });
    return { ...out, json: out.stdout ? JSON.parse(out.stdout) : null };
  };
  const calls = async () => (await readFile(join(directory, "calls.log"), "utf8")).trim().split("\n");
  return { watch, calls };
}

test("one graphql call per tick, noise does not wake, merge reports the commit", async (t) => {
  const { watch, calls } = await fixture(t, [
    pr(),
    pr({ title: "renamed", updatedAt: "later", reviewDecision: null }),
    pr({ state: "MERGED", merged: true, mergeCommit: { oid: "m1" } }),
  ]);
  const out = watch("7");
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.json.event, "merged");
  assert.equal(out.json.merge_commit, "m1");
  assert.equal(out.json.pr, 7);
  assert.deepEqual((await calls()).map((call) => call.split(" ")[0]), ["pr", "api", "api", "api"]);
});

test("--merge ignores head and review changes and reports a close without a merge", async (t) => {
  const { watch } = await fixture(t, [
    pr(),
    pr({ headRefOid: "h2", reviewDecision: "APPROVED" }),
    pr({ state: "CLOSED" }),
  ]);
  const out = watch("7", "--merge");
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.json.event, "closed");
  assert.equal(out.json.merged, false);
});

test("a new head, a new review, and a conflict are typed events", async (t) => {
  for (const [change, event] of [
    [{ headRefOid: "h2" }, "head"],
    [{ reviews: { nodes: [{ id: "r1", state: "APPROVED" }] } }, "review"],
    [{ mergeable: "CONFLICTING" }, "conflict"],
  ]) {
    const { watch } = await fixture(t, [pr(), pr(), pr(change)]);
    const out = watch("7");
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.json.event, event);
  }
});

test("a required check fails fast while another is pending, non-required failures are ignored", async (t) => {
  const optional = { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE", isRequired: false };
  const { watch } = await fixture(t, [
    pr({ contexts: [required("build", "", "IN_PROGRESS"), required("test", "", "IN_PROGRESS"), optional] }),
    pr({ contexts: [required("build", "", "IN_PROGRESS"), required("test", "", "IN_PROGRESS"), optional] }),
    pr({ contexts: [required("build", "", "IN_PROGRESS"), required("test", "FAILURE"), optional] }),
  ]);
  const out = watch("7");
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.json.event, "checks");
  assert.deepEqual(out.json.checks, { state: "failed", failed: ["test"], cancelled: [] });
});

test("checks pass only when every required check succeeded; an empty set is none", async (t) => {
  const pending = [required("build", "", "QUEUED"), required("test", "SUCCESS")];
  const { watch } = await fixture(t, [
    pr({ contexts: pending }),
    pr({ contexts: [required("build", "SKIPPED"), required("test", "SUCCESS")] }),
    pr({ contexts: [required("build", "SUCCESS"), required("test", "SUCCESS")] }),
  ]);
  const out = watch("7");
  assert.equal(out.json.event, "checks");
  assert.equal(out.json.checks.state, "passed");

  const none = await fixture(t, [pr(), pr(), pr({ state: "MERGED", merged: true })]);
  assert.equal(none.watch("7").json.event, "merged");
});

test("a required check on page 2 of the contexts is seen, and so are unresolved threads on page 2", async (t) => {
  const contexts = [required("a", "SUCCESS"), required("b", "SUCCESS"), required("c", "SUCCESS"), required("deploy", "FAILURE")];
  const startup = await fixture(t, [pr({ contexts })], { FAKE_GH_PAGE_SIZE: "2" });
  const out = startup.watch("7");
  assert.equal(out.json.event, "checks");
  assert.deepEqual(out.json.checks, { state: "failed", failed: ["deploy"], cancelled: [] });
  assert.deepEqual((await startup.calls()).map((call) => call.split(" ")[0]), ["pr", "api", "api"]);

  const threads = { nodes: [{ isResolved: true }, { isResolved: true }, { isResolved: false }] };
  const review = await fixture(t, [pr({ reviewThreads: { nodes: [{ isResolved: true }] } }), pr({ reviewThreads: threads })], { FAKE_GH_PAGE_SIZE: "2" });
  assert.equal(review.watch("7").json.event, "review");
});

test("a PR with one page of items costs one call per tick", async (t) => {
  const { watch, calls } = await fixture(t, [pr({ contexts: [required("a", "SUCCESS")] }), pr({ state: "MERGED", merged: true })], { FAKE_GH_PAGE_SIZE: "2" });
  assert.equal(watch("7").json.event, "merged");
  assert.deepEqual((await calls()).map((call) => call.split(" ")[0]), ["pr", "api", "api"]);
});

test("a page that cannot be fetched is an error, never a pass", async (t) => {
  const contexts = [required("a", "SUCCESS"), required("b", "SUCCESS"), required("c", "SUCCESS")];
  const { watch } = await fixture(t, [pr({ contexts })], { FAKE_GH_PAGE_SIZE: "2", FAKE_GH_FAIL_PAGING: "1" });
  const out = watch("7");
  assert.equal(out.status, 1);
  assert.equal(out.json.event, "error");
});

test("a failed required check at startup exits at once", async (t) => {
  const { watch, calls } = await fixture(t, [pr({ contexts: [required("build", "FAILURE")] })]);
  const out = watch("7");
  assert.equal(out.json.event, "checks");
  assert.equal((await calls()).length, 2);
});

test("a rate limit exits 3 with retry_at and makes no more calls", async (t) => {
  const { watch, calls } = await fixture(t, [
    pr(),
    { exit: 1, stderr: "gh: API rate limit already exceeded for user ID 1. (HTTP 403)" },
    pr({ state: "MERGED", merged: true }),
  ]);
  const out = watch("7");
  assert.equal(out.status, 3);
  assert.equal(out.json.event, "rate_limited");
  assert.ok(Date.parse(out.json.retry_at) > Date.now());
  assert.equal((await calls()).length, 3);
});

test("low remaining quota exits 3 with the reset time", async (t) => {
  const { watch } = await fixture(t, [pr({ remaining: 1 })]);
  const out = watch("7");
  assert.equal(out.status, 3);
  assert.equal(out.json.retry_at, "2030-01-01T00:00:00.000Z");
});

test("another gh error exits 1 with a JSON error and stderr", async (t) => {
  const { watch } = await fixture(t, [pr(), { exit: 1, stderr: "gh: HTTP 401: Bad credentials" }]);
  const out = watch("7");
  assert.equal(out.status, 1);
  assert.equal(out.json.event, "error");
  assert.match(out.stderr, /Bad credentials/);
});

const bad502 = { exit: 1, stderr: "gh: HTTP 502: Bad Gateway (https://api.github.com/graphql)" };

test("two transient failures then success still yield the normal event", async (t) => {
  const { watch, calls } = await fixture(t, [
    pr(), bad502, { exit: 1, stderr: "read tcp: connection reset by peer" }, pr({ state: "MERGED", merged: true }),
  ]);
  const out = watch("7");
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.json.event, "merged");
  assert.equal((await calls()).length, 5);
});

test("a success resets the transient failure count", async (t) => {
  const { watch } = await fixture(t, [
    pr(), bad502, bad502, bad502, bad502, pr(), bad502, bad502, bad502, bad502, pr({ state: "MERGED", merged: true }),
  ]);
  assert.equal(watch("7").json.event, "merged");
});

test("five consecutive transient failures exit 1 with an error", async (t) => {
  const { watch, calls } = await fixture(t, [pr(), bad502, bad502, bad502, bad502, bad502, pr({ state: "MERGED", merged: true })]);
  const out = watch("7");
  assert.equal(out.status, 1);
  assert.equal(out.json.event, "error");
  assert.match(out.json.message, /502/);
  assert.equal((await calls()).length, 7);
});

test("a permanent error is not retried", async (t) => {
  const { watch, calls } = await fixture(t, [pr(), { exit: 1, stderr: "gh: HTTP 404: Not Found" }, pr({ state: "MERGED", merged: true })]);
  const out = watch("7");
  assert.equal(out.status, 1);
  assert.equal(out.json.event, "error");
  assert.equal((await calls()).length, 3);
});

test("--timeout exits 0 with a timeout event", async (t) => {
  const { watch } = await fixture(t, Array.from({ length: 200 }, () => pr()));
  const out = watch("7", "--timeout", "0.05");
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.json.event, "timeout");
  assert.equal(out.json.timeout, true);
});

test("--help needs no gh, a bad flag exits 2, and the default interval minimum is enforced", () => {
  const env = { ...process.env, PATH: "/nonexistent", PR_WATCH_MIN_INTERVAL: undefined };
  delete env.PR_WATCH_MIN_INTERVAL;
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });
  assert.equal(run("--help").status, 0);
  assert.equal(run("--bogus").status, 2);
  assert.equal(run("7", "--interval", "5").status, 2);
});
