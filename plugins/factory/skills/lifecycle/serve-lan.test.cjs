const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");

const example = JSON.parse(readFileSync(join(__dirname, "factory.example.json"), "utf8"));
const factoryFile = "owner.repo-factory.json";
const unblocked = { task: "issue-5", state: "initial", comment: "This is now unblocked.", revision: 0 };

// Spawns serve.mjs with the given extra args and resolves once it has printed its first
// ready URL. The stderr accumulated so far is returned too, for the plain-HTTP warning.
async function server(t, args = []) {
  const directory = await mkdtemp(join(tmpdir(), "factory-dashboard-lan-test-"));
  await writeFile(join(directory, factoryFile), JSON.stringify(example));
  const child = spawn(process.execPath,
    [join(__dirname, "serve.mjs"), "--directory", directory, "--port", "0", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => {
    child.kill();
    await closed;
    await rm(directory, { recursive: true, force: true });
  });
  const { url, stdout } = await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let url;
    let settle;
    // Debounced so trailing startup lines (like the plain-HTTP warning) are captured too.
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      url ??= stdout.match(/^(http:\/\/\S+)\n/m)?.[1];
      if (!url) return;
      clearTimeout(settle);
      settle = setTimeout(() => resolve({ url: new URL(url), stdout }), 20);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (code) => reject(new Error(`Server exited ${code}: ${stderr}`)));
  });
  return { directory, url, token: url.searchParams.get("token"), stdout };
}

test("the default loopback server takes no token", async (t) => {
  const { url } = await server(t);
  assert.equal(url.searchParams.get("token"), null);
  const page = await fetch(url);
  assert.equal(page.status, 200);
});

test("a non-loopback --host requires a token on every request and warns about clear text", async (t) => {
  const { url, token, stdout } = await server(t, ["--host", "0.0.0.0"]);
  assert.match(token, /^[\w-]{16,}$/);
  assert.match(stdout, /clear text/);

  const bare = new URL(url);
  bare.search = "";

  assert.equal((await fetch(bare)).status, 401, "no token at all");
  assert.equal((await fetch(new URL(`?token=wrong-${token}`, bare))).status, 401, "wrong token");
  assert.equal((await fetch(bare, { headers: { Authorization: "Bearer nope" } })).status, 401, "wrong bearer token");
  // A short, mismatched-length token must not make the constant-time compare throw (500).
  assert.equal((await fetch(bare, { headers: { Authorization: "Bearer x" } })).status, 401, "short bearer token");

  const bearer = await fetch(bare, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(bearer.status, 200, "correct bearer token");

  const first = await fetch(url, { redirect: "manual" });
  assert.equal(first.status, 302);
  const location = new URL(first.headers.get("location"), url);
  assert.equal(location.searchParams.get("token"), null, "the token is stripped from the redirect target");
  const cookie = first.headers.get("set-cookie");
  assert.match(cookie, /^token=[\w-]+; HttpOnly; SameSite=Strict; Path=\/$/);

  const withoutCookie = await fetch(location);
  assert.equal(withoutCookie.status, 401, "the redirect target itself carries no token");
  const withCookie = await fetch(location, { headers: { Cookie: cookie.split(";")[0] } });
  assert.equal(withCookie.status, 200, "the cookie from the redirect authenticates the next request");
});

test("a write is rejected without a token and accepted with one", async (t) => {
  const { url, token } = await server(t, ["--host", "0.0.0.0"]);
  const move = (extra) => fetch(new URL(`/api/move?file=${factoryFile}`, url), {
    method: "POST",
    headers: { Origin: url.origin, "Content-Type": "application/json", ...extra },
    body: JSON.stringify(unblocked),
  });
  assert.equal((await move({})).status, 401, "no token");
  assert.equal((await move({ Authorization: "Bearer wrong" })).status, 401, "wrong token");
  assert.equal((await move({ Authorization: `Bearer ${token}` })).status, 200, "correct token");
});
