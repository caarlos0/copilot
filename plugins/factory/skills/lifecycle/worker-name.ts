import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const usage = `Usage:
  node worker-name.mjs --role ROLE --ref REF [--summary TEXT]

Prints the --name of a worker Copilot session: "<Verb> <ref>: <summary>".
ROLE is investigation, implementation, review, backlog (Find work) or improve.
REF is "#N", "owner/repo#N", a bare number (read as "#N"), a task ID, or a
rule ID. The name has at most 100 characters; a long summary ends with "…".`;

const MAX = 100;
const VERBS: Record<string, string> = {
  investigation: "Investigate",
  implementation: "Implement",
  review: "Review",
  backlog: "Find work",
  improve: "Improve",
};

const clean = (text?: string) =>
  String(text ?? "")
    .replace(/["'`\u2018\u2019\u201c\u201d]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function workerName({ role, ref, summary }: { role?: string; ref?: string; summary?: string }) {
  const verb = VERBS[role as string];
  if (!verb) throw new Error(`unknown role "${role}"; use ${Object.keys(VERBS).join(", ")}`);
  let id = clean(ref);
  if (!id) throw new Error("ref is required");
  if (/^\d+$/.test(id)) id = `#${id}`;
  const head = `${verb} ${id}`;
  if (Array.from(head).length > MAX) throw new Error(`"${head}" is longer than ${MAX} characters`);
  const chars = Array.from(clean(summary));
  const room = MAX - Array.from(`${head}: `).length;
  if (!chars.length || room < 1) return head;
  const text = chars.length <= room ? chars.join("") : `${chars.slice(0, room - 1).join("").trimEnd()}…`;
  return `${head}: ${text}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: { role: { type: "string" }, ref: { type: "string" }, summary: { type: "string" } },
      strict: true,
    });
    console.log(workerName(values));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${usage}`);
    process.exit(1);
  }
}
