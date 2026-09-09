// channel.js — a noisy radio channel, seeded so a run is reproducible. Pure,
// no DOM, no dependency: the PRNG is small enough to read in full below.

// ============================================================================
// mulberry32 — a small, fast, seedable PRNG. Not cryptographic; it exists
// purely so "run this at a 1% bit error rate" gives the same corrupted frames
// every time, which is what makes the accounting in the tests possible.
// ============================================================================

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Flips each bit of `bytes` independently with probability `bitErrorRate`.
 * Returns a new array; the input is never mutated. `rng` is a 0..1 generator,
 * normally one returned by mulberry32.
 */
export function corrupt(bytes, bitErrorRate, rng) {
  const out = Uint8Array.from(bytes);
  for (let byteIndex = 0; byteIndex < out.length; byteIndex++) {
    for (let bit = 0; bit < 8; bit++) {
      if (rng() < bitErrorRate) {
        out[byteIndex] ^= 1 << bit;
      }
    }
  }
  return out;
}

/**
 * Sends `count` copies of `frame` over a channel at `bitErrorRate`, checking
 * each with `checkFn` (typically crcOk from frame.js). Returns exact counts:
 * every frame lands in exactly one of the three buckets, so
 * intact + caughtByCrc + undetected === count always.
 */
export function runChannel(frame, count, bitErrorRate, seed, checkFn) {
  const rng = mulberry32(seed);
  let intact = 0;
  let caughtByCrc = 0;
  let undetected = 0;

  for (let i = 0; i < count; i++) {
    const received = corrupt(frame, bitErrorRate, rng);
    const unchanged = received.every((b, j) => b === frame[j]);
    const crcPasses = checkFn(received);
    if (unchanged) {
      intact++;
    } else if (crcPasses) {
      undetected++;
    } else {
      caughtByCrc++;
    }
  }

  return { total: count, intact, caughtByCrc, undetected };
}
