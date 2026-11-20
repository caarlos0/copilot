import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { type AddressInfo } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import writeFileAtomic from "write-file-atomic";
import { countByState, isObject, validate } from "./factory-data.mjs";
import type { Factory, Worker } from "./factory-data.ts";
import { resolveAttention, scanStamp, sendAnswer } from "./attention.mjs";
import type { AttentionItem } from "./attention.ts";
import { ConflictError, update } from "./factory.mjs";
import { decideProposal, scanProposals } from "./proposals.mjs";
import type { Proposal } from "./proposals.ts";
import { sessionStateDirectory } from "./sessions.mjs";
import { factoryUsage } from "./usage.mjs";
import { candidates, stateDirectories } from "./state-dir.mjs";

const factoryFile = /-factory\.json$/i;
const maxBody = 16384;
const tokenPattern = /^[\w.~-]{16,}$/;
const VENDOR = new Set(["/vendor/marked.min.js", "/vendor/purify.min.js"]);

type Options = { help?: boolean; directory?: string; port: string; host: string; token?: string };
type Directory = { configured: string; directory: string };
type Entry = { file: string; target: string; tag: string };
type Listing = Entry | { file: string; error: unknown };
type Body = string | Buffer | object;
type Json = Record<string, any>;

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;
const errorMessage = (error: unknown) => (error as Error).message;

const bracket = (host: string) => (host.includes(":") ? `[${host}]` : host);
const isWildcard = (host: string) => host === "0.0.0.0" || host === "::";
const isLoopback = (host: string) => host === "localhost" || host === "::1" || /^127\./.test(host);

function lanAddresses() {
  return Object.values(networkInterfaces()).flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry!.address);
}

const digest = (value: string) => createHash("sha256").update(value).digest();
const sameToken = (value: unknown, expected: string) =>
  typeof value === "string" && timingSafeEqual(digest(value), digest(expected));

// Reuses the token in the file so a restart keeps the phone's cookie valid. A missing,
// empty, or corrupt file gets a new token, written whole (mode 0600) and renamed into place.
async function persistedToken(path: string) {
  try {
    const saved = (await readFile(path, "utf8")).trim();
    if (tokenPattern.test(saved)) return saved;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const token = randomBytes(24).toString("base64url");
  await writeFileAtomic(path, `${token}\n`, { mode: 0o600 });
  return token;
}

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function main() {
  let options: Options;
  try {
    options = parseArgs({
      options: {
        help: { type: "boolean", short: "h" },
        directory: { type: "string" },
        port: { type: "string", default: "8766" },
        host: { type: "string", default: "127.0.0.1" },
        token: { type: "string" },
      },
    }).values;
    if (!/^\d+$/.test(options.port) || Number(options.port) > 65535) {
      throw new Error("--port must be an integer from 0 to 65535.");
    }
    options.host = options.host.toLowerCase();
    if (options.token !== undefined && !tokenPattern.test(options.token)) {
      throw new Error("--token must be at least 16 characters from A-Z a-z 0-9 . _ ~ -");
    }
  } catch (error) {
    console.error(`${errorMessage(error)}\nRun with --help for usage.`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(`Serve the factory dashboard on 127.0.0.1 (no token) or on --host (token required).

Usage: node serve.mjs [--directory PATH] [--port PORT] [--host ADDR] [--token TOKEN]
       bun serve.mjs [--directory PATH] [--port PORT] [--host ADDR] [--token TOKEN]

  --directory PATH  Only this state directory (default: both ~/.local/state/copilot-factory
                    and the legacy ~/.local/state/copilot-coordinator, whichever exist;
                    the new one wins on a name clash)
  --port PORT       Listening port (default: 8766; 0 chooses an available port)
  --host ADDR       Address to bind (default: 127.0.0.1). A non-loopback address, such as
                    0.0.0.0, makes every request require an access token. The page is plain
                    HTTP, so the token travels in clear text: use a trusted network only
  --token TOKEN     Access token for a non-loopback --host (at least 16 characters from
                    A-Z a-z 0-9 . _ ~ -). Default: a random one, saved (mode 0600) as
                    dashboard-token in the state directory and reused on later starts.
                    A --token value is not saved. Ignored on loopback
  -h, --help        Show help

Open the printed HTTP URL. It lists every <owner.repo>-factory.json in the directories.
Stop with Ctrl+C. No packages are required. Invalid arguments exit 2; startup failures exit 1.`);
    return;
  }

  // An explicit --directory means only that directory. Otherwise a file may live
  // in either state directory, and the first one that has it (the new one) wins.
  // A directory that does not exist yet is skipped, and found when it appears.
  const checked = options.directory ? [resolve(options.directory)] : candidates(homedir());
  let directories: Directory[] = [];
  async function resolveDirectories() {
    const found: Directory[] = [];
    for (const configured of options.directory ? checked : stateDirectories()) {
      try {
        found.push({ configured, directory: await realpath(configured) });
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
    directories = found;
  }
  await resolveDirectories();
  if (!directories.length) throw new Error(`No state directory exists. Checked: ${checked.join(", ")}`);
  const assets = dirname(fileURLToPath(import.meta.url));

  async function localFile(value: string | null) {
    if (!value || value.includes("\0")) throw new HttpError(400, "A filename is required.");
    for (const { configured, directory } of directories) {
      const candidate = resolve(configured, value);
      if (dirname(candidate) !== directory && dirname(candidate) !== configured) {
        throw new HttpError(403, "File must be directly inside the configured state directory.");
      }
      let target: string;
      try {
        target = await realpath(candidate);
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      if (dirname(target) !== directory || !(await stat(target)).isFile()) {
        throw new HttpError(403, "File must be a regular file inside the state directory.");
      }
      return target;
    }
    throw new HttpError(404, `${value} is not in the state directory.`);
  }

  // Parsed and validated factories by real path. The tag changes on every write
  // (mtime, size and inode: the writers replace the file atomically).
  const parsed = new Map<string, { tag: string; data: Factory }>();

  async function factoryTag(file: string | null): Promise<Entry> {
    if (!file || !factoryFile.test(file) || file.includes("/")) {
      throw new HttpError(400, "Select a <owner.repo>-factory.json file.");
    }
    const target = await localFile(file);
    const { mtimeNs, size, ino } = await stat(target, { bigint: true });
    return { file, target, tag: `"${[mtimeNs, size, ino].map((value) => value.toString(36)).join("-")}"` };
  }

  async function readFactory({ file, target, tag }: Entry): Promise<Factory> {
    const cached = parsed.get(target);
    if (cached?.tag === tag) return cached.data;
    const data: Factory = JSON.parse(await readFile(target, "utf8"));
    try {
      validate(data);
    } catch (error) {
      throw new HttpError(400, `${file}: ${errorMessage(error)}`);
    }
    parsed.set(target, { tag, data });
    return data;
  }

  // One scan per file at a time, so two polls never record the same resolution twice. A scan is
  // reused while the events log and the logs of the waiting sessions keep their size and time,
  // for at most a minute: the pane check and the 24 hour expiry depend on Rex and the clock.
  const scans = new Map<string, Promise<AttentionItem[]>>();
  const scanned = new Map<string, { at: number; sessions: string[]; stamp: string; open: AttentionItem[] }>();
  const scanTtlMs = 60_000;
  function pendingAttention(target: string) {
    if (!scans.has(target)) {
      scans.set(target, (async () => {
        const last = scanned.get(target);
        if (last && Date.now() - last.at < scanTtlMs && last.stamp === await scanStamp(target, last.sessions)) {
          return last.open;
        }
        const { open } = await resolveAttention(target, { source: "attention" });
        const sessions = [...new Set(open.map((item) => item.session))];
        scanned.set(target, { at: Date.now(), sessions, stamp: await scanStamp(target, sessions), open });
        return open;
      })().finally(() => scans.delete(target)));
    }
    return scans.get(target)!;
  }

  // Open improve proposals, reread only when the events log changes size or time.
  const proposalScans = new Map<string, { stamp: string; open: Proposal[] }>();
  async function openProposals(target: string) {
    const stamp = await scanStamp(target);
    if (proposalScans.get(target)?.stamp !== stamp) {
      proposalScans.set(target, { stamp, open: (await scanProposals(target)).open });
    }
    return proposalScans.get(target)!.open;
  }

  // The coordinator records only `result` in a worker record, so the brief is found by the
  // convention <project>-<task>-<role>-brief.md (a recorded `brief` wins). The map has the
  // briefs whose file still exists, so the dashboard shows no link for one that
  // `archive.mjs clean` deleted.
  const briefName = (file: string, task: { id: string }, role: string, worker: Worker) =>
    worker.brief ?? `${file.replace(factoryFile, "")}-${task.id}-${role}-brief.md`;

  async function taskBriefs(file: string, data: Factory) {
    const briefs: Record<string, Record<string, string>> = {};
    for (const task of data.tasks) {
      for (const [role, worker] of Object.entries(task.workers)) {
        if (!worker) continue;
        const name = briefName(file, task, role, worker);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) continue;
        try {
          await localFile(name);
        } catch {
          continue;
        }
        (briefs[task.id] ??= {})[role] = name;
      }
    }
    return briefs;
  }

  // Pending attention items, oldest first. They live in the events log and the session logs, so the
  // tag covers them too: a change there refreshes the browser even when the factory file is the same.
  // The scan also records the items it finds closed (answered, pane gone, expired), so they
  // clear without waiting for a reconcile run. Open improve proposals ride along as `proposals`, and per task usage from the session logs as `usage`, and the existing worker briefs as `briefs`.
  async function factoryView(entry: Entry) {
    const attention = (await pendingAttention(entry.target))
      .map(({ id, session, kind, text, options, role, pane, rex_session, task, at }) =>
        ({ id, session, kind, text, options, role, pane, rex_session: rex_session ?? null, task, at }))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const proposals = await openProposals(entry.target);
    const data = await readFactory(entry);
    const usage = await factoryUsage(data, sessionStateDirectory());
    const briefs = await taskBriefs(entry.file, data);
    const digest = createHash("sha1").update(JSON.stringify([attention, proposals, usage, briefs])).digest("base64url");
    return {
      tag: `${entry.tag.slice(0, -1)}-${digest}"`,
      body: async () => ({ ...(await readFactory(entry)), attention, proposals, usage, briefs }),
    };
  }

  async function loadFactory(file: string | null) {
    return readFactory(await factoryTag(file));
  }

  // A state directory can hold tens of thousands of scratch files, so its listing is reread only
  // when the directory mtime changes. The mtime is read before the listing, so a change in between
  // leaves an older stamp and the next call rereads.
  const listings = new Map<string, { mtimeMs: number; names: string[] }>();
  async function factoryNamesIn(directory: string) {
    const { mtimeMs } = await stat(directory);
    const cached = listings.get(directory);
    if (cached?.mtimeMs === mtimeMs) return cached.names;
    const names: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if ((!entry.isFile() && !entry.isSymbolicLink()) || !factoryFile.test(entry.name) ||
          entry.name.startsWith(".")) continue;
      names.push(entry.name);
    }
    listings.set(directory, { mtimeMs, names });
    return names;
  }

  async function factoryNames() {
    await resolveDirectories();
    const names = new Set<string>();
    for (const { directory } of directories) {
      for (const name of await factoryNamesIn(directory)) names.add(name);
    }
    return [...names].sort();
  }

  // The listing tag covers every file, valid or not, so a change to a broken file is seen too.
  async function listingTags() {
    const entries = await Promise.all((await factoryNames()).map(async (file): Promise<Listing> => {
      try {
        return await factoryTag(file);
      } catch (error) {
        return { file, error };
      }
    }));
    const tag = createHash("sha1").update(JSON.stringify(entries.map((entry) =>
      [entry.file, "tag" in entry ? entry.tag : errorMessage(entry.error)]))).digest("base64url");
    return { entries, tag: `"${tag}"` };
  }

  async function listFactories(entries: Listing[]) {
    const factories = [];
    const errors = [];
    for (const entry of entries) {
      try {
        if ("error" in entry) throw entry.error;
        const data = await readFactory(entry);
        factories.push({
          file: entry.file,
          id: data.id,
          project: data.project,
          goal: data.goal,
          status: data.status,
          updated_at: data.updated_at,
          task_count: data.tasks.length,
          counts: countByState(data.tasks),
        });
      } catch (error) {
        errors.push({ file: entry.file, error: errorMessage(error) });
      }
    }
    factories.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) ||
      a.file.localeCompare(b.file));
    errors.sort((a, b) => a.file.localeCompare(b.file));
    return { directories: directories.map(({ directory }) => directory), factories, errors };
  }

  function send(
    response: ServerResponse, status: number, body: Body, type = "application/json; charset=utf-8",
    headers: Record<string, string> = {},
  ) {
    response.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    });
    response.end(typeof body === "object" && !Buffer.isBuffer(body) ? JSON.stringify(body) : body);
  }

  const acceptsGzip = (request: IncomingMessage) => (request.headers["accept-encoding"] ?? "").split(",").some((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    return name === "gzip" && !params.some((param) => /^\s*q=0(\.0*)?\s*$/.test(param));
  });

  // The latest compressed body per resource: a changed tag compresses once, not once per request.
  // The body is built only when the identity response or a new compression needs it.
  const compressed = new Map<string, { tag: string; gzip: Buffer }>();

  async function sendBody(
    request: IncomingMessage, response: ServerResponse, key: string, tag: string,
    body: () => Body | Promise<Body>, type?: string, headers: Record<string, string> = {},
  ) {
    headers = { ...headers, Vary: "Accept-Encoding" };
    if (!acceptsGzip(request)) return send(response, 200, await body(), type, headers);
    let entry = compressed.get(key);
    if (entry?.tag !== tag) {
      const data = await body();
      entry = { tag, gzip: gzipSync(typeof data === "object" && !Buffer.isBuffer(data) ? JSON.stringify(data) : data, { level: 1 }) };
      compressed.set(key, entry);
    }
    send(response, 200, entry.gzip, type, { ...headers, "Content-Encoding": "gzip" });
  }

  async function sendAsset(request: IncomingMessage, response: ServerResponse, name: string, type: string) {
    const body = await readFile(join(assets, name));
    await sendBody(request, response, name, createHash("sha1").update(body).digest("base64url"), () => body, type);
  }

  async function sendTagged(
    request: IncomingMessage, response: ServerResponse, key: string, tag: string, body: () => Body | Promise<Body>,
  ) {
    const seen = request.headers["if-none-match"]?.split(",").map((value) => value.trim().replace(/^W\//, ""));
    if (seen?.includes(tag) || seen?.includes("*")) {
      response.writeHead(304, { "Cache-Control": "no-store", ETag: tag, "X-Content-Type-Options": "nosniff" });
      response.end();
    } else {
      await sendBody(request, response, key, tag, body, undefined, { ETag: tag });
    }
  }

  // Reads a same-origin POST body of the given content type, at most 16 KiB.
  async function readBody(request: IncomingMessage, type: string) {
    if (request.headers.origin !== `http://${request.headers.host}` ||
        (request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin")) {
      throw new HttpError(403, "State changes must come from this dashboard.");
    }
    if (request.headers["content-type"]?.split(";")[0].trim() !== type) {
      throw new HttpError(415, `State changes require ${type}.`);
    }
    if (Number(request.headers["content-length"]) > maxBody) {
      throw new HttpError(413, "State change is too large (maximum 16 KiB).");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maxBody) throw new HttpError(413, "State change is too large (maximum 16 KiB).");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  const readJSONBody = async (request: IncomingMessage): Promise<any> =>
    JSON.parse(await readBody(request, "application/json"));

  async function write(file: string | null, values: Json) {
    try {
      return await update(await localFile(file), values, { operator: true });
    } catch (error) {
      if (error instanceof ConflictError) throw new HttpError(409, error.message);
      if (errorCode(error)) throw error;
      throw new HttpError(400, errorMessage(error));
    }
  }

  async function moveTask(request: IncomingMessage, file: string | null) {
    const body = await readJSONBody(request);
    if (!isObject(body) ||
        Object.keys(body).some((key) => !["task", "state", "comment", "revision", "resolution"].includes(key)) ||
        !["task", "state", "comment"].every((key) => typeof body[key] === "string" && body[key].trim()) ||
        !Number.isSafeInteger(body.revision) || body.revision < 0) {
      throw new HttpError(400, "Provide task, state, a non-empty comment, and a non-negative task revision.");
    }
    const data = await loadFactory(file);
    if (!data.tasks.some((task) => task.id === body.task)) throw new HttpError(404, "Task not found.");
    return write(file, {
      task: body.task, state: body.state, note: body.comment,
      "expected-revision": String(body.revision), resolution: body.resolution,
    });
  }

  // Types one option of a pending prompt into its pane, as the user would. The browser names the
  // item by event ID, so a newer prompt of the same session is never answered by an old button.
  // The item stays listed: only the session log, the pane, or the clock resolves it.
  const answering = new Set<string>();
  async function answerAttention(request: IncomingMessage, file: string | null) {
    const body = await readJSONBody(request);
    if (!isObject(body) || Object.keys(body).some((key) => !["id", "index"].includes(key)) ||
        typeof body.id !== "string" || !Number.isSafeInteger(body.index) || body.index < 0) {
      throw new HttpError(400, "Provide the id of the waiting item and a non-negative option index.");
    }
    const { target } = await factoryTag(file);
    const item = (await pendingAttention(target)).find(({ id }) => id === body.id);
    if (!item) throw new HttpError(409, "That prompt is no longer waiting.");
    if (answering.has(item.id)) throw new HttpError(409, "An answer for this prompt is already being sent.");
    answering.add(item.id);
    try {
      await sendAnswer(item, body.index);
    } catch (error) {
      // The pane may be gone: rescan on the next poll instead of reusing the cached list.
      scanned.delete(target);
      throw error;
    } finally {
      answering.delete(item.id);
    }
    return { sent: true };
  }

  // The user's click on a proposal. The writes go one at a time, so two clicks on the same
  // proposal record one decision; the second answer shows the first decision.
  let deciding: Promise<unknown> = Promise.resolve();
  async function decideImprove(request: IncomingMessage, file: string | null) {
    const body = await readJSONBody(request);
    if (!isObject(body) || Object.keys(body).some((key) => !["proposal_id", "decision", "note"].includes(key)) ||
        typeof body.proposal_id !== "string" || !["accepted", "declined"].includes(body.decision) ||
        !(body.note === undefined || typeof body.note === "string")) {
      throw new HttpError(400, "Provide proposal_id, decision (accepted or declined), and an optional note.");
    }
    const { target } = await factoryTag(file);
    const run = deciding.then(() => decideProposal(target, body.proposal_id, body.decision, body.note));
    deciding = run.catch(() => {});
    const result = await run;
    if (!result) throw new HttpError(404, "That proposal does not exist.");
    return result;
  }

  // set holds only the sections the user changed; expected holds what the browser saw for each of them.
  async function setSettings(request: IncomingMessage, file: string | null) {
    const body = await readJSONBody(request);
    const known = (value: any, keys: string[]) => isObject(value) && Object.keys(value).every((key) => keys.includes(key));
    const fields = { limits: ["investigation", "implementation"], lever: ["spend", "autonomy_cap"] };
    const sections = isObject(body?.set) ? Object.keys(body.set) : [];
    if (!known(body, ["set", "expected"]) || !known(body.expected, ["budget", ...Object.keys(fields)]) ||
        !sections.length || !known(body.set, ["budget", ...Object.keys(fields)]) ||
        sections.some((section) => !Object.hasOwn(body.expected, section)) ||
        (sections.includes("budget") && !Number.isSafeInteger(body.set.budget)) ||
        !(body.expected.budget === undefined || body.expected.budget === null || Number.isSafeInteger(body.expected.budget)) ||
        Object.entries(fields).some(([section, keys]) => sections.includes(section) &&
          !(known(body.set[section], keys) && known(body.expected[section], keys) &&
            Object.keys(body.set[section]).length && Object.keys(body.set[section]).every((key) =>
              Object.hasOwn(body.expected[section], key))))) {
      throw new HttpError(400, "Provide set with budget, limits, or lever values, and the values you saw for each in expected.");
    }
    await loadFactory(file);
    const values: Json = {};
    if (sections.includes("budget")) {
      values.budget = JSON.stringify({ max_parallel_workers: body.set.budget });
      values["expected-budget"] = body.expected.budget === null ? "none" : String(body.expected.budget);
    }
    for (const section of Object.keys(fields)) {
      if (!sections.includes(section)) continue;
      values[section] = JSON.stringify(body.set[section]);
      values[`expected-${section}`] = JSON.stringify(body.expected[section]);
    }
    return write(file, values);
  }

  const requireToken = !isLoopback(options.host);
  const token = requireToken ? options.token ?? await persistedToken(join(directories[0].directory, "dashboard-token")) : undefined;

  // The allowed Host values are the server's own bound/advertised addresses, never an
  // arbitrary client-supplied value, to defend against DNS rebinding.
  function allowedHosts(port: number) {
    const hosts = new Set<string>();
    const add = (addr: string) => {
      hosts.add(`${bracket(addr)}:${port}`);
      if (port === 80) hosts.add(bracket(addr));
    };
    if (isWildcard(options.host)) {
      add("127.0.0.1");
      add("localhost");
      add("::1");
      for (const addr of lanAddresses()) add(addr);
    } else {
      add(options.host);
      if (isLoopback(options.host)) add("localhost");
    }
    return hosts;
  }

  function cookieToken(header?: string) {
    for (const part of (header ?? "").split(";")) {
      const at = part.indexOf("=");
      if (at !== -1 && part.slice(0, at).trim() === "token") {
        try {
          return decodeURIComponent(part.slice(at + 1).trim());
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  const bearerToken = (header?: string) => /^Bearer (.+)$/.exec(header ?? "")?.[1] ?? null;

  // Validates the request's token. A valid query token (the first page load, or any link
  // that carries one) gets the token out of the URL and into an HttpOnly cookie instead.
  function checkToken(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (!requireToken) return false;
    const queryToken = url.searchParams.get("token");
    if (queryToken !== null) {
      if (!sameToken(queryToken, token!)) throw new HttpError(401, "Missing or invalid access token.");
      if (request.method !== "GET") return false;
      url.searchParams.delete("token");
      response.writeHead(302, {
        "Set-Cookie": sessionCookie,
        Location: url.pathname + url.search,
      });
      response.end();
      return true;
    }
    if (!sameToken(cookieToken(request.headers.cookie) ?? bearerToken(request.headers.authorization), token!)) {
      throw new HttpError(401, "Missing or invalid access token.");
    }
    return false;
  }

  const sessionCookie = `token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}`;
  const escapeHTML = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

  // Only a browser page load gets the login form; API calls keep the JSON 401.
  const isPage = (request: IncomingMessage, url: URL) => request.method === "GET" && /text\/html/.test(request.headers.accept ?? "") &&
    ["/", "/dashboard.html", "/login"].includes(url.pathname);

  // A same-origin path only, so the redirect after login can never leave this server.
  function safeNext(value: unknown) {
    if (typeof value !== "string" || !/^\/(?![/\\])[^\s\\]*$/.test(value)) return "/";
    const target = new URL(value, "http://login.invalid");
    return target.origin === "http://login.invalid" ? target.pathname + target.search : "/";
  }

  function loginPage(response: ServerResponse, next: string, wrong: boolean) {
    send(response, 401, `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Factory dashboard login</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px system-ui,sans-serif;background:#111;color:#eee}
form{width:min(22rem,100% - 2rem);display:flex;flex-direction:column;gap:1rem}
input,button{font:inherit;font-size:16px;padding:.9rem;border-radius:.5rem;border:1px solid #555;box-sizing:border-box;width:100%}
input{background:#222;color:inherit}
button{background:#3b82f6;border-color:#3b82f6;color:#fff;font-weight:600;cursor:pointer}
p{margin:0;color:#f87171}
</style></head><body>
<form method="post" action="/login">
<h1>Factory dashboard</h1>${wrong ? "\n<p role=\"alert\">Wrong token</p>" : ""}
<input type="password" name="token" placeholder="Access token" autocomplete="current-password" autofocus required>
<input type="hidden" name="next" value="${escapeHTML(next)}">
<button type="submit">Log in</button>
</form></body></html>
`, "text/html; charset=utf-8", {
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    });
  }

  async function login(request: IncomingMessage, response: ServerResponse) {
    const form = new URLSearchParams(await readBody(request, "application/x-www-form-urlencoded"));
    const next = safeNext(form.get("next"));
    if (!sameToken(form.get("token"), token!)) {
      await new Promise((done) => setTimeout(done, 500));
      return loginPage(response, next, true);
    }
    response.writeHead(303, { "Set-Cookie": sessionCookie, Location: next, "Cache-Control": "no-store" });
    response.end();
  }

  const server = createServer(async (request, response) => {
    try {
      const port = (server.address() as AddressInfo).port;
      if (!allowedHosts(port).has(request.headers.host as string)) {
        throw new HttpError(403, "Use the printed URL.");
      }
      const url = new URL(request.url as string, `http://127.0.0.1:${port}`);
      if (requireToken && request.method === "POST" && url.pathname === "/login") return await login(request, response);
      try {
        if (checkToken(request, response, url)) return;
      } catch (error) {
        if ((error as HttpError).status !== 401 || !isPage(request, url)) throw error;
        const queryToken = url.searchParams.has("token");
        url.searchParams.delete("token");
        return loginPage(response, url.pathname === "/login" ? "/" : safeNext(url.pathname + url.search), queryToken);
      }
      if (request.method === "POST" && url.pathname === "/api/move") {
        send(response, 200, await moveTask(request, url.searchParams.get("file")));
      } else if (request.method === "POST" && url.pathname === "/api/settings") {
        send(response, 200, await setSettings(request, url.searchParams.get("file")));
      } else if (request.method === "POST" && url.pathname === "/api/attention/answer") {
        send(response, 200, await answerAttention(request, url.searchParams.get("file")));
      } else if (request.method === "POST" && url.pathname === "/api/improve/decide") {
        send(response, 200, await decideImprove(request, url.searchParams.get("file")));
      } else if (request.method !== "GET") {
        throw new HttpError(405, "Use GET, or POST /api/move, /api/settings, /api/attention/answer or /api/improve/decide for dashboard changes.");
      } else if (url.pathname === "/" || url.pathname === "/dashboard.html") {
        await sendAsset(request, response, "dashboard.html", "text/html; charset=utf-8");
      } else if (url.pathname === "/factory-data.mjs") {
        await sendAsset(request, response, "factory-data.mjs", "text/javascript; charset=utf-8");
      } else if (VENDOR.has(url.pathname)) {
        await sendAsset(request, response, url.pathname.slice(1), "text/javascript; charset=utf-8");
      } else if (url.pathname === "/api/factories") {
        const { entries, tag } = await listingTags();
        await sendTagged(request, response, "listing", tag, () => listFactories(entries));
      } else if (url.pathname === "/api/factory") {
        const entry = await factoryTag(url.searchParams.get("file"));
        const view = await factoryView(entry);
        await sendTagged(request, response, `factory:${entry.target}`, view.tag, view.body);
      } else if (url.pathname === "/api/artifact") {
        const file = url.searchParams.get("file");
        const data = await loadFactory(file);
        const name = url.searchParams.get("name");
        const referenced = data.tasks.some((task) => Object.entries(task.workers)
          .some(([role, worker]) => worker && (briefName(file!, task, role, worker) === name || worker.result === name))) ||
          data.rules.some((rule) => rule.worker && (rule.worker.brief === name || rule.worker.result === name));
        if (!name || !referenced) {
          throw new HttpError(403, "Artifact is not referenced by the selected factory.");
        }
        send(response, 200, await readFile(await localFile(name)), "text/plain; charset=utf-8");
      } else {
        throw new HttpError(404, "Not found.");
      }
    } catch (error) {
      const status = (error as HttpError).status ||
        ({ ENOENT: 404, EACCES: 403, EPERM: 403 } as Record<string, number>)[errorCode(error) ?? ""] ||
        (error instanceof SyntaxError ? 400 : 500);
      if (status === 500) console.error(errorMessage(error));
      send(response, status, { error: errorMessage(error) });
    }
  });
  await new Promise((ready, reject) => {
    server.once("error", reject);
    server.listen(Number(options.port), options.host, () => ready(undefined));
  });
  const port = (server.address() as AddressInfo).port;
  if (!requireToken) {
    console.log(`http://127.0.0.1:${port}/`);
  } else {
    const addresses = isWildcard(options.host) ? lanAddresses() : [options.host];
    for (const addr of addresses.length ? addresses : ["127.0.0.1"]) {
      console.log(`http://${bracket(addr)}:${port}/?token=${token}`);
    }
    console.log("Plain HTTP: the token travels in clear text on this network. Use a trusted network only.");
  }
  process.on("SIGINT", () => server.close(() => { process.exitCode = 130; }));
  process.on("SIGTERM", () => server.close());
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
