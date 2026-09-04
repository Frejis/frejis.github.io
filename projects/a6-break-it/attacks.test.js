import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expandKey,
  encryptBlock,
  decryptBlock,
  ecbEncrypt,
  ecbDecrypt,
  cbcEncryptRaw,
  cbcDecryptRaw,
  ctrEncrypt,
  ctrKeystream,
  xorBytes,
  pkcs7Pad,
  pkcs7Unpad,
  PaddingOracle,
  paddingOracleAttack,
  breakTwoTimePad,
  breakManyTimePad,
  dragCrib,
  rankCribOffsets,
  englishScore,
  sha256,
  shaPadding,
  naiveMac,
  naiveMacVerify,
  lengthExtend,
  hmacSha256,
  naiveCompare,
  constantTimeCompare,
  timedCompare,
  toHex,
  fromHex,
  textToBytes,
  bytesToText,
} from "./attacks.js";

// ---------------------------------------------------------------- AES-128

test("AES-128 matches the FIPS-197 appendix B test vector", () => {
  const key = fromHex("2b7e151628aed2a6abf7158809cf4f3c");
  const plain = fromHex("3243f6a8885a308d313198a2e0370734");
  const w = expandKey(key);
  assert.equal(toHex(encryptBlock(w, plain)), "3925841d02dc09fbdc118597196a0b32");
});

test("AES-128 matches the NIST SP 800-38A ECB vectors", () => {
  // F.1.1 ECB-AES128.Encrypt, all four blocks.
  const key = fromHex("2b7e151628aed2a6abf7158809cf4f3c");
  const plain = fromHex(
    "6bc1bee22e409f96e93d7e117393172a" +
    "ae2d8a571e03ac9c9eb76fac45af8e51" +
    "30c81c46a35ce411e5fbc1191a0a52ef" +
    "f69f2445df4f9b17ad2b417be66c3710"
  );
  const expected =
    "3ad77bb40d7a3660a89ecaf32466ef97" +
    "f5d3d58503b9699de785895a96fdbaaf" +
    "43b1cd7f598ece23881b00e3ed030688" +
    "7b0c785e27e8ad3f8223207104725dd4";
  assert.equal(toHex(ecbEncrypt(key, plain)), expected);
  assert.deepEqual(ecbDecrypt(key, fromHex(expected)), plain);
});

test("AES-128 matches the FIPS-197 key expansion vector", () => {
  // The final round key from appendix A.1.
  const w = expandKey(fromHex("2b7e151628aed2a6abf7158809cf4f3c"));
  assert.equal(toHex(w.subarray(160, 176)), "d014f9a8c9ee2589e13f0cc8b6630ca6");
});

test("AES-128 decryption inverts encryption on random blocks", () => {
  const key = crypto.getRandomValues(new Uint8Array(16));
  const w = expandKey(key);
  for (let i = 0; i < 20; i++) {
    const block = crypto.getRandomValues(new Uint8Array(16));
    assert.deepEqual(decryptBlock(w, encryptBlock(w, block)), block);
  }
});

test("AES-128 agrees with Node's WebCrypto AES-CBC on the same key", async () => {
  // An independent reference implementation, so the cipher above is not merely
  // self-consistent with its own test vectors.
  const rawKey = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const message = textToBytes("cross-checked against a reference implementation.");
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-CBC", false, ["encrypt"]);
  const ref = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, message));
  const ours = cbcEncryptRaw(rawKey, iv, pkcs7Pad(message));
  assert.deepEqual(ours, ref); // WebCrypto's AES-CBC also uses PKCS#7
});

// ---------------------------------------------------------------- modes

test("ECB leaks structure: identical plaintext blocks give identical ciphertext", () => {
  const key = fromHex("000102030405060708090a0b0c0d0e0f");
  const block = textToBytes("AAAAAAAAAAAAAAAA");
  const data = new Uint8Array(32);
  data.set(block);
  data.set(block, 16);
  const ct = ecbEncrypt(key, data);
  assert.deepEqual(ct.subarray(0, 16), ct.subarray(16, 32));

  // CBC over the same input does not repeat.
  const cbc = cbcEncryptRaw(key, new Uint8Array(16), data);
  assert.notDeepEqual(cbc.subarray(0, 16), cbc.subarray(16, 32));
});

test("CBC and CTR round-trip", () => {
  const key = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const data = crypto.getRandomValues(new Uint8Array(64));
  assert.deepEqual(cbcDecryptRaw(key, iv, cbcEncryptRaw(key, iv, data)), data);
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  assert.deepEqual(ctrEncrypt(key, nonce, ctrEncrypt(key, nonce, data)), data);
});

test("PKCS#7 pads, unpads, and rejects malformed padding", () => {
  const data = textToBytes("nine byte");
  const padded = pkcs7Pad(data);
  assert.equal(padded.length, 16);
  assert.equal(padded[15], 7);
  assert.deepEqual(Uint8Array.from(pkcs7Unpad(padded)), data);

  // A full block of padding is legal.
  const exact = pkcs7Pad(textToBytes("sixteen bytes!!!"));
  assert.equal(exact.length, 32);
  assert.equal(exact[31], 16);

  const bad = Uint8Array.from(padded);
  bad[14] = 9; // inconsistent pad bytes
  assert.equal(pkcs7Unpad(bad), null);
  assert.equal(pkcs7Unpad(new Uint8Array(15)), null); // not a whole block
  assert.equal(pkcs7Unpad(new Uint8Array(16)), null); // pad length 0
});

// ---------------------------------------------------------------- padding oracle

test("padding oracle attack recovers the plaintext exactly", () => {
  const key = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const secret = textToBytes("transfer 5000 EUR to account DK9520000012345678; auth=ok");
  const oracle = new PaddingOracle(key);
  const ct = oracle.seal(iv, secret);

  const { plaintext } = paddingOracleAttack(oracle, iv, ct);
  assert.deepEqual(plaintext, secret);
  // The attacker never touches the key, and asks far fewer than 2^128 questions.
  assert.ok(oracle.queries < 256 * 2 * ct.length, `used ${oracle.queries} queries`);
});

test("padding oracle attack survives a plaintext ending in padding-like bytes", () => {
  // The classic false positive: the last byte guess can produce 0x02 0x02
  // instead of 0x01. The attack must disambiguate rather than get it wrong.
  const key = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const secret = Uint8Array.from([...textToBytes("edge case"), 2, 2, 2, 2, 2, 2, 2]);
  const oracle = new PaddingOracle(key);
  const ct = oracle.seal(iv, secret);
  assert.deepEqual(paddingOracleAttack(oracle, iv, ct).plaintext, secret);
});

test("the oracle really only leaks one bit", () => {
  const oracle = new PaddingOracle(crypto.getRandomValues(new Uint8Array(16)));
  const result = oracle.isPaddingValid(new Uint8Array(16), new Uint8Array(16));
  assert.equal(typeof result, "boolean");
  assert.equal(oracle.queries, 1);
});

// ---------------------------------------------------------------- two-time pad

test("many-time pad: keystream reuse across several messages recovers all of them", () => {
  // The realistic form of the bug: a counter that resets, so the same keystream
  // covers a batch of messages. Every extra message is more evidence per
  // keystream byte, and the recovery becomes near-exact.
  const texts = [
    "the meeting is at the old station house at nine in the mornin",
    "bring the documents and do not tell anyone where we are going",
    "we will move the shipment on friday evening as planned agains",
    "the courier will wait by the harbour gate until after midnigh",
    "do not use this channel again after the transfer is completed",
    "the password for the account is written on the back of a card",
    "he said that the report was sent to the wrong address by mist",
    "please meet me at the station tomorrow and bring the document",
  ];
  const key = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(8)); // reused, every time
  const cts = texts.map((t) => ctrEncrypt(key, nonce, textToBytes(t)));

  const { messages } = breakManyTimePad(cts);
  let hits = 0;
  let total = 0;
  messages.forEach((got, i) => {
    const truth = textToBytes(texts[i]);
    for (let j = 0; j < got.length; j++) {
      total++;
      if (got[j] === truth[j]) hits++;
    }
  });
  // Measured over 8 random keys, this sits between 0.93 and 1.00; the floor is
  // set below the observed minimum because the search is randomised.
  assert.ok(hits / total > 0.9, `accuracy ${(hits / total).toFixed(3)}\n${messages.map(bytesToText).join("\n")}`);
});

test("many-time pad: more ciphertexts means a better recovery", () => {
  const texts = [
    "the meeting is at the old station house at nine in the mornin",
    "bring the documents and do not tell anyone where we are going",
    "we will move the shipment on friday evening as planned agains",
    "the courier will wait by the harbour gate until after midnigh",
    "do not use this channel again after the transfer is completed",
    "the password for the account is written on the back of a card",
    "he said that the report was sent to the wrong address by mist",
    "please meet me at the station tomorrow and bring the document",
  ];
  const key = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  const cts = texts.map((t) => ctrEncrypt(key, nonce, textToBytes(t)));
  const accuracyWith = (count) => {
    const { messages } = breakManyTimePad(cts.slice(0, count));
    let hits = 0;
    let total = 0;
    messages.forEach((got, i) => {
      const truth = textToBytes(texts[i]);
      for (let j = 0; j < got.length; j++) {
        total++;
        if (got[j] === truth[j]) hits++;
      }
    });
    return hits / total;
  };
  assert.ok(accuracyWith(8) > accuracyWith(3), "eight ciphertexts beat three");
});

test("two-time pad: a crib pins the keystream and orients both messages", () => {
  // Two messages is the hard case: there are only two characters of evidence
  // per keystream byte, and the objective cannot tell which message is which.
  // A crib settles the orientation, and the rest follows from the statistics.
  const t1 = "the meeting is at the old station house at nine in the morning";
  const t2 = "bring the documents and do not tell anyone where we are going";
  const m1 = textToBytes(t1);
  const m2 = textToBytes(t2);
  const key = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  const ct1 = ctrEncrypt(key, nonce, m1);
  const ct2 = ctrEncrypt(key, nonce, m2);

  const crib = textToBytes("the meeting is at");
  const known = new Array(Math.min(m1.length, m2.length)).fill(null);
  for (let i = 0; i < crib.length; i++) known[i] = ct1[i] ^ crib[i];

  const { m1: got1, m2: got2 } = breakTwoTimePad(ct1, ct2, { known });
  // Over the crib's span the recovery is exact in both messages - no statistics
  // involved, just XOR.
  assert.equal(bytesToText(got1.subarray(0, crib.length)), "the meeting is at");
  assert.equal(bytesToText(got2.subarray(0, crib.length)), t2.slice(0, crib.length));
  // Beyond it the model takes over and gets most, but not all, of the rest.
  let hits = 0;
  for (let i = 0; i < m1.length; i++) if (got1[i] === m1[i]) hits++;
  assert.ok(hits / m1.length > 0.5, `accuracy ${(hits / m1.length).toFixed(3)}: ${bytesToText(got1)}`);
});

test("two-time pad: the recovered pair is right even where the labelling is not", () => {
  const m1 = textToBytes("the meeting is at the old station house at nine in the morning");
  const m2 = textToBytes("bring the documents and do not tell anyone where we are going");
  const key = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  // The mistake: the same nonce, so the same keystream, twice.
  const ct1 = ctrEncrypt(key, nonce, m1);
  const ct2 = ctrEncrypt(key, nonce, m2);

  // With no crib the objective is symmetric in the two messages: swapping which
  // plaintext is "first" costs nothing, because the pair of characters produced
  // at each position is the same either way. So the labelling is not
  // determined - but the *pair* recovered at each position still is, and that
  // is what the attack genuinely delivers here.
  const { m1: got1, m2: got2 } = breakTwoTimePad(ct1, ct2, { beamWidth: 500 });
  let pairHits = 0;
  for (let i = 0; i < m1.length; i++) {
    const a = got1[i];
    const b = got2[i];
    if ((a === m1[i] && b === m2[i]) || (a === m2[i] && b === m1[i])) pairHits++;
  }
  assert.ok(
    pairHits / m1.length > 0.6,
    `pair accuracy ${(pairHits / m1.length).toFixed(3)}\n${bytesToText(got1)}\n${bytesToText(got2)}`
  );
});

test("two-time pad: a correct crib is fully sufficient over its span", () => {
  const m1 = textToBytes("attack at dawn from the north ridge");
  const m2 = textToBytes("the password for tonight is falcon9");
  const keystream = crypto.getRandomValues(new Uint8Array(m1.length));
  const xored = xorBytes(xorBytes(m1, keystream), xorBytes(m2, keystream));
  // Dragging the known fragment of m1 reveals the matching span of m2 exactly.
  const crib = textToBytes("attack at dawn");
  assert.equal(bytesToText(dragCrib(xored, crib, 0)), "the password f");
});

test("two-time pad: crib ranking puts the true offset first", () => {
  const m1 = textToBytes("we will move the shipment on friday evening as planned");
  const m2 = textToBytes("the courier will wait by the harbour gate until midnight");
  const keystream = crypto.getRandomValues(new Uint8Array(m1.length));
  const xored = xorBytes(xorBytes(m1, keystream), xorBytes(m2, keystream));
  const crib = " the shipment ";
  const trueOffset = bytesToText(m1).indexOf(crib);
  const ranked = rankCribOffsets(xored, textToBytes(crib), 3);
  assert.equal(ranked[0].offset, trueOffset);
  // At the true offset the crib reads straight out of the other message.
  assert.equal(
    bytesToText(dragCrib(xored, textToBytes(crib), trueOffset)),
    bytesToText(m2).slice(trueOffset, trueOffset + crib.length)
  );
});

test("english scoring prefers English to noise", () => {
  const english = textToBytes("the meeting is at nine in the morning");
  const noise = crypto.getRandomValues(new Uint8Array(english.length));
  assert.ok(englishScore(english) > englishScore(noise));
});

test("keystream reuse is the whole bug: different nonces defeat the attack", () => {
  const key = crypto.getRandomValues(new Uint8Array(16));
  const a = ctrKeystream(key, Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]), 32);
  const b = ctrKeystream(key, Uint8Array.from([2, 0, 0, 0, 0, 0, 0, 0]), 32);
  assert.notDeepEqual(a, b);
});

// ---------------------------------------------------------------- SHA-256

test("SHA-256 matches known digests including the empty string", () => {
  const cases = [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
     "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(toHex(sha256(textToBytes(input))), expected, `sha256(${JSON.stringify(input.slice(0, 20))})`);
  }
});

test("SHA-256 agrees with Node's WebCrypto on random inputs of every length class", async () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 200, 1000]) {
    const data = crypto.getRandomValues(new Uint8Array(len));
    const ref = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    assert.equal(toHex(sha256(data)), toHex(ref), `length ${len}`);
  }
});

test("the padding is a function of the length alone", () => {
  assert.equal(shaPadding(0).length, 64);
  assert.equal(shaPadding(55).length, 9);
  assert.equal(shaPadding(56).length, 72); // no room for the length word: a whole extra block
  assert.equal(toHex(shaPadding(3)).slice(0, 2), "80");
  assert.equal(toHex(shaPadding(3)).slice(-4), "0018"); // 3 bytes = 24 bits
});

// ---------------------------------------------------------------- length extension

test("length extension forges a MAC the naive verifier accepts", () => {
  const secret = crypto.getRandomValues(new Uint8Array(20));
  const message = textToBytes("user=guest&amount=10");
  const mac = naiveMac(secret, message);
  assert.ok(naiveMacVerify(secret, message, mac));

  // The attacker knows message and mac, and guesses the secret's length only.
  const suffix = textToBytes(";admin=true");
  const { forgedMessage, mac: forgedMac, glue } = lengthExtend(message, mac, secret.length, suffix);

  assert.ok(naiveMacVerify(secret, forgedMessage, forgedMac), "server accepted the forgery");
  // The forgery genuinely contains the attacker's suffix at the end.
  assert.equal(
    bytesToText(forgedMessage.subarray(forgedMessage.length - suffix.length)),
    ";admin=true"
  );
  // The glue padding sits between the two halves in plain sight: 0x80, zeroes,
  // then the original (secret || message) length in bits.
  assert.equal(glue[0], 0x80);
  assert.equal((secret.length + message.length + glue.length) % 64, 0);
});

test("length extension needs the right secret length", () => {
  const secret = crypto.getRandomValues(new Uint8Array(16));
  const message = textToBytes("amount=10");
  const mac = naiveMac(secret, message);
  const { forgedMessage, mac: forgedMac } = lengthExtend(message, mac, secret.length + 1, textToBytes(";admin=true"));
  assert.equal(naiveMacVerify(secret, forgedMessage, forgedMac), false);
});

test("HMAC is not extendable and matches Node's WebCrypto HMAC", async () => {
  const secret = crypto.getRandomValues(new Uint8Array(20));
  const message = textToBytes("user=guest&amount=10");
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const ref = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  assert.equal(toHex(hmacSha256(secret, message)), toHex(ref));

  // The same extension attempt against HMAC produces a tag nobody accepts.
  const tag = hmacSha256(secret, message);
  const { forgedMessage, mac: forgedMac } = lengthExtend(message, tag, secret.length, textToBytes(";admin=true"));
  assert.notEqual(toHex(hmacSha256(secret, forgedMessage)), toHex(forgedMac));
});

// ---------------------------------------------------------------- timing

test("constant-time compare returns the same booleans as the naive one", () => {
  const secret = textToBytes("s3cr3t-token-42");
  const cases = [
    ["s3cr3t-token-42", true],
    ["s3cr3t-token-43", false],
    ["X3cr3t-token-42", false],
    ["s3cr3t-token-4", false],
    ["s3cr3t-token-422", false],
    ["", false],
  ];
  for (const [guess, expected] of cases) {
    const g = textToBytes(guess);
    assert.equal(constantTimeCompare(secret, g), expected, `constant-time: ${guess}`);
    assert.equal(naiveCompare(secret, g), expected, `naive: ${guess}`);
  }
});

test("constant-time compare inspects every byte regardless of where they differ", () => {
  // Same length, differing at the first byte versus the last: the naive one
  // short-circuits, the constant-time one does not. Verified structurally via
  // the work counter timedCompare returns rather than by wall-clock timing,
  // which is not reproducible in a test runner.
  const secret = textToBytes("aaaaaaaaaaaaaaaa");
  const early = timedCompare(secret, textToBytes("Xaaaaaaaaaaaaaaa"), { work: 10 });
  const late = timedCompare(secret, textToBytes("aaaaaaaaaaaaaaaX"), { work: 10 });
  assert.equal(early.equal, false);
  assert.equal(late.equal, false);
  assert.ok(late.acc !== early.acc, "the naive comparison does a different amount of work");

  const ctEarly = timedCompare(secret, textToBytes("Xaaaaaaaaaaaaaaa"), { work: 10, constantTime: true });
  const ctLate = timedCompare(secret, textToBytes("aaaaaaaaaaaaaaaX"), { work: 10, constantTime: true });
  assert.equal(ctEarly.acc, ctLate.acc, "the constant-time comparison does identical work");
  assert.equal(ctEarly.equal, false);
  assert.equal(timedCompare(secret, secret, { work: 10, constantTime: true }).equal, true);
});
