// Pivoting: expanding a selected host set by a shared artifact, plus a
// steppable history of that expansion so a user can walk back.

import { computeSelectivity } from "./selectivity.js";

/**
 * All hosts sharing `hosts[host.id][field]` with the given host, host included.
 */
export function hostsSharingArtifact(hosts, field, value) {
  return hosts.filter((h) => h[field] === value).map((h) => h.id);
}

/**
 * Creates the starting state for the pivot session: one host selected, an
 * empty step history.
 */
export function createSession(startHostId) {
  return {
    selected: [startHostId],
    steps: [], // { field, value, addedIds, selectivity }
  };
}

/**
 * Applies a pivot on (field, value) to a session, returning a NEW session
 * (does not mutate the input) with the expanded selection appended to history.
 */
export function applyPivot(session, hosts, field, value) {
  const matchIds = hostsSharingArtifact(hosts, field, value);
  const before = new Set(session.selected);
  const union = new Set([...session.selected, ...matchIds]);
  const addedIds = matchIds.filter((id) => !before.has(id));
  const selectivity = computeSelectivity(hosts, field, value);
  const step = { field, value, addedIds, matchIds, selectivity };
  return {
    selected: [...union],
    steps: [...session.steps, step],
  };
}

/**
 * Rolls a session back one pivot step, returning the exact prior selection.
 * Recomputes from scratch (start host + remaining steps) rather than trying
 * to "subtract" a step, since a later step may have re-added hosts that an
 * earlier one also touched.
 */
export function undoPivot(session, hosts, startHostId) {
  if (session.steps.length === 0) return session;
  const priorSteps = session.steps.slice(0, -1);
  let s = createSession(startHostId);
  for (const step of priorSteps) {
    s = applyPivot(s, hosts, step.field, step.value);
  }
  return s;
}

/**
 * The set of artifact values a given host's fields could pivot on, in the
 * form applyPivot/computeSelectivity expect.
 */
export function pivotCandidatesForHost(host, pivotFields) {
  return pivotFields.map(({ field }) => ({ field, value: host[field] }));
}
