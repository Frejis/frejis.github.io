// Shrink Lab engine: a miniature property-based testing library.
// Pure logic only - no DOM access here, so it can be imported by both the
// browser page and `node --test`.

// ---------------------------------------------------------------------------
// Seeded PRNG (SplitMix32). Deterministic: same seed, same stream, forever.
// ---------------------------------------------------------------------------

export function makeRng(seed) {
  let state = seed >>> 0;

  function nextUint32() {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0;
    return z;
  }

  return {
    seed: seed >>> 0,
    nextUint32,
    // float in [0, 1)
    next() {
      return nextUint32() / 0x100000000;
    },
    // integer in [min, max], inclusive both ends
    nextInt(min, max) {
      if (max < min) throw new Error(`nextInt: max (${max}) < min (${min})`);
      const range = max - min + 1;
      return min + Math.floor(this.next() * range);
    },
    nextBool() {
      return this.next() < 0.5;
    },
  };
}

// ---------------------------------------------------------------------------
// Shrinkable: a generated value plus a lazy list of "simpler" candidates.
// Generators build a tree of these; the runner walks it depth-first, greedily
// accepting the first candidate that still fails.
// ---------------------------------------------------------------------------

function shrinkable(value, shrinkFn) {
  return { value, shrink: shrinkFn || (() => []) };
}

// ---------------------------------------------------------------------------
// Generators. Each generator is `{ generate(rng, size) -> Shrinkable }`.
// ---------------------------------------------------------------------------

// Integers shrink towards the value in [min,max] closest to zero.
export function int(min, max) {
  if (min > max) throw new Error(`int: min (${min}) > max (${max})`);
  const target = min <= 0 && max >= 0 ? 0 : (min > 0 ? min : max);

  function candidatesTowardsTarget(x) {
    if (x === target) return [];
    const out = [];
    if (!out.includes(target)) out.push(target);
    let delta = x - target;
    while (Math.abs(delta) > 1) {
      delta = Math.trunc(delta / 2);
      const cand = target + delta;
      if (cand !== x && !out.includes(cand)) out.push(cand);
    }
    const oneStep = x > target ? x - 1 : x + 1;
    if (oneStep !== x && !out.includes(oneStep)) out.push(oneStep);
    return out;
  }

  function wrap(x) {
    return shrinkable(x, () => candidatesTowardsTarget(x).map(wrap));
  }

  return {
    generate(rng) {
      return wrap(rng.nextInt(min, max));
    },
  };
}

export function bool() {
  function wrap(v) {
    return shrinkable(v, () => (v === true ? [wrap(false)] : []));
  }
  return {
    generate(rng) {
      return wrap(rng.nextBool());
    },
  };
}

// Array of Shrinkables -> shrinks by removing chunks (halving repeatedly,
// classic "delta debugging" style), then by shrinking individual elements.
export function array(gen, opts = {}) {
  const minLength = opts.minLength ?? 0;
  const maxLength = opts.maxLength ?? 15;

  function mk(items) {
    return shrinkable(items.map((s) => s.value), () => shrinkItems(items));
  }

  function shrinkItems(items) {
    const out = [];
    const n = items.length;

    if (n > minLength) {
      if (minLength === 0) out.push(mk([]));
      for (let size = Math.floor(n / 2); size > 0; size = Math.floor(size / 2)) {
        for (let i = 0; i + size <= n; i += size) {
          const candidate = items.slice(0, i).concat(items.slice(i + size));
          if (candidate.length >= minLength) out.push(mk(candidate));
        }
        if (size === 1) break;
      }
    }

    for (let i = 0; i < n; i++) {
      for (const child of items[i].shrink()) {
        const candidate = items.slice();
        candidate[i] = child;
        out.push(mk(candidate));
      }
    }

    return out;
  }

  return {
    generate(rng, size) {
      const cap = Math.max(minLength, Math.min(maxLength, size ?? maxLength));
      const len = rng.nextInt(minLength, Math.max(minLength, cap));
      const items = [];
      for (let i = 0; i < len; i++) items.push(gen.generate(rng, size));
      return mk(items);
    },
  };
}

// String is generated as an array of char codes and mapped to text - it gets
// the array chunk-removal shrinker for free, plus char shrinking towards
// charMin, which is what pushes strings towards "".
export function string(opts = {}) {
  const minLength = opts.minLength ?? 0;
  const maxLength = opts.maxLength ?? 12;
  const charMin = opts.charMin ?? 97; // 'a'
  const charMax = opts.charMax ?? 122; // 'z'
  const codes = array(int(charMin, charMax), { minLength, maxLength });
  return map(codes, (cs) => cs.map((c) => String.fromCharCode(c)).join(""));
}

export function tuple(...gens) {
  function mk(items) {
    return shrinkable(items.map((s) => s.value), () => shrinkItems(items));
  }
  function shrinkItems(items) {
    const out = [];
    for (let i = 0; i < items.length; i++) {
      for (const child of items[i].shrink()) {
        const candidate = items.slice();
        candidate[i] = child;
        out.push(mk(candidate));
      }
    }
    return out;
  }
  return {
    generate(rng, size) {
      return mk(gens.map((g) => g.generate(rng, size)));
    },
  };
}

export function oneOf(...gens) {
  if (gens.length === 0) throw new Error("oneOf: needs at least one generator");
  return {
    generate(rng, size) {
      const idx = rng.nextInt(0, gens.length - 1);
      return gens[idx].generate(rng, size);
    },
  };
}

// map needs no inverse function: the Shrinkable tree already carries the
// pre-image, so shrinking is "shrink the original, then re-map each child".
export function map(gen, f) {
  function wrap(s) {
    return shrinkable(f(s.value), () => s.shrink().map(wrap));
  }
  return {
    generate(rng, size) {
      return wrap(gen.generate(rng, size));
    },
  };
}

export function filter(gen, pred, maxTries = 200) {
  function wrap(s) {
    return shrinkable(s.value, () => s.shrink().filter((c) => pred(c.value)).map(wrap));
  }
  return {
    generate(rng, size) {
      for (let i = 0; i < maxTries; i++) {
        const s = gen.generate(rng, size);
        if (pred(s.value)) return wrap(s);
      }
      throw new Error(`filter: no value satisfied the predicate in ${maxTries} tries`);
    },
  };
}

// ---------------------------------------------------------------------------
// Size estimate - a rough "how big/complex is this" number used for the
// shrink chart and the reduction stat. Arrays/strings are measured by
// length, which is what "40 elements -> 2 elements" means in the UI.
// ---------------------------------------------------------------------------

export function estimateSize(value) {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number") return Math.abs(value);
  if (typeof value === "string") return value.length;
  if (typeof value === "boolean") return value ? 1 : 0;
  return 1;
}

export function totalSize(values) {
  return values.reduce((sum, v) => sum + estimateSize(v), 0);
}

function runsProperty(property, values) {
  try {
    return { failed: !property(...values), error: null };
  } catch (err) {
    return { failed: true, error: err };
  }
}

// ---------------------------------------------------------------------------
// The runner.
// ---------------------------------------------------------------------------

// check(property, gens, opts) -> result
//   property(...values) -> boolean (or throws, which counts as a failure)
//   gens: array of generators, one per argument of `property`
export function check(property, gens, opts = {}) {
  const runs = opts.runs ?? 100;
  const seed = (opts.seed ?? (Date.now() ^ Math.floor(Math.random() * 0xffffffff))) >>> 0;
  const size = opts.size ?? 30;
  const maxShrinkSteps = opts.maxShrinkSteps ?? 2000;
  const recordDistribution = !!opts.recordDistribution;
  const onRun = opts.onRun; // optional (i, passed) callback

  const rng = makeRng(seed);
  const gensArr = Array.isArray(gens) ? gens : [gens];
  const distribution = recordDistribution ? [] : undefined;

  for (let i = 0; i < runs; i++) {
    const shrinkables = gensArr.map((g) => g.generate(rng, size));
    const values = shrinkables.map((s) => s.value);
    if (recordDistribution) distribution.push(totalSize(values));

    const { failed, error } = runsProperty(property, values);
    if (onRun) onRun(i, !failed);

    if (failed) {
      const { shrinkPath, minimalValues } = shrinkLoop(property, shrinkables, maxShrinkSteps);
      return {
        passed: false,
        runsExecuted: i + 1,
        seed,
        error: error ? String(error.message || error) : null,
        originalCounterexample: values,
        originalSize: totalSize(values),
        minimalCounterexample: minimalValues,
        minimalSize: totalSize(minimalValues),
        shrinkPath,
        distribution,
      };
    }
  }

  return { passed: true, runsExecuted: runs, seed, distribution };
}

// Greedy shrink: repeatedly try every "one step simpler" candidate (one
// generator dimension at a time) and jump to the first one that still fails.
// Stops when nothing simpler still fails, or the step budget runs out.
function shrinkLoop(property, initialShrinkables, maxSteps) {
  let current = initialShrinkables;
  let currentValues = current.map((s) => s.value);

  const path = [
    { step: 0, values: currentValues, size: totalSize(currentValues), failed: true, accepted: true },
  ];

  let step = 0;
  let stepsUsed = 0;

  while (stepsUsed < maxSteps) {
    const candidates = [];
    for (let i = 0; i < current.length; i++) {
      for (const child of current[i].shrink()) {
        const candidate = current.slice();
        candidate[i] = child;
        candidates.push(candidate);
      }
    }
    if (candidates.length === 0) break;

    let accepted = null;
    for (const candidate of candidates) {
      if (stepsUsed >= maxSteps) break;
      stepsUsed++;
      const values = candidate.map((s) => s.value);
      const { failed } = runsProperty(property, values);
      step++;
      const entry = { step, values, size: totalSize(values), failed, accepted: false };
      path.push(entry);
      if (failed) {
        entry.accepted = true;
        accepted = candidate;
        break;
      }
    }

    if (!accepted) break;
    current = accepted;
    currentValues = current.map((s) => s.value);
  }

  return { shrinkPath: path, minimalValues: currentValues };
}

// Runs `check` across many seeds without shrinking, purely to measure how
// many runs it typically takes to first hit a failure. Used for the
// "1000 runs" benchmark panel.
export function benchmarkTimeToFailure(property, gens, opts = {}) {
  const seedCount = opts.seeds ?? 200;
  const maxRuns = opts.maxRuns ?? 200;
  const size = opts.size ?? 30;
  const startSeed = opts.startSeed ?? 1;

  const results = [];
  for (let s = 0; s < seedCount; s++) {
    const seed = (startSeed + s) >>> 0;
    const result = check(property, gens, { runs: maxRuns, seed, size });
    results.push({ seed, runsToFailure: result.passed ? null : result.runsExecuted });
  }
  const found = results.filter((r) => r.runsToFailure !== null);
  return {
    results,
    failureRate: found.length / results.length,
    meanRunsToFailure: found.length ? found.reduce((s, r) => s + r.runsToFailure, 0) / found.length : null,
  };
}
