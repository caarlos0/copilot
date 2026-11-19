const assert = require("node:assert/strict");
const { existsSync, readFileSync, statSync } = require("node:fs");
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
async function server(t, args = [], existing) {
  const directory = existing ?? await mkdtemp(join(tmpdir(), "factory-dashboard-lan-test-"));
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
  assert.match(cookie, /^token=[\w-]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/);

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

test("a browser without a token gets a login form; the API keeps its JSON 401", async (t) => {
  const { url, token } = await server(t, ["--host", "0.0.0.0"]);
  const bare = new URL(url);
  bare.search = "";
  const html = { Accept: "text/html" };

  const page = await fetch(bare, { headers: html });
  assert.equal(page.status, 401);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  const body = await page.text();
  assert.match(body, /<input type="password" name="token"/);
  assert.match(body, /name="viewport"/);
  assert.doesNotMatch(body, /Wrong token/);
  assert.doesNotMatch(body, new RegExp(token), "the token is never echoed");

  const wrongLink = await fetch(new URL("?token=wrong-wrong-wrong-wrong", bare), { headers: html });
  assert.equal(wrongLink.status, 401);
  assert.match(await wrongLink.text(), /Wrong token/);

  const api = await fetch(new URL(`/api/factories`, bare), { headers: { Accept: "application/json" } });
  assert.equal(api.status, 401);
  assert.match(api.headers.get("content-type"), /^application\/json/);
  assert.match((await api.json()).error, /access token/);
  const asked = await fetch(new URL(`/api/factories`, bare), { headers: html });
  assert.match(asked.headers.get("content-type"), /^application\/json/, "only the dashboard page gets the form");
});

test("a malformed token cookie gets the login form, not a 500", async (t) => {
  const { url } = await server(t, ["--host", "0.0.0.0"]);
  const bare = new URL(url);
  bare.search = "";
  const page = await fetch(bare, { headers: { Accept: "text/html", Cookie: "token=%" } });
  assert.equal(page.status, 401);
  assert.match(await page.text(), /<input type="password" name="token"/);
});

test("POST /login sets the cookie and redirects to a same-origin path only", async (t) => {
  const { url, token } = await server(t, ["--host", "0.0.0.0"]);
  const login = (values, extra = {}) => fetch(new URL("/login", url), {
    method: "POST",
    redirect: "manual",
    headers: { Origin: url.origin, "Content-Type": "application/x-www-form-urlencoded", ...extra },
    body: new URLSearchParams(values),
  });

  const ok = await login({ token });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/");
  const cookie = ok.headers.get("set-cookie");
  assert.match(cookie, /^token=[\w-]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/);
  const authed = await fetch(new URL("/", url), { headers: { Cookie: cookie.split(";")[0], Accept: "text/html" } });
  assert.equal(authed.status, 200);

  const asked = await login({ token, next: "/?file=a.json" });
  assert.equal(asked.headers.get("location"), "/?file=a.json");
  for (const next of ["https://evil.example/", "//evil.example/", "/\\evil.example", "javascript:alert(1)"]) {
    assert.equal((await login({ token, next })).headers.get("location"), "/", `refused ${next}`);
  }

  const wrong = await login({ token: `wrong-${token}`, next: '/"><script>' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("set-cookie"), null);
  const body = await wrong.text();
  assert.match(body, /Wrong token/);
  assert.match(body, /<input type="password"/);
  assert.doesNotMatch(body, /<script>/, "the next value is escaped");

  assert.equal((await login({ token }, { Origin: "http://evil.example" })).status, 403, "cross-origin login");
  assert.equal((await login({ token }, { "Content-Type": "text/plain" })).status, 415);
});

test("POST /login is not a route on the loopback default", async (t) => {
  const { url } = await server(t);
  const response = await fetch(new URL("/login", url), {
    method: "POST",
    headers: { Origin: url.origin, "Content-Type": "application/x-www-form-urlencoded" },
    body: "token=x",
  });
  assert.equal(response.status, 405);
});

test("a non-loopback --host saves its token and reuses it after a restart", async (t) => {
  const first = await server(t, ["--host", "0.0.0.0"]);
  const file = join(first.directory, "dashboard-token");
  assert.equal(readFileSync(file, "utf8").trim(), first.token);
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const second = await server(t, ["--host", "0.0.0.0"], first.directory);
  assert.equal(second.token, first.token);
  const bare = new URL(second.url);
  bare.search = "";
  const bearer = await fetch(bare, { headers: { Authorization: `Bearer ${first.token}` } });
  assert.equal(bearer.status, 200, "the old token still works");

  await writeFile(file, "");
  const regenerated = await server(t, ["--host", "0.0.0.0"], first.directory);
  assert.match(regenerated.token, /^[\w-]{16,}$/);
  assert.notEqual(regenerated.token, first.token, "an empty file gets a new token");
  assert.equal(readFileSync(file, "utf8").trim(), regenerated.token);
});

test("--token overrides the saved token and is not saved; loopback creates no file", async (t) => {
  const given = "given-token-0123456789";
  const { directory, token } = await server(t, ["--host", "0.0.0.0", "--token", given]);
  assert.equal(token, given);
  assert.equal(existsSync(join(directory, "dashboard-token")), false);

  const loopback = await server(t);
  assert.equal(existsSync(join(loopback.directory, "dashboard-token")), false);
});
