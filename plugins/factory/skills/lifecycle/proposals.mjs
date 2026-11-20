import { readFile } from "node:fs/promises";
import { emit, eventsFile, resolveFactory } from "./broker.mjs";

// Reads the events log and pairs every improve.proposed with the first improve.decided for its
// proposal_id. `open` has the proposals nobody decided, oldest first; `decided` has the rest, each
// with its decision event. A proposal waits for the user for as long as it takes: it never expires.
export async function scanProposals(file) {
  let text;
  try {
    text = await readFile(eventsFile(file), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { open: [], decided: [] };
    throw error;
  }
  const proposals = new Map();
  const decisions = new Map();
  for (const line of text.split("\n")) {
    if (!line.includes('"improve.')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const id = event?.data?.proposal_id;
    if (typeof id !== "string") continue;
    if (event.type === "improve.proposed") proposals.set(id, event);
    else if (event.type === "improve.decided" && !decisions.has(id)) decisions.set(id, event);
  }
  const open = [];
  const decided = [];
  for (const [id, event] of proposals) {
    const { rule, change, title, evidence, recommended, result } = event.data;
    const proposal = { id, rule, kind: change, title, evidence, recommended, result, at: event.at };
    if (decisions.has(id)) decided.push({ ...proposal, decision: decisions.get(id).data.decision, decided_at: decisions.get(id).at });
    else open.push(proposal);
  }
  const byTime = (a, b) => Date.parse(a.at) - Date.parse(b.at);
  return { open: open.sort(byTime), decided };
}

// Records the user's click. A proposal that is already decided keeps its first decision and
// records nothing, so a repeat click is a no-op. Returns null for an unknown proposal.
export async function decideProposal(file, id, decision, note) {
  const { open, decided } = await scanProposals(file);
  const done = decided.find((proposal) => proposal.id === id);
  if (done) return { recorded: false, decision: done.decision };
  if (!open.some((proposal) => proposal.id === id)) return null;
  const data = { proposal_id: id, decision, ...(note ? { note } : {}) };
  await emit(await resolveFactory(file), { type: "improve.decided", source: "dashboard", data });
  return { recorded: true, decision };
}
