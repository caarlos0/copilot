#!/usr/bin/env node
// Attention hook for the `notification`, `permissionRequest` and `preToolUse`
// (ask_user only) hooks. It does nothing, silently, unless the session is a factory
// worker or the coordinator.
//
// - permissionRequest and the ask_user preToolUse leave a small note in $TMPDIR:
//   the command, the sandbox-bypass reason, or the question and options.
// - notification appends one `attention.requested` event to the factory events
//   log, with that note when it is fresh.
//
// It always exits 0, prints nothing, and makes no network call.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factoryFile, hookSession, isCoordinator } from "../skills/lifecycle/gate.mjs";

const MAX_TEXT = 2000;
const MAX_OPTIONS = 20;
const MAX_OPTION = 200;
const NOTE_TTL_MS = 30_000;

const clip = (value, max) => String(value).slice(0, max);
const noteFile = (session) =>
  join(process.env.TMPDIR || tmpdir(), `factory-attention-${session.replace(/[^\w-]/g, "_")}.json`);

// The role and pane of a factory worker or the coordinator, with the factory file;
// null for any other session. Env set by the launch command wins over the file.
function identify(input, env = process.env) {
  const session = hookSession(input);
  if (typeof session !== "string" || !session) return null;
  const file = factoryFile(input.cwd ?? process.cwd(), env);
  if (!file) return null;
  const found = { file, session, role: env.FACTORY_ROLE || undefined, pane: env.REX_BLOCK || undefined };
  if (env.FACTORY_TASK || env.FACTORY_ROLE) return found;
  if (isCoordinator(input, env)) return { ...found, role: "coordinator" };
  try {
    const factory = JSON.parse(readFileSync(file, "utf8"));
    for (const task of factory.tasks ?? []) {
      for (const [role, worker] of Object.entries(task.workers ?? {})) {
        if (worker?.session === session) return { ...found, role, pane: found.pane ?? worker.pane ?? undefined };
      }
    }
  } catch {}
  return null;
}

// What a permissionRequest or ask_user preToolUse payload says about the wait.
function observe(input) {
  const args = input.toolInput ?? input.toolArgs;
  if (!args || typeof args !== "object") return null;
  if (input.toolName === "ask_user") {
    if (typeof args.message !== "string") return null;
    // Only a form with one enum field has options the dashboard can pick by position.
    const fields = Object.values(args.requestedSchema?.properties ?? {});
    const choices = fields.length === 1 && Array.isArray(fields[0]?.enum) ? fields[0].enum : [];
    const options = choices.length > 0 && choices.every((option) => typeof option === "string")
      ? choices.slice(0, MAX_OPTIONS).map((option) => clip(option, MAX_OPTION))
      : [];
    return { type: "ask-user", text: args.message, options };
  }
  if (input.toolName === "bash" && typeof args.command === "string") {
    return {
      type: "command",
      command: args.command,
      bypass: args.requestSandboxBypass === true,
      reason: typeof args.requestSandboxBypassReason === "string" ? args.requestSandboxBypassReason : "",
    };
  }
  return null;
}

function takeNote(session, now) {
  const file = noteFile(session);
  try {
    const note = JSON.parse(readFileSync(file, "utf8"));
    rmSync(file, { force: true });
    return now - note.at <= NOTE_TTL_MS ? note : null;
  } catch {
    return null;
  }
}

// Only these notifications are a wait for the user. Any other type (an inbox message, a
// finished shell command) is not, so it raises nothing.
const PROMPTS = new Set(["permission_prompt", "elicitation_dialog"]);

function describe(input, note) {
  const message = typeof input.message === "string" ? input.message : "";
  if (input.notification_type === "elicitation_dialog") {
    return note?.type === "ask-user"
      ? { kind: "ask-user", text: note.text, options: note.options }
      : { kind: "ask-user", text: message, options: [] };
  }
  const matches = note?.type === "command" && message.includes(note.command.split("\n")[0].slice(0, 80));
  const bypass = /sandbox/i.test(message) || (matches && note.bypass);
  const reason = matches && note.bypass && note.reason ? `\nSandbox bypass: ${note.reason}` : "";
  return { kind: bypass ? "sandbox-bypass" : "permission", text: message + reason, options: [] };
}

async function main() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const who = input && typeof input === "object" ? identify(input) : null;
  if (!who) return;
  const now = Date.now();
  if (input.notification_type === undefined) {
    const note = observe(input);
    if (note) writeFileSync(noteFile(who.session), JSON.stringify({ ...note, at: now }), { mode: 0o600 });
    return;
  }
  if (!PROMPTS.has(input.notification_type)) return;
  const { kind, text, options } = describe(input, takeNote(who.session, now));
  const data = { session: who.session, kind, text: clip(text, MAX_TEXT) };
  if (who.role) data.role = who.role;
  if (who.pane) data.pane = who.pane;
  if (options.length) data.options = options;
  const { emit, resolveFactory } = await import("../skills/lifecycle/broker.mjs");
  await emit(await resolveFactory(who.file), { type: "attention.requested", source: "attention", data });
}

try {
  await main();
} catch {}
process.exit(0);
