// Deterministic PRNG (mulberry32) so the dataset is byte-identical run to run.
// No Math.random anywhere in the data path.

export function mulberry32(seed) {
  let t = seed >>> 0;
  return function rng() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng, min, max) {
  // inclusive of both ends
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick(rng, arr) {
  return arr[randInt(rng, 0, arr.length - 1)];
}

export function pickWeighted(rng, entries) {
  // entries: [[value, weight], ...]
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let x = rng() * total;
  for (const [value, w] of entries) {
    x -= w;
    if (x <= 0) return value;
  }
  return entries[entries.length - 1][0];
}

export function shuffle(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function hex(rng, length) {
  let s = "";
  for (let i = 0; i < length; i++) s += randInt(rng, 0, 15).toString(16);
  return s;
}
