// dp.js — the differential privacy engine. Pure, no DOM, importable in Node.
//
// Everything here works on one definition: a mechanism is ε-differentially
// private if removing any single person from the dataset changes the
// probability of every possible output by at most a factor of e^ε. The whole
// implementation is then two questions per query — how much can one person
// move this number (the sensitivity), and how much noise does that buy
// (the scale) — plus the bookkeeping that stops you asking forever.

import { makeRng } from "./data.js";

// ---------- mechanisms ----------

/**
 * One draw from Laplace(0, b) by inverse transform. u is uniform on
 * (-1/2, 1/2); the sign/log form below is the inverse CDF.
 *
 * Note the caveat in the README: this is the naive implementation everyone
 * writes, and it leaks a little through floating-point structure. A production
 * mechanism uses the discrete/snapping variants.
 */
export function laplaceSample(scale, rng) {
  const u = rng() - 0.5;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

/** Laplace scale for the classic mechanism: b = sensitivity / epsilon. */
export function laplaceScale(sensitivity, epsilon) {
  if (!(epsilon > 0)) throw new Error("epsilon must be positive");
  return sensitivity / epsilon;
}

/**
 * Gaussian mechanism, the (ε, δ) analogue. The classical analysis gives
 * σ = Δ2 · sqrt(2 ln(1.25/δ)) / ε, valid for ε ≤ 1; larger ε uses the same
 * formula here, which is conservative rather than wrong.
 */
export function gaussianSigma(sensitivity, epsilon, delta = 1e-5) {
  if (!(epsilon > 0)) throw new Error("epsilon must be positive");
  if (!(delta > 0 && delta < 1)) throw new Error("delta must be in (0,1)");
  return (sensitivity * Math.sqrt(2 * Math.log(1.25 / delta))) / epsilon;
}

export function gaussianSample(sigma, rng) {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Adds noise of the chosen mechanism, sized for `sensitivity` at `epsilon`. */
export function addNoise(value, sensitivity, epsilon, rng, mechanism = "laplace", delta = 1e-5) {
  if (mechanism === "gaussian") {
    return value + gaussianSample(gaussianSigma(sensitivity, epsilon, delta), rng);
  }
  return value + laplaceSample(laplaceScale(sensitivity, epsilon), rng);
}

// ---------- clamping and sensitivity ----------

export function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

/** A count changes by at most 1 when one person is added or removed. */
export function countSensitivity() {
  return 1;
}

/**
 * A sum over values clamped to [lo, hi] changes by at most the largest
 * magnitude a single clamped contribution can have. Without the clamp there is
 * no finite sensitivity at all: one billionaire makes every income sum
 * unboundedly sensitive, and no amount of noise is enough. Clamping is not a
 * tidying step, it is what makes the query answerable.
 */
export function sumSensitivity(lo, hi) {
  if (hi < lo) throw new Error("clamp bounds reversed");
  return Math.max(Math.abs(lo), Math.abs(hi));
}

/**
 * A mean is released as noisy-sum over noisy-count, so it spends half its
 * epsilon on each part. This returns the two component sensitivities rather
 * than one number, because there is no single "sensitivity of a mean".
 */
export function meanSensitivities(lo, hi) {
  return { sum: sumSensitivity(lo, hi), count: countSensitivity() };
}

// ---------- composition ----------

/** Sequential composition: answering k queries on the same people costs the sum. */
export function composeSequential(epsilons) {
  return epsilons.reduce((a, b) => a + b, 0);
}

/**
 * Parallel composition: queries over disjoint groups of people cost the
 * maximum, not the sum. One person sits in exactly one group, so only one of
 * the queries can see them. This is why a whole histogram is as cheap as its
 * single most expensive bin.
 */
export function composeParallel(epsilons) {
  return epsilons.reduce((a, b) => Math.max(a, b), 0);
}

// ---------- budget ----------

export class BudgetExhaustedError extends Error {
  constructor(requested, remaining) {
    super(
      `query needs ε=${requested.toFixed(3)} but only ε=${remaining.toFixed(3)} remains; ` +
        `answering it would break the guarantee, so it is refused`
    );
    this.name = "BudgetExhaustedError";
    this.requested = requested;
    this.remaining = remaining;
  }
}

/**
 * The running privacy budget. Every answered query is written to a ledger and
 * the total is subtracted. When it is gone, queries are refused — there is no
 * "just one more", because the guarantee is about the whole sequence.
 */
export class PrivacyBudget {
  constructor(total) {
    this.total = total;
    this.ledger = [];
  }

  get spent() {
    return composeSequential(this.ledger.map((e) => e.epsilon));
  }

  get remaining() {
    return Math.max(0, this.total - this.spent);
  }

  get fraction() {
    return this.total > 0 ? this.remaining / this.total : 0;
  }

  canAfford(epsilon) {
    return epsilon <= this.remaining + 1e-12;
  }

  /** Records a spend, or throws BudgetExhaustedError without recording it. */
  spend(epsilon, label, extra = {}) {
    if (!this.canAfford(epsilon)) {
      throw new BudgetExhaustedError(epsilon, this.remaining);
    }
    const entry = { epsilon, label, at: this.ledger.length + 1, ...extra };
    this.ledger.push(entry);
    return entry;
  }

  reset() {
    this.ledger = [];
  }
}

// ---------- filters and queries ----------

/** A filter is a plain object; every present key must match. */
export function matches(person, filter = {}) {
  if (filter.region && person.region !== filter.region) return false;
  if (filter.minAge != null && person.age < filter.minAge) return false;
  if (filter.maxAge != null && person.age > filter.maxAge) return false;
  if (filter.condition != null && person.condition !== filter.condition) return false;
  if (filter.postcode != null && person.postcode !== filter.postcode) return false;
  if (filter.exactAge != null && person.age !== filter.exactAge) return false;
  if (typeof filter.exclude === "function" && filter.exclude(person)) return false;
  return true;
}

export function select(people, filter) {
  return people.filter((p) => matches(p, filter));
}

/**
 * Runs one query and returns both answers. A real system would never hand back
 * the true value — this one does because it is a teaching tool and the gap
 * between the two columns is the entire point.
 *
 * spec: { type, field?, clamp?: [lo, hi], filter?, buckets? }
 */
export function runQuery(people, spec, opts = {}) {
  const {
    epsilon = 1,
    mechanism = "laplace",
    delta = 1e-5,
    rng = Math.random,
    privacy = true,
  } = opts;

  const rows = select(people, spec.filter);
  const noise = (value, sensitivity, eps) =>
    privacy ? addNoise(value, sensitivity, eps, rng, mechanism, delta) : value;

  switch (spec.type) {
    case "count": {
      const trueValue = rows.length;
      const sensitivity = countSensitivity();
      // One draw, reported twice: rawNoisy is what the mechanism produced,
      // noisyValue is the post-processed release (counts are non-negative
      // integers). Post-processing never costs extra epsilon.
      const raw = noise(trueValue, sensitivity, epsilon);
      return {
        type: "count",
        trueValue,
        noisyValue: Math.max(0, Math.round(raw)),
        rawNoisy: raw,
        sensitivity,
        scale: laplaceScale(sensitivity, epsilon),
        epsilon,
        n: rows.length,
      };
    }

    case "sum": {
      const [lo, hi] = spec.clamp;
      const clamped = rows.map((p) => clamp(p[spec.field], lo, hi));
      const trueValue = clamped.reduce((a, b) => a + b, 0);
      const sensitivity = sumSensitivity(lo, hi);
      return {
        type: "sum",
        trueValue,
        noisyValue: noise(trueValue, sensitivity, epsilon),
        sensitivity,
        scale: laplaceScale(sensitivity, epsilon),
        epsilon,
        clamped: rows.filter((p) => p[spec.field] < lo || p[spec.field] > hi).length,
        n: rows.length,
      };
    }

    case "mean": {
      const [lo, hi] = spec.clamp;
      const clamped = rows.map((p) => clamp(p[spec.field], lo, hi));
      const sum = clamped.reduce((a, b) => a + b, 0);
      const trueValue = rows.length ? sum / rows.length : null;
      const s = meanSensitivities(lo, hi);
      // Split the budget evenly between the two releases; they compose
      // sequentially, so half each keeps the total at epsilon.
      const half = epsilon / 2;
      const noisySum = noise(sum, s.sum, half);
      const noisyCount = noise(rows.length, s.count, half);
      const denom = Math.max(1, noisyCount);
      return {
        type: "mean",
        trueValue,
        noisyValue: clamp(noisySum / denom, lo, hi),
        sensitivity: s.sum,
        scale: laplaceScale(s.sum, half),
        epsilon,
        splitEpsilon: half,
        clamped: rows.filter((p) => p[spec.field] < lo || p[spec.field] > hi).length,
        n: rows.length,
      };
    }

    case "histogram": {
      // Disjoint buckets, so parallel composition applies: the whole histogram
      // costs epsilon, not epsilon per bar.
      const buckets = spec.buckets;
      const sensitivity = countSensitivity();
      const bins = buckets.map((b) => {
        const trueValue = rows.filter((p) => b.test(p)).length;
        return {
          label: b.label,
          trueValue,
          noisyValue: Math.max(0, Math.round(noise(trueValue, sensitivity, epsilon))),
        };
      });
      return {
        type: "histogram",
        bins,
        trueValue: bins.map((b) => b.trueValue),
        noisyValue: bins.map((b) => b.noisyValue),
        sensitivity,
        scale: laplaceScale(sensitivity, epsilon),
        epsilon,
        composition: "parallel",
        n: rows.length,
      };
    }

    default:
      throw new Error(`unknown query type: ${spec.type}`);
  }
}

// ---------- the differencing attack ----------

/**
 * Finds a person who is the only one in their region with their exact
 * (age, postcode) pair — that combination is the "quasi-identifier" that makes
 * two innocent-looking aggregates into a disclosure.
 */
export function findUniqueTarget(people) {
  const counts = new Map();
  for (const p of people) {
    const key = `${p.region}|${p.postcode}|${p.age}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const p of people) {
    const key = `${p.region}|${p.postcode}|${p.age}`;
    if (counts.get(key) === 1) return p;
  }
  return null;
}

/**
 * The classic differencing attack, in two queries no auditor would blink at:
 *
 *   A = how many people in region R have the condition
 *   B = how many people in region R have the condition, excluding the single
 *       person aged exactly N in postcode P
 *
 * A − B is that one person's sensitive bit. Nothing was "leaked" by either
 * query on its own; the leak is in the pair. With noise on, the difference of
 * two Laplace draws swamps a quantity that can only ever be 0 or 1.
 */
export function differencingAttack(people, target, opts = {}) {
  const { epsilon = 1, rng = Math.random, privacy = true, mechanism = "laplace" } = opts;

  const broad = { region: target.region, condition: true };
  const narrow = {
    ...broad,
    exclude: (p) => p.postcode === target.postcode && p.age === target.age,
  };

  const shared = { epsilon, rng, privacy, mechanism };
  const a = runQuery(people, { type: "count", filter: broad }, shared);
  const b = runQuery(people, { type: "count", filter: narrow }, shared);

  const guess = Math.round(a.rawNoisy - b.rawNoisy) >= 1;
  return {
    target,
    broadCount: a,
    narrowCount: b,
    difference: a.rawNoisy - b.rawNoisy,
    guess,
    truth: target.condition,
    correct: guess === target.condition,
    // Two counts on the same people compose sequentially.
    epsilonSpent: privacy ? composeSequential([epsilon, epsilon]) : 0,
  };
}

/**
 * Repeats the attack and reports how often it is right. With privacy off this
 * is 1.0; with privacy on and small epsilon it walks down towards the 0.5 of a
 * coin flip. Seeded, so the curve is the same every time it is drawn.
 */
export function attackSuccessRate(people, target, epsilon, trials = 400, seed = 7) {
  const rng = makeRng(seed);
  let hits = 0;
  for (let i = 0; i < trials; i++) {
    if (differencingAttack(people, target, { epsilon, rng }).correct) hits++;
  }
  return hits / trials;
}

// ---------- measured error ----------

/**
 * Runs a query `trials` times at each epsilon and measures the mean absolute
 * error against the true answer. Nothing here is hardcoded: the chart in the
 * page is drawn from exactly this function.
 *
 * The theoretical line is E|Laplace(0, b)| = b = sensitivity/epsilon.
 */
export function errorVsEpsilon(people, spec, epsilons, trials = 200, seed = 11) {
  const rng = makeRng(seed);
  return epsilons.map((epsilon) => {
    const base = runQuery(people, spec, { epsilon, privacy: false });
    let total = 0;
    for (let i = 0; i < trials; i++) {
      const r = runQuery(people, spec, { epsilon, rng });
      total += Math.abs(r.noisyValue - base.trueValue);
    }
    return {
      epsilon,
      measured: total / trials,
      theoretical: laplaceScale(base.sensitivity, spec.type === "mean" ? epsilon / 2 : epsilon),
      trueValue: base.trueValue,
    };
  });
}

/** `runs` noisy answers to the same query, for the distribution chart. */
export function sampleDistribution(people, spec, epsilon, runs = 2000, seed = 3, mechanism = "laplace") {
  const rng = makeRng(seed);
  const out = new Float64Array(runs);
  for (let i = 0; i < runs; i++) {
    out[i] = runQuery(people, spec, { epsilon, rng, mechanism }).noisyValue;
  }
  return out;
}
