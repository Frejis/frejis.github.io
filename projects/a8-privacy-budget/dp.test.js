import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePopulation, makeRng, DEFAULT_SEED, REGIONS } from "./data.js";
import {
  laplaceSample,
  laplaceScale,
  gaussianSigma,
  gaussianSample,
  clamp,
  countSensitivity,
  sumSensitivity,
  meanSensitivities,
  composeSequential,
  composeParallel,
  PrivacyBudget,
  BudgetExhaustedError,
  runQuery,
  select,
  findUniqueTarget,
  differencingAttack,
  attackSuccessRate,
  errorVsEpsilon,
} from "./dp.js";

const people = generatePopulation();

// ---------- data ----------

test("the generator is deterministic for a fixed seed", () => {
  const a = generatePopulation(DEFAULT_SEED, 200);
  const b = generatePopulation(DEFAULT_SEED, 200);
  assert.deepEqual(a, b);
});

test("a different seed gives a different population", () => {
  const a = generatePopulation(DEFAULT_SEED, 200);
  const b = generatePopulation(DEFAULT_SEED + 1, 200);
  assert.notDeepEqual(a, b);
});

test("the population is well formed and correlated as intended", () => {
  assert.equal(people.length, 2000);
  const names = REGIONS.map((r) => r.name);
  for (const p of people) {
    assert.ok(p.age >= 18 && p.age <= 89);
    assert.ok(names.includes(p.region));
    assert.ok(p.income >= 90000);
    assert.equal(typeof p.condition, "boolean");
  }
  // Diagnosis prevalence should climb with age, or the analysis is not interesting.
  const young = people.filter((p) => p.age < 40);
  const old = people.filter((p) => p.age >= 65);
  const rate = (g) => g.filter((p) => p.condition).length / g.length;
  assert.ok(rate(old) > rate(young) * 2, `old ${rate(old)} vs young ${rate(young)}`);
});

// ---------- mechanisms ----------

test("Laplace noise has approximately the right mean and variance", () => {
  const rng = makeRng(42);
  const scale = 2;
  const n = 200000;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const x = laplaceSample(scale, rng);
    sum += x;
    sumSq += x * x;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  assert.ok(Math.abs(mean) < 0.05, `mean was ${mean}`);
  // Var[Laplace(0,b)] = 2b^2 = 8
  assert.ok(Math.abs(variance - 8) < 0.4, `variance was ${variance}`);
});

test("Laplace scale is sensitivity/epsilon and rejects epsilon <= 0", () => {
  assert.equal(laplaceScale(1, 0.5), 2);
  assert.equal(laplaceScale(500000, 0.1), 5000000);
  assert.throws(() => laplaceScale(1, 0));
  assert.throws(() => laplaceScale(1, -1));
});

test("smaller epsilon means more noise", () => {
  assert.ok(laplaceScale(1, 0.1) > laplaceScale(1, 1));
  assert.ok(gaussianSigma(1, 0.1) > gaussianSigma(1, 1));
});

test("Gaussian sigma follows the classical analysis and samples match it", () => {
  const delta = 1e-5;
  const expected = (1 * Math.sqrt(2 * Math.log(1.25 / delta))) / 0.5;
  assert.ok(Math.abs(gaussianSigma(1, 0.5, delta) - expected) < 1e-12);
  assert.throws(() => gaussianSigma(1, 1, 0));
  assert.throws(() => gaussianSigma(1, 1, 1));

  const rng = makeRng(9);
  const sigma = 3;
  const n = 100000;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const x = gaussianSample(sigma, rng);
    sum += x;
    sumSq += x * x;
  }
  const mean = sum / n;
  assert.ok(Math.abs(mean) < 0.05, `mean was ${mean}`);
  assert.ok(Math.abs(sumSq / n - mean * mean - 9) < 0.3);
});

// ---------- sensitivity and clamping ----------

test("sensitivities are correct for count, sum and mean", () => {
  assert.equal(countSensitivity(), 1);
  assert.equal(sumSensitivity(0, 1000000), 1000000);
  assert.equal(sumSensitivity(-50, 200), 200);
  assert.equal(sumSensitivity(-500, 200), 500);
  assert.throws(() => sumSensitivity(10, 5));
  assert.deepEqual(meanSensitivities(0, 800000), { sum: 800000, count: 1 });
});

test("clamping bounds an outlier's contribution to the sum", () => {
  const bounds = [0, 800000];
  const spec = { type: "sum", field: "income", clamp: bounds, filter: { region: "Nordjylland" } };
  const base = runQuery(people, spec, { privacy: false }).trueValue;

  const withOutlier = people.map((p, i) =>
    i === people.findIndex((q) => q.region === "Nordjylland")
      ? { ...p, income: 9_000_000_000 }
      : p
  );
  const shifted = runQuery(withOutlier, spec, { privacy: false }).trueValue;

  const delta = shifted - base;
  assert.ok(delta > 0, "the outlier should still move the sum");
  assert.ok(
    delta <= sumSensitivity(...bounds),
    `one person moved the clamped sum by ${delta}, above the declared sensitivity`
  );
});

test("clamp itself is inclusive of the bounds", () => {
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(50, 0, 10), 10);
  assert.equal(clamp(4, 0, 10), 4);
});

// ---------- composition ----------

test("sequential composition sums epsilon, parallel takes the max", () => {
  assert.equal(composeSequential([0.1, 0.2, 0.4]), 0.7000000000000001);
  assert.ok(Math.abs(composeSequential([0.1, 0.2, 0.4]) - 0.7) < 1e-12);
  assert.equal(composeParallel([0.1, 0.2, 0.4]), 0.4);
  assert.equal(composeSequential([]), 0);
  assert.equal(composeParallel([]), 0);
});

test("a histogram is charged once, as parallel composition over disjoint bins", () => {
  const buckets = REGIONS.map((r) => ({ label: r.name, test: (p) => p.region === r.name }));
  const rng = makeRng(5);
  const res = runQuery(people, { type: "histogram", buckets }, { epsilon: 0.5, rng });
  assert.equal(res.composition, "parallel");
  assert.equal(res.epsilon, 0.5);
  assert.equal(composeParallel(res.bins.map(() => 0.5)), 0.5);
  assert.equal(
    res.trueValue.reduce((a, b) => a + b, 0),
    people.length
  );
});

// ---------- budget ----------

test("the budget drains and then refuses the query that would overrun it", () => {
  const budget = new PrivacyBudget(1);
  budget.spend(0.4, "count");
  budget.spend(0.5, "mean income");
  assert.ok(Math.abs(budget.spent - 0.9) < 1e-12);
  assert.ok(Math.abs(budget.remaining - 0.1) < 1e-12);

  assert.throws(() => budget.spend(0.5, "one too many"), BudgetExhaustedError);
  // The refused query must not have been recorded.
  assert.equal(budget.ledger.length, 2);
  assert.ok(Math.abs(budget.remaining - 0.1) < 1e-12);

  budget.spend(0.1, "exactly the remainder");
  assert.equal(budget.remaining, 0);
  assert.equal(budget.canAfford(0.001), false);

  budget.reset();
  assert.equal(budget.spent, 0);
  assert.equal(budget.fraction, 1);
});

// ---------- queries ----------

test("a count query returns the true answer plus noise around it", () => {
  const spec = { type: "count", filter: { region: "Midtjylland", condition: true } };
  const exact = runQuery(people, spec, { privacy: false });
  assert.equal(exact.trueValue, select(people, spec.filter).length);
  assert.equal(exact.noisyValue, exact.trueValue);
  assert.equal(exact.sensitivity, 1);

  const rng = makeRng(1);
  let total = 0;
  const runs = 4000;
  for (let i = 0; i < runs; i++) total += runQuery(people, spec, { epsilon: 0.5, rng }).noisyValue;
  assert.ok(Math.abs(total / runs - exact.trueValue) < 2, "noisy counts should centre on the truth");
});

test("a mean query stays inside its clamp bounds and splits its epsilon", () => {
  const spec = { type: "mean", field: "income", clamp: [0, 800000], filter: { region: "Sjælland" } };
  const rng = makeRng(2);
  const res = runQuery(people, spec, { epsilon: 1, rng });
  assert.equal(res.splitEpsilon, 0.5);
  assert.ok(res.noisyValue >= 0 && res.noisyValue <= 800000);
  assert.ok(res.trueValue > 100000 && res.trueValue < 800000);
});

test("measured error tracks the theoretical sensitivity/epsilon", () => {
  const spec = { type: "count", filter: { region: "Hovedstaden" } };
  const rows = errorVsEpsilon(people, spec, [0.05, 0.2, 1, 4], 600, 17);
  for (const r of rows) {
    assert.ok(r.measured > 0);
    // E|Laplace(0,b)| = b; allow 30% slack for the rounding and the sample size.
    assert.ok(
      Math.abs(r.measured - r.theoretical) < 0.3 * r.theoretical + 1,
      `at eps=${r.epsilon}: measured ${r.measured}, theory ${r.theoretical}`
    );
  }
  // Error must fall as epsilon rises.
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].measured < rows[i - 1].measured);
});

// ---------- the attack ----------

test("there is a uniquely identifying (region, postcode, age) target", () => {
  const target = findUniqueTarget(people);
  assert.ok(target, "expected at least one unique quasi-identifier");
  const twins = people.filter(
    (p) => p.region === target.region && p.postcode === target.postcode && p.age === target.age
  );
  assert.equal(twins.length, 1);
});

test("the differencing attack reads the sensitive bit exactly when noise is off", () => {
  const target = findUniqueTarget(people);
  for (let i = 0; i < 25; i++) {
    const r = differencingAttack(people, target, { privacy: false });
    assert.equal(r.guess, target.condition);
    assert.equal(r.correct, true);
    assert.equal(Math.abs(r.difference), target.condition ? 1 : 0);
  }
});

test("the attack also works against a target who does not have the condition", () => {
  const negative = people.find((p) => {
    if (p.condition) return false;
    const twins = people.filter(
      (q) => q.region === p.region && q.postcode === p.postcode && q.age === p.age
    );
    return twins.length === 1;
  });
  assert.ok(negative, "expected a unique target without the condition");
  const r = differencingAttack(people, negative, { privacy: false });
  assert.equal(r.guess, false);
  assert.equal(r.correct, true);
});

test("with DP on at small epsilon the attacker's success rate falls to near chance", () => {
  const target = findUniqueTarget(people);
  const weak = attackSuccessRate(people, target, 0.05, 1500, 23);
  assert.ok(Math.abs(weak - 0.5) < 0.08, `success rate at eps=0.05 was ${weak}`);

  const strong = attackSuccessRate(people, target, 20, 1500, 23);
  assert.ok(strong > weak + 0.2, `eps=20 (${strong}) should beat eps=0.05 (${weak})`);
});

test("the attack success rate is reproducible for a fixed seed", () => {
  const target = findUniqueTarget(people);
  assert.equal(
    attackSuccessRate(people, target, 0.5, 300, 99),
    attackSuccessRate(people, target, 0.5, 300, 99)
  );
});

test("the attack charges both of its queries to the budget", () => {
  const target = findUniqueTarget(people);
  const r = differencingAttack(people, target, { epsilon: 0.3, rng: makeRng(4) });
  assert.ok(Math.abs(r.epsilonSpent - 0.6) < 1e-12);
  assert.equal(differencingAttack(people, target, { privacy: false }).epsilonSpent, 0);
});

// ---------- wiring ----------
// Not logic, but the failure it catches is silent in a browser: app.js throws
// on the first missing element and the whole page stops wiring itself up.

test("every element id app.js reaches for exists in index.html", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (f) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
  const app = read("app.js");
  const html = read("index.html");

  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...app.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));

  const missing = [...used].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `app.js reads ids that index.html does not define`);
});

test("index.html links the shared theme at a path that exists", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const href = html.match(/href="([^"]*theme\.css)"/)[1];
  assert.ok(
    existsSync(new URL(`./${href}`, import.meta.url)),
    `theme.css link "${href}" does not resolve from this folder`
  );
});
