// data.js — the synthetic population. Pure, no DOM, deterministic from a seed.
//
// Nobody in here is real. The records are generated in code so the demo has no
// data file to fetch, no licence question, and no chance of leaking an actual
// person while demonstrating an attack that leaks an actual person.

/** mulberry32 — small, fast, and reproducible across Node and every browser. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller, driven by the supplied rng. */
export function normal(rng) {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Danish regions with plausible postcodes and a rough income multiplier.
// The five regions are real administrative units; the numbers attached to
// them are invented for the demo.
export const REGIONS = [
  { name: "Hovedstaden", postcodes: [2100, 2200, 2300, 2450, 2800], weight: 0.32, incomeFactor: 1.18 },
  { name: "Sjælland", postcodes: [4000, 4100, 4200, 4600], weight: 0.14, incomeFactor: 0.94 },
  { name: "Syddanmark", postcodes: [5000, 5200, 6000, 6700], weight: 0.21, incomeFactor: 0.96 },
  { name: "Midtjylland", postcodes: [8000, 8200, 8600, 8900], weight: 0.23, incomeFactor: 1.0 },
  { name: "Nordjylland", postcodes: [9000, 9200, 9800], weight: 0.1, incomeFactor: 0.9 },
];

export const DEFAULT_SEED = 20240517;
export const DEFAULT_SIZE = 2000;

function pickRegion(rng) {
  let r = rng();
  for (const region of REGIONS) {
    if (r < region.weight) return region;
    r -= region.weight;
  }
  return REGIONS[REGIONS.length - 1];
}

/**
 * Age 18-89, income in DKK/year, and a sensitive bit: has a chronic diagnosis.
 * Income rises with age to a plateau around 50 and dips after retirement;
 * the diagnosis probability rises steeply with age and mildly with low income,
 * so the correlations a real analyst would look for are actually present.
 */
export function generatePopulation(seed = DEFAULT_SEED, size = DEFAULT_SIZE) {
  const rng = makeRng(seed);
  const people = [];

  for (let i = 0; i < size; i++) {
    const region = pickRegion(rng);
    const postcode = region.postcodes[Math.floor(rng() * region.postcodes.length)];

    // Age: skewed towards working age, clipped to 18-89.
    const age = Math.max(18, Math.min(89, Math.round(42 + normal(rng) * 16)));

    const careerCurve = age < 50 ? (age - 18) / 32 : Math.max(0, 1 - (age - 50) / 45);
    const retired = age >= 67;
    const base = 260000 + 300000 * careerCurve;
    const noise = Math.exp(normal(rng) * 0.32);
    const income = Math.round(
      Math.max(90000, base * region.incomeFactor * noise * (retired ? 0.62 : 1))
    );

    // Logistic risk: age dominates, low income adds a little.
    const z = -4.4 + 0.062 * (age - 40) + 0.9 * Math.max(0, (330000 - income) / 330000);
    const p = 1 / (1 + Math.exp(-z));
    const condition = rng() < p;

    people.push({ id: i, age, region: region.name, postcode, income, condition });
  }

  return people;
}

/** Group sizes by region — used by the UI for the filter dropdown. */
export function regionNames() {
  return REGIONS.map((r) => r.name);
}
