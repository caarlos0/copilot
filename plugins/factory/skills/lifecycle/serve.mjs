import { createServer } from "node:http";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { countByState, isObject, validate } from "./factory-data.mjs";
import { ConflictError, update } from "./factory.mjs";

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
        directory: { type: "string", default: join(homedir(), ".local/state/copilot-coordinator") },
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

  --directory PATH  State directory (default: ~/.local/state/copilot-coordinator)
  --port PORT       Listening port (default: 8766; 0 chooses an available port)
  -h, --help        Show help

Open the printed HTTP URL. It lists every <owner.repo>-factory.json in the directory.
Stop with Ctrl+C. No packages are required. Invalid arguments exit 2; startup failures exit 1.`);
    return;
  }

  const configuredDirectory = resolve(options.directory);
  const directory = await realpath(configuredDirectory);
  await readdir(directory);
  const assets = dirname(fileURLToPath(import.meta.url));

  async function localFile(value) {
    if (!value || value.includes("\0")) throw new HttpError(400, "A filename is required.");
    const candidate = resolve(directory, value);
    if (dirname(candidate) !== directory && dirname(candidate) !== configuredDirectory) {
      throw new HttpError(403, "File must be directly inside the configured state directory.");
    }
    const target = await realpath(candidate);
    if (dirname(target) !== directory || !(await stat(target)).isFile()) {
      throw new HttpError(403, "File must be a regular file inside the state directory.");
    }
    return target;
  }

  async function loadFactory(file) {
    if (!file || !factoryFile.test(file) || file.includes("/")) {
      throw new HttpError(400, "Select a <owner.repo>-factory.json file.");
    }
    const data = JSON.parse(await readFile(await localFile(file), "utf8"));
    try {
      validate(data);
    } catch (error) {
      throw new HttpError(400, `${file}: ${error.message}`);
    }
    return data;
  }

  async function listFactories() {
    const factories = [];
    const errors = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = entry.name;
      if ((!entry.isFile() && !entry.isSymbolicLink()) || !factoryFile.test(file) ||
          file.startsWith(".")) continue;
      try {
        const data = await loadFactory(file);
        factories.push({
          file,
          id: data.id,
          project: data.project,
          goal: data.goal,
          status: data.status,
          updated_at: data.updated_at,
          task_count: data.tasks.length,
          counts: countByState(data.tasks),
        });
      } catch (error) {
        errors.push({ file, error: error.message });
      }
    }
    factories.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) ||
      a.file.localeCompare(b.file));
    errors.sort((a, b) => a.file.localeCompare(b.file));
    return { directory, factories, errors };
  }

  function send(response, status, body, type = "application/json; charset=utf-8") {
    response.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(typeof body === "object" && !Buffer.isBuffer(body) ? JSON.stringify(body) : body);
  }

  async function moveTask(request, file) {
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
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isObject(body) ||
        Object.keys(body).some((key) => !["task", "state", "comment", "revision", "resolution"].includes(key)) ||
        !["task", "state", "comment"].every((key) => typeof body[key] === "string" && body[key].trim()) ||
        !Number.isSafeInteger(body.revision) || body.revision < 0) {
      throw new HttpError(400, "Provide task, state, a non-empty comment, and a non-negative task revision.");
    }
    const data = await loadFactory(file);
    if (!data.tasks.some((task) => task.id === body.task)) throw new HttpError(404, "Task not found.");
    try {
      return await update(await localFile(file), {
        task: body.task, state: body.state, note: body.comment,
        "expected-revision": String(body.revision), resolution: body.resolution,
      }, { operator: true });
    } catch (error) {
      if (error instanceof ConflictError) throw new HttpError(409, error.message);
      if (error.code) throw error;
      throw new HttpError(400, error.message);
    }
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
      } else if (request.method !== "GET") {
        throw new HttpError(405, "Use GET, or POST /api/move for dashboard state changes.");
      } else if (url.pathname === "/" || url.pathname === "/dashboard.html") {
        send(response, 200, await readFile(join(assets, "dashboard.html")), "text/html; charset=utf-8");
      } else if (url.pathname === "/factory-data.mjs") {
        send(response, 200, await readFile(join(assets, "factory-data.mjs")), "text/javascript; charset=utf-8");
      } else if (url.pathname === "/api/factories") {
        send(response, 200, await listFactories());
      } else if (url.pathname === "/api/factory") {
        send(response, 200, await loadFactory(url.searchParams.get("file")));
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
