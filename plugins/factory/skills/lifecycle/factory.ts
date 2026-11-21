// The one factory command. Each subcommand loads its module only when it runs, so a hook pays no
// start cost for the CLIs it does not use. `bun run build` bundles this file to factory.mjs.

type Main = (argv: string[]) => unknown;
type Command = () => Promise<{ main: Main }>;

const commands: Record<string, Command> = {
  write: () => import("./tasks.ts"),
  broker: () => import("./broker.ts"),
  reconcile: () => import("./reconcile.ts"),
  serve: () => import("./serve.ts"),
  worktree: () => import("./worktree.ts"),
  "worker-name": () => import("./worker-name.ts"),
  shot: () => import("./shot.ts"),
  archive: () => import("./archive.ts"),
  "session-metrics": () => import("./session-metrics.ts"),
  migrate: () => import("./migrate.ts"),
  "pr-watch": () => import("./pr-watch.ts"),
};

const hooks: Record<string, Command> = {
  guard: () => import("../../hooks/guard.ts"),
  attention: () => import("../../hooks/attention.ts"),
  stop: () => import("../../hooks/stop-hook.ts"),
};

const usage = `Run a factory command.

Usage: node factory.mjs COMMAND [ARGS]

Commands:
  write FILE [OPTIONS]      Create or update a factory.json file (node factory.mjs write --help)
  broker wait|emit|cursor|armed
                            Wait for events, emit them, read the cursor, check the waiter
  reconcile FILE            Sweep a factory file and print findings
  serve                     Serve the dashboard
  worktree create|delete|path
                            Manage the worktree of a task
  worker-name               Print the name of a worker
  shot                      Screenshot the dashboard
  archive clean FILE        Delete old task artifacts
  session-metrics FILE      Count the events of the factory sessions
  migrate                   Move legacy handoffs into a factory file
  pr-watch                  Watch a pull request
  hook guard|attention|stop Run a Copilot hook (the payload comes on stdin)

Every command takes --help.
Exit: 2 for invalid usage.`;

async function main(argv: string[]) {
  const [name, ...rest] = argv;
  if (name === undefined || name === "-h" || name === "--help") {
    (name === undefined ? console.error : console.log)(usage);
    process.exitCode = name === undefined ? 2 : 0;
    return;
  }
  if (name === "hook") {
    const [hook, ...args] = rest;
    const load = hooks[hook ?? ""];
    if (!load) {
      console.error(`Unknown hook "${hook ?? ""}". Use guard, attention or stop.`);
      process.exitCode = 2;
      return;
    }
    await (await load()).main(args);
    // The attention hook must not keep the process alive.
    if (hook === "attention") process.exit(0);
    return;
  }
  const load = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!load) {
    console.error(`Unknown command "${name}".\n\n${usage}`);
    process.exitCode = 2;
    return;
  }
  try {
    await (await load()).main(rest);
  } catch (error) {
    if (name !== "migrate") throw error;
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

await main(process.argv.slice(2));
