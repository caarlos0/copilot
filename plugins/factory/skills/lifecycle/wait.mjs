import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { dueRules, nextDue } from "./factory-data.mjs";

const maxTimer = 2 ** 31 - 1;

async function readOptional(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function waitForResults(cursor, files, factory) {
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
  let timer;
  let stopped = false;
  try {
    return await new Promise((complete, fail) => {
      let dirty = false;
      let checking = false;
      let dueAt = null;
      let dueFired = false;
      const withDue = async (result, now = Date.now()) => {
        if (!factory) return result;
        return { ...result, due: dueRules(JSON.parse(await readFile(factory, "utf8")), now) };
      };
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
              complete(await withDue({ changed }));
            } else if (dueFired) {
              stopped = true;
              complete(await withDue({ changed: [] }, Math.max(Date.now(), dueAt)));
            }
          }
        } catch (error) {
          stopped = true;
          fail(error);
        } finally {
          checking = false;
        }
      }

      async function armDue() {
        dueAt = nextDue(JSON.parse(await readFile(factory, "utf8")));
        if (dueAt === null) return;
        const tick = () => {
          const left = dueAt - Date.now();
          if (left > maxTimer) {
            timer = setTimeout(tick, maxTimer);
          } else if (left > 0) {
            timer = setTimeout(tick, left);
          } else {
            dueFired = true;
            void check();
          }
        };
        tick();
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
      if (factory) armDue().catch((error) => {
        stopped = true;
        fail(error);
      });
    });
  } finally {
    stopped = true;
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  }
}

async function main() {
  let cursor;
  let files;
  let factory;
  try {
    const { values, positionals } = parseArgs({
      options: {
        help: { type: "boolean", short: "h" },
        cursor: { type: "string" },
        due: { type: "string" },
      },
      allowPositionals: true,
    });
    if (values.help) {
      console.log(`Wait for coordinator worker result changes without polling.

Deprecated in the factory plugin: use broker.mjs wait, which wakes on typed events and ignores
the waiter's own writes.

Usage: node wait.mjs --cursor FILE [--due FACTORY_FILE] RESULT [RESULT ...]
       bun wait.mjs --cursor FILE [--due FACTORY_FILE] RESULT [RESULT ...]

  --cursor FILE       Coordinator-owned snapshot; reuse it when rearming
  --due FACTORY_FILE  Also wake when an enabled rule with "every" is due; reads the factory
                      file when it starts, so rearm after every wake. Prints a "due" array
                      of rule IDs. A due wake does not touch the cursor
  -h, --help          Show help

Options can appear before or after results; -- ends option parsing.
Result parent directories must exist. Missing results are allowed.
Existing results not in the cursor count as changes. Deleted results count once.
Watches parent directories so atomic result replacements remain visible.
Prints one JSON object {"changed":["/absolute/result/path",...]} and exits.
With --due it also prints "due": ["rule-id",...]; the list is empty when only results changed.
Only selected result paths are saved in the atomically replaced cursor.
Progress and errors go to stderr. No stdin or network access is required.
Exit: 0 on change or due rule, 1 on operational failure, 2 on invalid usage.
Use one waiter per cursor. Stop the process to cancel.`);
      return;
    }
    if (!values.cursor || positionals.length === 0) {
      throw new Error("--cursor FILE and at least one result path are required.");
    }
    cursor = resolve(values.cursor);
    files = [...new Set(positionals.map((file) => resolve(file)))];
    if (files.includes(cursor)) throw new Error("The cursor cannot also be a result file.");
    if (values.due !== undefined) factory = resolve(values.due);
  } catch (error) {
    console.error(`${error.message}\nRun with --help for usage.`);
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify(await waitForResults(cursor, files, factory)));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
