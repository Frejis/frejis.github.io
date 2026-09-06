// Selectivity: how much evidentiary weight a shared artifact carries.
// An artifact shared by a handful of hosts is strong evidence they are
// related; one shared by most of the dataset is background noise everyone
// happens to have (see the STRONG_MAX/MODERATE_MAX thresholds below).

// Thresholds are absolute host counts, not just ratios, so they read sensibly
// at this dataset's size (~90 hosts). Tune here only, nothing else depends on
// the exact numbers.
const STRONG_MAX = 5; // <= this many hosts sharing it: strong evidence
const MODERATE_MAX = 15; // <= this many: worth noting, not conclusive

export function countHostsWithValue(hosts, field, value) {
  let n = 0;
  for (const h of hosts) if (h[field] === value) n += 1;
  return n;
}

/**
 * Selectivity of one artifact value: how rare it is in the whole dataset.
 * Returns a 0-1 score (1 = unique to a single host, near 0 = nearly universal)
 * plus a human tier label.
 */
export function computeSelectivity(hosts, field, value) {
  const total = hosts.length;
  const count = countHostsWithValue(hosts, field, value);
  const score = count <= 0 ? 0 : 1 - (count - 1) / total;
  let tier;
  if (count <= STRONG_MAX) tier = "strong";
  else if (count <= MODERATE_MAX) tier = "moderate";
  else tier = "weak";
  return { field, value, count, total, score, tier };
}

/**
 * Ranks a list of (field, value) artifact candidates from most to least
 * selective (rarest first).
 */
export function rankBySelectivity(hosts, candidates) {
  return candidates
    .map((c) => computeSelectivity(hosts, c.field, c.value))
    .sort((a, b) => b.score - a.score);
}
