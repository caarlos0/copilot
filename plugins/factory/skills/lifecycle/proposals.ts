import { readFile } from "node:fs/promises";
import { emit, eventsFile, resolveFactory } from "./broker.mjs";

type ProposalEvent = {
  type: string;
  at: string;
  data: {
    proposal_id: string;
    rule?: string;
    change?: string;
    title?: string;
    evidence?: unknown;
    recommended?: unknown;
    result?: unknown;
    decision?: string;
  };
};

type Proposal = {
  id: string;
  rule?: string;
  kind?: string;
  title?: string;
  evidence?: unknown;
  recommended?: unknown;
  result?: unknown;
  at: string;
};

// Reads the events log and pairs every improve.proposed with the first improve.decided for its
// proposal_id. `open` has the proposals nobody decided, oldest first; `decided` has the rest, each
// with its decision event. A proposal waits for the user for as long as it takes: it never expires.
export async function scanProposals(file: string) {
  let text: string;
  try {
    text = await readFile(eventsFile(file), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { open: [], decided: [] };
    throw error;
  }
  const proposals = new Map<string, ProposalEvent>();
  const decisions = new Map<string, ProposalEvent>();
  for (const line of text.split("\n")) {
    if (!line.includes('"improve.')) continue;
    let event: ProposalEvent;
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
  const open: Proposal[] = [];
  const decided: (Proposal & { decision?: string; decided_at: string })[] = [];
  for (const [id, event] of proposals) {
    const { rule, change, title, evidence, recommended, result } = event.data;
    const proposal = { id, rule, kind: change, title, evidence, recommended, result, at: event.at };
    const decision = decisions.get(id);
    if (decision) decided.push({ ...proposal, decision: decision.data.decision, decided_at: decision.at });
    else open.push(proposal);
  }
  const byTime = (a: Proposal, b: Proposal) => Date.parse(a.at) - Date.parse(b.at);
  return { open: open.sort(byTime), decided };
}

// Records the user's click. A proposal that is already decided keeps its first decision and
// records nothing, so a repeat click is a no-op. Returns null for an unknown proposal.
export async function decideProposal(file: string, id: string, decision: string, note?: string) {
  const { open, decided } = await scanProposals(file);
  const done = decided.find((proposal) => proposal.id === id);
  if (done) return { recorded: false, decision: done.decision };
  if (!open.some((proposal) => proposal.id === id)) return null;
  const data = { proposal_id: id, decision, ...(note ? { note } : {}) };
  await emit(await resolveFactory(file), { type: "improve.decided", source: "dashboard", data });
  return { recorded: true, decision };
}
