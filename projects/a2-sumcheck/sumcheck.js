// Sumcheck protocol over the prime field F_p, p = 2^31 - 1.
// Pure logic: no DOM, importable from both the browser and node --test.

export const P = 2147483647n;

// ---------------------------------------------------------------- op counter

// Counts field operations. The whole point of the protocol is that the two
// counters diverge, so every arithmetic helper takes one and ticks it.
export class Counter {
  constructor() {
    this.prover = 0;
    this.verifier = 0;
    this.oracle = 0;
  }
  clone() {
    const c = new Counter();
    c.prover = this.prover;
    c.verifier = this.verifier;
    c.oracle = this.oracle;
    return c;
  }
}

const PROVER = 'prover';
const VERIFIER = 'verifier';

function tick(c, who, n = 1) {
  if (c) c[who] += n;
}

// ---------------------------------------------------------------- arithmetic

export function add(a, b, c, who = PROVER) {
  tick(c, who);
  const s = a + b;
  return s >= P ? s - P : s;
}

export function sub(a, b, c, who = PROVER) {
  tick(c, who);
  const d = a - b;
  return d < 0n ? d + P : d;
}

export function mul(a, b, c, who = PROVER) {
  tick(c, who);
  return (a * b) % P;
}

export function pow(base, exp, c, who = PROVER) {
  let result = 1n;
  let b = base % P;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mul(result, b, c, who);
    b = mul(b, b, c, who);
    e >>= 1n;
  }
  return result;
}

// Fermat: a^(p-2) = a^-1 for a != 0 in a prime field.
export function inv(a, c, who = PROVER) {
  const x = ((a % P) + P) % P;
  if (x === 0n) throw new Error('zero has no inverse');
  return pow(x, P - 2n, c, who);
}

export function norm(x) {
  const r = x % P;
  return r < 0n ? r + P : r;
}

// ---------------------------------------------------------------- randomness

// splitmix32: small, seedable, good enough to pick verifier challenges in a
// demo. A real verifier would use the platform CSPRNG.
export function makeRng(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x9e3779b9) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

export function randomField(rng) {
  return BigInt(Math.floor(rng() * 2147483647));
}

// ---------------------------------------------------------- the polynomial g

// g is multilinear in v variables, so it is fully determined by its 2^v values
// on the boolean hypercube. Index i encodes (x1..xv) with x1 in the high bit.
export const PRESETS = [
  { id: 'random', name: 'Random values', blurb: 'Every corner of the cube holds an unrelated field element. Nothing to exploit, nothing to compress.' },
  { id: 'parity', name: 'Parity', blurb: 'One when the input has an odd number of ones. A textbook boolean function, extended to the field.' },
  { id: 'popcount', name: 'Bit count', blurb: 'The number of ones in the input. The sum has a closed form, v * 2^(v-1), so the claim is checkable by hand.' },
  { id: 'spike', name: 'Sparse spikes', blurb: 'Almost all zeros with a handful of large values. Shows the sum being carried by a few cells.' },
];

export function makePolynomial(preset, v, rng = makeRng(1)) {
  const n = 1 << v;
  const table = new Array(n);
  for (let i = 0; i < n; i++) {
    switch (preset) {
      case 'parity':
        table[i] = BigInt(popcount(i) & 1);
        break;
      case 'popcount':
        table[i] = BigInt(popcount(i));
        break;
      case 'spike':
        table[i] = rng() < 0.12 ? randomField(rng) : 0n;
        break;
      default:
        table[i] = randomField(rng);
    }
  }
  return table;
}

function popcount(x) {
  let n = 0;
  while (x) {
    n += x & 1;
    x >>>= 1;
  }
  return n;
}

// The honest claim: what the verifier would have to compute itself.
export function naiveSum(table, c = null, who = PROVER) {
  let s = 0n;
  for (let i = 0; i < table.length; i++) s = add(s, table[i], c, who);
  return s;
}

// Multilinear extension of the table, evaluated at an arbitrary field point.
// Folds one variable at a time: h(x2..xv) = (1-r)*h(0,..) + r*h(1,..).
export function evalMultilinear(table, point, c = null, who = PROVER) {
  let cur = table;
  for (const r of point) {
    const half = cur.length >> 1;
    const next = new Array(half);
    for (let i = 0; i < half; i++) next[i] = interpolate(cur[i], cur[half + i], r, c, who);
    cur = next;
  }
  return cur[0];
}

// Degree-1 interpolation through (0, y0) and (1, y1), evaluated at r.
export function interpolate(y0, y1, r, c = null, who = PROVER) {
  return add(y0, mul(r, sub(y1, y0, c, who), c, who), c, who);
}

// ------------------------------------------------------------- the protocol

export const CHEATS = [
  { id: 'none', name: 'Honest prover' },
  { id: 'sum', name: 'Lies about the total' },
  { id: 'round', name: 'Corrupts one round' },
];

/**
 * Run the whole interactive protocol and return a transcript the UI can render
 * round by round. Nothing here touches the DOM.
 *
 * cheat: 'none' | 'sum' | 'round'
 *   'sum'   the prover states a total that is off by one and then patches every
 *           later polynomial so each individual check still passes.
 *   'round' the prover is honest until round `cheatRound`, where it shifts the
 *           polynomial by a delta that preserves s(0) + s(1) - so that round's
 *           check passes and the lie only surfaces at the end.
 */
export function runProtocol({ table, cheat = 'none', cheatRound = 1, rng = makeRng(7), delta = 1n }) {
  const v = Math.log2(table.length) | 0;
  if (1 << v !== table.length) throw new Error('table length must be a power of two');

  const c = new Counter();
  const trueSum = naiveSum(table, c, PROVER);
  const claimedSum = cheat === 'sum' ? add(trueSum, norm(delta), c, PROVER) : trueSum;

  const rounds = [];
  const challenges = [];
  let cur = table.slice();
  let claim = claimedSum;
  let honest = cheat !== 'sum';

  for (let i = 0; i < v; i++) {
    const half = cur.length >> 1;
    const before = cur.slice();

    // Prover: s_i(0) and s_i(1) are the two half-sums of the current table.
    let s0 = 0n;
    let s1 = 0n;
    for (let j = 0; j < half; j++) {
      s0 = add(s0, cur[j], c, PROVER);
      s1 = add(s1, cur[half + j], c, PROVER);
    }

    let tampered = null;
    if (cheat === 'sum' && add(s0, s1, null) !== claim) {
      // Keep the round check satisfiable: leave s(0), move s(1).
      tampered = { was0: s0, was1: s1 };
      s1 = sub(claim, s0, c, PROVER);
      honest = false;
    } else if (cheat === 'round' && i === cheatRound - 1) {
      tampered = { was0: s0, was1: s1 };
      const d = norm(delta);
      s0 = add(s0, d, c, PROVER);
      s1 = sub(s1, d, c, PROVER); // sum preserved, so this round still passes
      honest = false;
    }

    // Verifier: one addition, one comparison.
    const lhs = add(s0, s1, c, VERIFIER);
    const ok = lhs === claim;

    const r = randomField(rng);
    challenges.push(r);

    // Verifier: evaluate the degree-1 polynomial at the challenge (3 ops).
    const next = interpolate(s0, s1, r, c, VERIFIER);

    // Prover: fold the table, halving it.
    const folded = new Array(half);
    for (let j = 0; j < half; j++) folded[j] = interpolate(cur[j], cur[half + j], r, c, PROVER);

    rounds.push({
      index: i + 1,
      variable: `x${i + 1}`,
      remainingVars: v - i,
      table: before,
      half,
      claim,
      s0,
      s1,
      // s_i(X) = b + a*X
      coeffs: { a: sub(s1, s0, null), b: s0 },
      check: { lhs, rhs: claim, ok },
      r,
      nextClaim: next,
      tampered,
      ops: c.clone(),
    });

    cur = folded;
    claim = next;
  }

  // Final step: one oracle query to g at the random point.
  const oracleCounter = new Counter();
  const oracleValue = evalMultilinear(table, challenges, oracleCounter, PROVER);
  c.oracle += 1;
  const finalOk = oracleValue === claim;

  const accepted = rounds.every((rd) => rd.check.ok) && finalOk;

  return {
    v,
    size: table.length,
    trueSum,
    claimedSum,
    cheat,
    cheatRound: cheat === 'round' ? cheatRound : null,
    honest,
    rounds,
    challenges,
    final: { point: challenges, oracleValue, expected: claim, ok: finalOk },
    accepted,
    ops: c,
    oracleCost: oracleCounter.prover,
  };
}

/** Verify a transcript from scratch, the way a sceptical third party would. */
export function verifyTranscript(transcript, table) {
  let claim = transcript.claimedSum;
  for (const rd of transcript.rounds) {
    if (add(rd.s0, rd.s1, null) !== claim) return { ok: false, failedAt: rd.index };
    claim = interpolate(rd.s0, rd.s1, rd.r, null);
  }
  const g = evalMultilinear(table, transcript.challenges, null);
  return { ok: g === claim, failedAt: g === claim ? null : 'oracle' };
}

// ------------------------------------------------------------- measurements

/**
 * Run a cheating prover `trials` times with fresh randomness and report how
 * often the verifier caught it, against the soundness bound d*v/p.
 */
export function soundnessExperiment({ v = 6, trials = 200, preset = 'random', cheat = 'sum', seed = 1 } = {}) {
  const rng = makeRng(seed);
  const table = makePolynomial(preset, v, rng);
  let caught = 0;
  let escaped = 0;
  for (let t = 0; t < trials; t++) {
    const run = runProtocol({
      table,
      cheat,
      cheatRound: 1 + (t % v),
      rng: makeRng((seed + t * 2654435761) >>> 0),
      delta: 1n + BigInt(t),
    });
    if (run.accepted) escaped++;
    else caught++;
  }
  const degree = 1;
  return {
    trials,
    caught,
    escaped,
    rate: caught / trials,
    bound: (degree * v) / Number(P), // max escape probability
    v,
    cheat,
  };
}

/** One benchmark row. `now` is injected so tests do not depend on a clock. */
export function benchmarkOne(v, now = () => 0, opts = {}) {
  const { verifierRepeats = 200, seed = 12345 } = opts;
  const table = makePolynomial('random', v, makeRng(seed));

  const tNaive0 = now();
  const total = naiveSum(table);
  const tNaive = now() - tNaive0;

  const tProve0 = now();
  const run = runProtocol({ table, rng: makeRng(seed + 1) });
  const tProve = now() - tProve0;

  // A single verification is far below clock resolution, so time a batch.
  const tVerify0 = now();
  for (let i = 0; i < verifierRepeats; i++) replayVerifier(run);
  const tVerify = (now() - tVerify0) / verifierRepeats;

  return {
    v,
    size: table.length,
    naiveMs: tNaive,
    proverMs: tProve,
    verifierMs: tVerify,
    proverOps: run.ops.prover,
    verifierOps: run.ops.verifier,
    accepted: run.accepted,
    total,
  };
}

/** Just the verifier's arithmetic over an existing transcript, nothing else. */
export function replayVerifier(run) {
  let claim = run.claimedSum;
  let ok = true;
  for (const rd of run.rounds) {
    if (add(rd.s0, rd.s1, null) !== claim) ok = false;
    claim = interpolate(rd.s0, rd.s1, rd.r, null);
  }
  return ok && claim === run.final.oracleValue;
}
