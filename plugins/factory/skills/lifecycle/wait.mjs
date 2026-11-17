import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

async function readOptional(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function waitForResults(cursor, files) {
  const saved = await readOptional(cursor);
  const previous = saved === null ? {} : JSON.parse(saved);
  if (!previous || typeof previous !== "object" || Array.isArray(previous) ||
      Object.values(previous).some((hash) => hash !== null &&
        (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)))) {
    throw new Error(`${cursor}: expected an object of result paths and SHA256 hashes or null.`);
  }

  const directories = new Map();
  for (const file of files) {
    const directory = dirname(file);
    if (!directories.has(directory)) directories.set(directory, new Set());
    directories.get(directory).add(basename(file));
  }

  const watchers = [];
  let stopped = false;
  try {
    return await new Promise((complete, fail) => {
      let dirty = false;
      let checking = false;
      async function check() {
        dirty = true;
        if (checking || stopped) return;
        checking = true;
        try {
          while (dirty && !stopped) {
            dirty = false;
            const current = {};
            for (const file of files) {
              const content = await readOptional(file);
              current[file] = content === null ? null :
                createHash("sha256").update(content).digest("hex");
            }
            const changed = files.filter((file) => current[file] !== (previous[file] ?? null));
            if (changed.length) {
              const temporary = `${cursor}.${process.pid}.tmp`;
              await writeFile(temporary, JSON.stringify(current), { flag: "wx" });
              try {
                await rename(temporary, cursor);
              } finally {
                await rm(temporary, { force: true });
              }
              stopped = true;
              complete({ changed });
            }
          }
        } catch (error) {
          stopped = true;
          fail(error);
        } finally {
          checking = false;
        }
      }

      for (const [directory, names] of directories) {
        const watcher = watch(directory, (_, name) => {
          if (name === null || names.has(name)) void check();
        });
        watcher.on("error", (error) => {
          stopped = true;
          fail(error);
        });
        watcher.on("close", () => {
          if (!stopped) {
            stopped = true;
            fail(new Error(`Result watcher closed unexpectedly: ${directory}`));
          }
        });
        watchers.push(watcher);
      }
      console.error("Watching result files.");
      void check();
    });
  } finally {
    stopped = true;
    for (const watcher of watchers) watcher.close();
  }
}

async function main() {
  let cursor;
  let files;
  try {
    const { values, positionals } = parseArgs({
      options: {
        help: { type: "boolean", short: "h" },
        cursor: { type: "string" },
      },
      allowPositionals: true,
    });
    if (values.help) {
      console.log(`Wait for coordinator worker result changes without polling.

Usage: node wait.mjs --cursor FILE RESULT [RESULT ...]
       bun wait.mjs --cursor FILE RESULT [RESULT ...]

  --cursor FILE  Coordinator-owned snapshot; reuse it when rearming
  -h, --help     Show help

Options can appear before or after results; -- ends option parsing.
Result parent directories must exist. Missing results are allowed.
Existing results not in the cursor count as changes. Deleted results count once.
Watches parent directories so atomic result replacements remain visible.
Prints one JSON object {"changed":["/absolute/result/path",...]} and exits.
Only selected result paths are saved in the atomically replaced cursor.
Progress and errors go to stderr. No stdin or network access is required.
Exit: 0 on change, 1 on operational failure, 2 on invalid usage.
Use one waiter per cursor. Stop the process to cancel.`);
      return;
    }
    if (!values.cursor || positionals.length === 0) {
      throw new Error("--cursor FILE and at least one result path are required.");
    }
    cursor = resolve(values.cursor);
    files = [...new Set(positionals.map((file) => resolve(file)))];
    if (files.includes(cursor)) throw new Error("The cursor cannot also be a result file.");
  } catch (error) {
    console.error(`${error.message}\nRun with --help for usage.`);
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify(await waitForResults(cursor, files)));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
