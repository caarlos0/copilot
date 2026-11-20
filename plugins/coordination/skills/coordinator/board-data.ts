import * as v from "valibot";

export const statuses = ["pending", "running", "verifying", "blocked", "done"] as const;
const runStatuses = ["active", "paused", "blocked", "finished"] as const;

export type Status = (typeof statuses)[number];
export type RunStatus = (typeof runStatuses)[number];

export type Task = {
  id: string;
  goal: string;
  next_action: string;
  status: Status;
  updated_at: string;
  repository?: string | null;
  worker?: string | null;
  blocker?: string | null;
  brief?: string | null;
  result?: string | null;
  pr?: string | null;
  links?: string[] | null;
  details?: Record<string, unknown>;
};

export type Handoff = {
  id: string;
  project?: string | null;
  role?: string | null;
  goal: string;
  status: RunStatus;
  updated_at: string;
  tasks: Task[];
};

const text = (field: string) =>
  v.pipe(
    v.string(`${field} must be a non-empty string.`),
    v.check((value) => value.trim() !== "", `${field} must be a non-empty string.`),
  );

const timestamp = (field: string) =>
  v.pipe(
    text(field),
    v.check(
      (value) => /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)),
      `${field} must be a timestamp with a timezone.`,
    ),
  );

const artifact = (field: string) =>
  v.pipe(
    text(field),
    v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, `${field} must be a filename in the state directory.`),
  );

// First issue only: callers report one error at a time, in field order.
function parse<T>(schema: v.GenericSchema<unknown, T>, value: unknown) {
  const result = v.safeParse(schema, value, { abortEarly: true });
  if (!result.success) throw new Error(result.issues[0].message);
  return result.output;
}

export function artifactName(value: unknown, field = "artifact") {
  return parse(artifact(field), value);
}

export function githubURL(value: unknown, field = "link") {
  const link = parse(text(field), value);
  const url = new URL(link);
  if (url.origin !== "https://github.com" || url.username || url.password ||
      !/^\/[^/]+\/[^/]+\/(issues|pull)\/\d+$/.test(url.pathname)) {
    throw new Error(`${field} must be an HTTPS GitHub issue or pull request URL.`);
  }
  return url;
}

export function prURL(value: unknown) {
  const url = githubURL(value, "pr");
  if (url.pathname.split("/")[3] !== "pull") {
    throw new Error("pr must be an HTTPS GitHub pull request URL.");
  }
  return url.href;
}

const via = (check: (value: unknown) => unknown) =>
  v.rawCheck(({ dataset, addIssue }) => {
    try {
      check(dataset.value);
    } catch (error) {
      addIssue({ message: (error as Error).message });
    }
  });

const object = (message: string) =>
  v.custom<Record<string, any>>((value) => !!value && typeof value === "object" && !Array.isArray(value), message);

// Valibot reports a missing key as its own issue. Setting absent keys to undefined lets each
// field schema report its own message, as it does for a wrong value.
const fields = (entries: v.ObjectEntries) =>
  v.pipe(
    v.any(),
    v.transform((input: Record<string, any>) => ({
      ...Object.fromEntries(Object.keys(entries).map((key) => [key, undefined])),
      ...input,
    })),
    v.looseObject(entries),
  ) as unknown as v.GenericSchema<Record<string, any>>;

// Task rules depend on the handoff and on earlier tasks, so the schema is built per handoff. Each
// stage ends where a cross-field rule starts, so the first error follows the field order.
function handoffSchema(hasProject: boolean) {
  const ids = new Set<string>();
  const task = v.pipe(
    object("Each task must be a JSON object."),
    fields({
      id: text("task.id"),
      goal: text("task.goal"),
      next_action: text("task.next_action"),
      repository: v.nullish(text("task.repository")),
    }),
    v.check(
      (task) => hasProject || task.repository != null,
      ({ input }) => `Task ${input.id} needs a repository or a handoff project.`,
    ),
    fields({ updated_at: timestamp("task.updated_at") }),
    v.check(
      (task) => statuses.includes(task.status as Status),
      ({ input }) => `Unknown status for task ${input.id}: ${input.status}`,
    ),
    v.check((task) => {
      const seen = ids.has(task.id);
      ids.add(task.id);
      return !seen;
    }, ({ input }) => `Duplicate task ID: ${input.id}`),
    fields({
      worker: v.nullish(text("task.worker")),
      blocker: v.nullish(text("task.blocker")),
    }),
    v.check(
      (task) => task.blocker == null || task.status === "blocked",
      ({ input }) =>
        `Task ${input.id}: blocker is allowed only when status is blocked; clear it with --blocker null.`,
    ),
    fields({
      brief: v.nullish(artifact("task.brief")),
      result: v.nullish(artifact("task.result")),
      pr: v.nullish(v.pipe(v.unknown(), via(prURL))),
      links: v.nullish(v.array(
        v.pipe(v.unknown(), via((link) => githubURL(link, "task.links[]"))),
        "task.links must be an array.",
      )),
    }),
  );
  return v.pipe(
    object("Handoff must be a JSON object."),
    fields({
      id: text("id"),
      project: v.nullish(text("project")),
      role: v.nullish(text("role")),
      goal: text("goal"),
      updated_at: timestamp("updated_at"),
      status: v.picklist(runStatuses, "Handoff needs a valid run status and a tasks array."),
      tasks: v.array(task, "Handoff needs a valid run status and a tasks array."),
    }),
  );
}

export function validate(data: any): asserts data is Handoff {
  parse(handoffSchema(data?.project != null), data);
}
