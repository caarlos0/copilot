const usage = `Usage: node coordinator.mjs COMMAND [ARGUMENTS]

Commands:
  handoff  Write the coordinator handoff
  serve    Serve the task board
  wait     Wait for worker result changes

Run a command with --help for its usage.`;

const commands: Record<string, () => Promise<{ main(argv: string[]): Promise<void> }>> = {
  handoff: () => import("./handoff.ts"),
  serve: () => import("./serve.ts"),
  wait: () => import("./wait.ts"),
};

const [command, ...args] = process.argv.slice(2);
if (command === "-h" || command === "--help") {
  console.log(usage);
} else if (command === undefined || !Object.hasOwn(commands, command)) {
  console.error(command === undefined ? usage : `Unknown command "${command}".\n${usage}`);
  process.exitCode = 2;
} else {
  await (await commands[command]()).main(args);
}
