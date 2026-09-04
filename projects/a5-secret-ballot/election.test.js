import { test } from "node:test";
import assert from "node:assert/strict";
import {
  modInverse,
  modPow,
  gcd,
  lcm,
  isProbablePrime,
  generateKeypair,
  encrypt,
  decrypt,
  addCiphertexts,
  multiplyByScalar,
  randomBigIntRange,
} from "./paillier.js";
import { createBallot, BulletinBoard, tally, verifyTally } from "./election.js";

// Small modulus for fast tests. The demo page defaults to 512; correctness
// does not depend on size, only speed does.
const TEST_BITS = 128;

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

// ---------- number theory primitives ----------

test("modInverse: a * modInverse(a, m) == 1 mod m", () => {
  const cases = [
    [3n, 11n],
    [7n, 97n],
    [123456789n, 1000000007n],
  ];
  for (const [a, m] of cases) {
    const inv = modInverse(a, m);
    assert.equal((a * inv) % m, 1n);
  }
});

test("modInverse throws when no inverse exists", () => {
  assert.throws(() => modInverse(4n, 8n));
});

test("modPow matches naive exponentiation for small values", () => {
  for (let i = 0; i < 20; i++) {
    const base = BigInt(randomInt(50) + 2);
    const exp = BigInt(randomInt(20));
    const mod = BigInt(randomInt(97) + 3);
    let naive = 1n;
    for (let j = 0n; j < exp; j++) naive = (naive * base) % mod;
    assert.equal(modPow(base, exp, mod), naive);
  }
});

test("gcd and lcm are consistent: gcd(a,b)*lcm(a,b) == a*b", () => {
  const pairs = [
    [12n, 18n],
    [17n, 5n],
    [1000000n, 3n],
  ];
  for (const [a, b] of pairs) {
    assert.equal(gcd(a, b) * lcm(a, b), a * b);
  }
});

test("Miller-Rabin accepts known primes", () => {
  const primes = [2n, 3n, 5n, 7n, 97n, 7919n, 104729n, 1000000007n, 32416190071n];
  for (const p of primes) assert.equal(isProbablePrime(p), true, `${p} should be prime`);
});

test("Miller-Rabin rejects known composites", () => {
  const composites = [4n, 9n, 15n, 100n, 561n /* Carmichael */, 1000000006n, 41041n /* Carmichael */];
  for (const c of composites) assert.equal(isProbablePrime(c), false, `${c} should be composite`);
});

test("randomBigIntRange is approximately uniform over a non-power-of-two range (statistical)", () => {
  // [0, 2] has 3 outcomes but needs 2 bits to represent, so a naive
  // `randomBigIntBits(bits) % range` is biased toward small values
  // (0 and 1 each get two of the four 2-bit draws mapped onto them, 2 gets
  // one). Rejection sampling should instead give each of 0/1/2 ~1/3 of the
  // draws. Statistical test with a generous tolerance to avoid flakiness.
  const draws = 60000;
  const counts = [0, 0, 0];
  for (let i = 0; i < draws; i++) {
    const n = randomBigIntRange(0n, 2n);
    counts[Number(n)]++;
  }
  const expected = draws / 3;
  for (const count of counts) {
    assert.ok(
      Math.abs(count - expected) < expected * 0.2,
      `bucket count ${count} too far from expected ${expected} (counts: ${counts})`
    );
  }
});

// ---------- Paillier round-trip ----------

test("encrypt/decrypt round-trips many random plaintexts", () => {
  const { publicKey, privateKey } = generateKeypair(TEST_BITS);
  for (let i = 0; i < 25; i++) {
    const m = BigInt(randomInt(1000));
    const c = encrypt(m, publicKey);
    assert.equal(decrypt(c, privateKey), m);
  }
});

test("encrypting the same plaintext twice gives different ciphertexts (semantic security)", () => {
  const { publicKey } = generateKeypair(TEST_BITS);
  const c1 = encrypt(7n, publicKey);
  const c2 = encrypt(7n, publicKey);
  assert.notEqual(c1, c2);
});

// ---------- homomorphic addition ----------

test("decrypt(add(enc(a), enc(b))) == a + b, across many random pairs", () => {
  const { publicKey, privateKey } = generateKeypair(TEST_BITS);
  for (let i = 0; i < 25; i++) {
    const a = BigInt(randomInt(500));
    const b = BigInt(randomInt(500));
    const ca = encrypt(a, publicKey);
    const cb = encrypt(b, publicKey);
    const csum = addCiphertexts(ca, cb, publicKey.n);
    assert.equal(decrypt(csum, privateKey), a + b);
  }
});

test("multiplyByScalar scales the plaintext", () => {
  const { publicKey, privateKey } = generateKeypair(TEST_BITS);
  const m = 9n;
  const k = 5n;
  const c = encrypt(m, publicKey);
  const scaled = multiplyByScalar(c, k, publicKey.n);
  assert.equal(decrypt(scaled, privateKey), m * k);
});

// ---------- election-level behaviour ----------

function makeElection(bits = TEST_BITS) {
  const { publicKey, privateKey } = generateKeypair(bits);
  const options = ["Red", "Green", "Blue"];
  const board = new BulletinBoard(options);
  return { publicKey, privateKey, options, board };
}

test("a full election tallies to the correct per-option counts", () => {
  const { publicKey, privateKey, options, board } = makeElection();
  // 3 votes for Red, 1 for Green, 2 for Blue
  const picks = [0, 0, 0, 1, 2, 2];
  for (const optionIndex of picks) {
    board.cast(createBallot({ voter: `voter-${optionIndex}-${Math.random()}`, optionIndex, options, publicKey }));
  }

  const { perOption } = tally(board, publicKey, privateKey);
  assert.deepEqual(perOption, [3, 1, 2]);
});

test("verifyTally succeeds against an honestly announced result", () => {
  const { publicKey, privateKey, options, board } = makeElection();
  for (const optionIndex of [0, 1, 1, 2]) {
    board.cast(createBallot({ voter: "v", optionIndex, options, publicKey }));
  }
  const { perOption } = tally(board, publicKey, privateKey);
  const result = verifyTally(board, publicKey, privateKey, perOption);
  assert.equal(result.ok, true);
  assert.deepEqual(result.mismatchOptions, []);
});

test("a corrupted ballot makes verification fail", () => {
  const { publicKey, privateKey, options, board } = makeElection();
  for (const optionIndex of [0, 1, 1, 2]) {
    board.cast(createBallot({ voter: "v", optionIndex, options, publicKey }));
  }
  const { perOption: announced } = tally(board, publicKey, privateKey);

  const firstBallotId = board.list()[0].id;
  board.corrupt(firstBallotId, publicKey, 0);

  const result = verifyTally(board, publicKey, privateKey, announced);
  assert.equal(result.ok, false);
  assert.ok(result.mismatchOptions.length > 0);
});

test("accumulator steps recorded during tally end at the final decrypted total", () => {
  const { publicKey, privateKey, options, board } = makeElection();
  for (const optionIndex of [0, 0, 1]) {
    board.cast(createBallot({ voter: "v", optionIndex, options, publicKey }));
  }
  const { accumulatorSteps, finalCiphertexts } = tally(board, publicKey, privateKey);
  for (let opt = 0; opt < options.length; opt++) {
    const steps = accumulatorSteps[opt];
    assert.equal(steps[steps.length - 1], finalCiphertexts[opt]);
  }
});
