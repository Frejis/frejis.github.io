import test from 'node:test';
import assert from 'node:assert/strict';

import {
  P,
  add,
  sub,
  mul,
  inv,
  norm,
  makeRng,
  randomField,
  makePolynomial,
  naiveSum,
  evalMultilinear,
  runProtocol,
  verifyTranscript,
  soundnessExperiment,
  benchmarkOne,
  replayVerifier,
  PRESETS,
} from './sumcheck.js';

test('field inverse: a * a^-1 = 1 for many a', () => {
  const rng = makeRng(3);
  for (let i = 0; i < 200; i++) {
    const a = randomField(rng);
    if (a === 0n) continue;
    assert.equal(mul(a, inv(a)), 1n);
  }
  assert.equal(mul(1n, inv(1n)), 1n);
  assert.equal(mul(P - 1n, inv(P - 1n)), 1n);
  assert.throws(() => inv(0n), /no inverse/);
});

test('field arithmetic stays reduced and matches modular arithmetic', () => {
  const rng = makeRng(11);
  for (let i = 0; i < 200; i++) {
    const a = randomField(rng);
    const b = randomField(rng);
    assert.equal(add(a, b), (a + b) % P);
    assert.equal(sub(a, b), norm(a - b));
    assert.equal(mul(a, b), (a * b) % P);
    assert.ok(add(a, b) < P && sub(a, b) < P && mul(a, b) < P);
  }
});

test('multilinear extension agrees with the table at boolean points', () => {
  for (const v of [1, 2, 3, 5]) {
    const table = makePolynomial('random', v, makeRng(v * 17));
    for (let i = 0; i < table.length; i++) {
      // index i encodes (x1..xv) with x1 in the high bit
      const point = [];
      for (let b = v - 1; b >= 0; b--) point.push(BigInt((i >> b) & 1));
      assert.equal(evalMultilinear(table, point), table[i], `v=${v} i=${i}`);
    }
  }
});

test('multilinear extension is linear in each variable', () => {
  const v = 4;
  const table = makePolynomial('random', v, makeRng(99));
  const rng = makeRng(5);
  const rest = [randomField(rng), randomField(rng), randomField(rng)];
  const at = (x) => evalMultilinear(table, [x, ...rest]);
  const y0 = at(0n);
  const y1 = at(1n);
  for (const r of [2n, 7n, 123456789n]) {
    assert.equal(at(r), add(y0, mul(r, sub(y1, y0))));
  }
});

test('bit-count preset sums to the closed form v * 2^(v-1)', () => {
  for (let v = 1; v <= 8; v++) {
    const table = makePolynomial('popcount', v);
    assert.equal(naiveSum(table), BigInt(v * 2 ** (v - 1)));
  }
});

test('honest prover always verifies, for every preset and several v', () => {
  for (const preset of PRESETS) {
    for (const v of [1, 2, 3, 6, 9]) {
      for (let s = 0; s < 3; s++) {
        const table = makePolynomial(preset.id, v, makeRng(s * 31 + v));
        const run = runProtocol({ table, rng: makeRng(s * 7 + 1) });
        assert.equal(run.accepted, true, `${preset.id} v=${v} seed=${s}`);
        assert.equal(run.claimedSum, run.trueSum);
        assert.equal(run.rounds.length, v);
        assert.equal(verifyTranscript(run, table).ok, true);
        assert.equal(replayVerifier(run), true);
      }
    }
  }
});

test('s_1(0) + s_1(1) equals the claimed total', () => {
  for (const v of [2, 4, 7]) {
    const table = makePolynomial('random', v, makeRng(v));
    const run = runProtocol({ table, rng: makeRng(2) });
    const r1 = run.rounds[0];
    assert.equal(add(r1.s0, r1.s1), run.claimedSum);
    assert.equal(run.claimedSum, naiveSum(table));
  }
});

test('every round s_i(0) + s_i(1) equals the previous round challenge value', () => {
  const table = makePolynomial('random', 5, makeRng(4));
  const run = runProtocol({ table, rng: makeRng(8) });
  for (let i = 1; i < run.rounds.length; i++) {
    assert.equal(run.rounds[i].claim, run.rounds[i - 1].nextClaim);
    assert.equal(add(run.rounds[i].s0, run.rounds[i].s1), run.rounds[i].claim);
  }
  assert.equal(run.final.oracleValue, run.final.expected);
});

test('a prover lying about the total is rejected', () => {
  for (const v of [2, 4, 6]) {
    const table = makePolynomial('random', v, makeRng(v + 40));
    const run = runProtocol({ table, cheat: 'sum', delta: 1n, rng: makeRng(v) });
    assert.equal(run.claimedSum, add(run.trueSum, 1n));
    assert.equal(run.accepted, false, `v=${v}`);
    assert.equal(verifyTranscript(run, table).ok, false);
  }
});

test('a prover corrupting one round is rejected', () => {
  const v = 5;
  const table = makePolynomial('random', v, makeRng(77));
  for (let round = 1; round <= v; round++) {
    const run = runProtocol({ table, cheat: 'round', cheatRound: round, delta: 12345n, rng: makeRng(round) });
    assert.equal(run.accepted, false, `corrupted round ${round}`);
    // the corrupted round itself still passes: the lie preserves s(0)+s(1)
    assert.equal(run.rounds[round - 1].check.ok, true);
  }
});

test('a hand-corrupted transcript is rejected by an independent verifier', () => {
  const table = makePolynomial('random', 4, makeRng(21));
  const run = runProtocol({ table, rng: makeRng(3) });
  assert.equal(verifyTranscript(run, table).ok, true);
  run.rounds[2].s0 = add(run.rounds[2].s0, 1n);
  const result = verifyTranscript(run, table);
  assert.equal(result.ok, false);
  assert.equal(result.failedAt, 3);
});

test('the verifier does asymptotically less work than the prover', () => {
  const table = makePolynomial('random', 10, makeRng(6));
  const run = runProtocol({ table, rng: makeRng(6) });
  assert.ok(run.ops.verifier * 20 < run.ops.prover, `${run.ops.verifier} vs ${run.ops.prover}`);
  assert.ok(run.ops.verifier < 10 * run.v);
});

test('soundness experiment catches the cheat every time and beats the bound', () => {
  const result = soundnessExperiment({ v: 5, trials: 50, cheat: 'sum', seed: 9 });
  assert.equal(result.trials, 50);
  assert.equal(result.caught + result.escaped, 50);
  assert.equal(result.escaped, 0);
  assert.equal(result.rate, 1);
  assert.ok(result.bound < 1e-8);
});

test('benchmarkOne reports a consistent, accepted run', () => {
  const row = benchmarkOne(8, () => 0);
  assert.equal(row.size, 256);
  assert.equal(row.accepted, true);
  assert.equal(row.total, naiveSum(makePolynomial('random', 8, makeRng(12345))));
  assert.ok(row.proverOps > row.verifierOps);
});
