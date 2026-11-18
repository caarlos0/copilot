import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { countByState, isObject, validate } from "./factory-data.mjs";
import { ConflictError, update } from "./factory.mjs";
import { stateDirectories } from "./state-dir.mjs";

const factoryFile = /-factory\.json$/i;
const maxBody = 16384;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function main() {
  let options;
  try {
    options = parseArgs({
      options: {
        help: { type: "boolean", short: "h" },
        directory: { type: "string" },
        port: { type: "string", default: "8766" },
      },
    }).values;
    if (!/^\d+$/.test(options.port) || Number(options.port) > 65535) {
      throw new Error("--port must be an integer from 0 to 65535.");
    }
  } catch (error) {
    console.error(`${error.message}\nRun with --help for usage.`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(`Serve the factory dashboard on 127.0.0.1.

Usage: node serve.mjs [--directory PATH] [--port PORT]
       bun serve.mjs [--directory PATH] [--port PORT]

  --directory PATH  Only this state directory (default: both ~/.local/state/copilot-factory
                    and the legacy ~/.local/state/copilot-coordinator, whichever exist;
                    the new one wins on a name clash)
  --port PORT       Listening port (default: 8766; 0 chooses an available port)
  -h, --help        Show help

Open the printed HTTP URL. It lists every <owner.repo>-factory.json in the directories.
Stop with Ctrl+C. No packages are required. Invalid arguments exit 2; startup failures exit 1.`);
    return;
  }

  // An explicit --directory means only that directory. Otherwise a file may live
  // in either state directory, and the first one that has it (the new one) wins.
  const directories = [];
  for (const configured of options.directory ? [resolve(options.directory)] : stateDirectories()) {
    const directory = await realpath(configured);
    await readdir(directory);
    directories.push({ configured, directory });
  }
  const assets = dirname(fileURLToPath(import.meta.url));

  async function localFile(value) {
    if (!value || value.includes("\0")) throw new HttpError(400, "A filename is required.");
    for (const { configured, directory } of directories) {
      const candidate = resolve(configured, value);
      if (dirname(candidate) !== directory && dirname(candidate) !== configured) {
        throw new HttpError(403, "File must be directly inside the configured state directory.");
      }
      let target;
      try {
        target = await realpath(candidate);
      } catch (error) {
        if (error.code === "ENOENT") continue;
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
  const parsed = new Map();

  async function factoryTag(file) {
    if (!file || !factoryFile.test(file) || file.includes("/")) {
      throw new HttpError(400, "Select a <owner.repo>-factory.json file.");
    }
    const target = await localFile(file);
    const { mtimeNs, size, ino } = await stat(target, { bigint: true });
    return { file, target, tag: `"${[mtimeNs, size, ino].map((value) => value.toString(36)).join("-")}"` };
  }

  async function readFactory({ file, target, tag }) {
    const cached = parsed.get(target);
    if (cached?.tag === tag) return cached.data;
    const data = JSON.parse(await readFile(target, "utf8"));
    try {
      validate(data);
    } catch (error) {
      throw new HttpError(400, `${file}: ${error.message}`);
    }
    parsed.set(target, { tag, data });
    return data;
  }

  async function loadFactory(file) {
    return readFactory(await factoryTag(file));
  }

  async function factoryNames() {
    const names = new Set();
    for (const { directory } of directories) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if ((!entry.isFile() && !entry.isSymbolicLink()) || !factoryFile.test(entry.name) ||
            entry.name.startsWith(".")) continue;
        names.add(entry.name);
      }
    }
    return [...names].sort();
  }

  // The listing tag covers every file, valid or not, so a change to a broken file is seen too.
  async function listingTags() {
    const entries = await Promise.all((await factoryNames()).map(async (file) => {
      try {
        return await factoryTag(file);
      } catch (error) {
        return { file, error };
      }
    }));
    const tag = createHash("sha1").update(JSON.stringify(entries.map((entry) =>
      [entry.file, entry.tag ?? entry.error.message]))).digest("base64url");
    return { entries, tag: `"${tag}"` };
  }

  async function listFactories(entries) {
    const factories = [];
    const errors = [];
    for (const entry of entries) {
      try {
        if (entry.error) throw entry.error;
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
        errors.push({ file: entry.file, error: error.message });
      }
    }
    factories.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) ||
      a.file.localeCompare(b.file));
    errors.sort((a, b) => a.file.localeCompare(b.file));
    return { directories: directories.map(({ directory }) => directory), factories, errors };
  }

  function send(response, status, body, type = "application/json; charset=utf-8", headers = {}) {
    response.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    });
    response.end(typeof body === "object" && !Buffer.isBuffer(body) ? JSON.stringify(body) : body);
  }

  // The body is built only when the browser's tag is stale.
  async function sendTagged(request, response, tag, body) {
    const seen = request.headers["if-none-match"]?.split(",").map((value) => value.trim().replace(/^W\//, ""));
    if (seen?.includes(tag) || seen?.includes("*")) {
      response.writeHead(304, { "Cache-Control": "no-store", ETag: tag, "X-Content-Type-Options": "nosniff" });
      response.end();
    } else {
      send(response, 200, await body(), undefined, { ETag: tag });
    }
  }

  async function readJSONBody(request) {
    if (request.headers.origin !== `http://${request.headers.host}` ||
        (request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin")) {
      throw new HttpError(403, "State changes must come from this dashboard.");
    }
    if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
      throw new HttpError(415, "State changes require application/json.");
    }
    if (Number(request.headers["content-length"]) > maxBody) {
      throw new HttpError(413, "State change is too large (maximum 16 KiB).");
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maxBody) throw new HttpError(413, "State change is too large (maximum 16 KiB).");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  async function write(file, values) {
    try {
      return await update(await localFile(file), values, { operator: true });
    } catch (error) {
      if (error instanceof ConflictError) throw new HttpError(409, error.message);
      if (error.code) throw error;
      throw new HttpError(400, error.message);
    }
  }

  async function moveTask(request, file) {
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

  // set holds only the sections the user changed; expected holds what the browser saw for each of them.
  async function setSettings(request, file) {
    const body = await readJSONBody(request);
    const known = (value, keys) => isObject(value) && Object.keys(value).every((key) => keys.includes(key));
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
    const values = {};
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

  const server = createServer(async (request, response) => {
    try {
      const port = server.address().port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (port === 80) hosts.push("127.0.0.1", "localhost");
      if (!hosts.includes(request.headers.host)) {
        throw new HttpError(403, "Use the printed loopback URL.");
      }
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (request.method === "POST" && url.pathname === "/api/move") {
        send(response, 200, await moveTask(request, url.searchParams.get("file")));
      } else if (request.method === "POST" && url.pathname === "/api/settings") {
        send(response, 200, await setSettings(request, url.searchParams.get("file")));
      } else if (request.method !== "GET") {
        throw new HttpError(405, "Use GET, or POST /api/move or /api/settings for dashboard changes.");
      } else if (url.pathname === "/" || url.pathname === "/dashboard.html") {
        send(response, 200, await readFile(join(assets, "dashboard.html")), "text/html; charset=utf-8");
      } else if (url.pathname === "/factory-data.mjs") {
        send(response, 200, await readFile(join(assets, "factory-data.mjs")), "text/javascript; charset=utf-8");
      } else if (url.pathname === "/api/factories") {
        const { entries, tag } = await listingTags();
        await sendTagged(request, response, tag, () => listFactories(entries));
      } else if (url.pathname === "/api/factory") {
        const entry = await factoryTag(url.searchParams.get("file"));
        await sendTagged(request, response, entry.tag, () => readFactory(entry));
      } else if (url.pathname === "/api/artifact") {
        const data = await loadFactory(url.searchParams.get("file"));
        const name = url.searchParams.get("name");
        const referenced = [...data.tasks.map((task) => Object.values(task.workers)),
          data.rules.map((rule) => rule.worker)].some((workers) => workers
          .some((worker) => worker && (worker.brief === name || worker.result === name)));
        if (!name || !referenced) {
          throw new HttpError(403, "Artifact is not referenced by the selected factory.");
        }
        send(response, 200, await readFile(await localFile(name)), "text/plain; charset=utf-8");
      } else {
        throw new HttpError(404, "Not found.");
      }
    } catch (error) {
      const status = error.status || ({ ENOENT: 404, EACCES: 403, EPERM: 403 })[error.code] ||
        (error instanceof SyntaxError ? 400 : 500);
      if (status === 500) console.error(error.message);
      send(response, status, { error: error.message });
    }
  });
  await new Promise((ready, reject) => {
    server.once("error", reject);
    server.listen(Number(options.port), "127.0.0.1", ready);
  });
  console.log(`http://127.0.0.1:${server.address().port}/`);
  process.on("SIGINT", () => server.close(() => { process.exitCode = 130; }));
  process.on("SIGTERM", () => server.close());
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
