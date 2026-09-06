import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateChain, REASONS } from './trust-chain.js';
import { buildDefaultChain } from './demo-data.js';

test('an intact chain validates all the way to a trusted root', async () => {
  const { chain, trustedRootKeyHexes } = await buildDefaultChain();
  const result = await validateChain(chain, trustedRootKeyHexes);
  assert.equal(result.valid, true);
  assert.deepEqual(
    result.links.map((l) => l.reason),
    [REASONS.OK, REASONS.OK, REASONS.OK],
  );
});

test('breaking the root signature fails exactly at the root link', async () => {
  const { chain, trustedRootKeyHexes } = await buildDefaultChain();
  const brokenChain = chain.map((c) => ({ ...c }));
  brokenChain[0].signatureHex = brokenChain[0].signatureHex.slice(0, -2) + (brokenChain[0].signatureHex.slice(-2) === '00' ? '01' : '00');

  const result = await validateChain(brokenChain, trustedRootKeyHexes);
  assert.equal(result.valid, false);
  assert.equal(result.links[0].reason, REASONS.BAD_SIGNATURE);
  assert.equal(result.links[1].reason, REASONS.OK);
  assert.equal(result.links[2].reason, REASONS.OK);
});

test('an expired intermediate certificate fails exactly at that link', async () => {
  const { chain, trustedRootKeyHexes, keys } = await buildDefaultChain();
  const { issueCertificate } = await import('./trust-chain.js');
  const expiredIntermediate = await issueCertificate({
    subject: chain[1].subject,
    issuer: chain[1].issuer,
    notBefore: '2000-01-01T00:00:00.000Z',
    notAfter: '2000-06-01T00:00:00.000Z', // signature is mathematically valid, just expired
    publicKeyHex: chain[1].publicKeyHex,
    signerPrivateKey: keys.rootKeys.privateKey,
  });
  const brokenChain = [chain[0], expiredIntermediate, chain[2]];

  const result = await validateChain(brokenChain, trustedRootKeyHexes);
  assert.equal(result.valid, false);
  assert.equal(result.links[0].reason, REASONS.OK);
  assert.equal(result.links[1].reason, REASONS.EXPIRED);
  // the leaf's own signature only depends on the intermediate's public key,
  // which did not change, so this link on its own is still fine
  assert.equal(result.links[2].reason, REASONS.OK);
});

test('removing the root from the trusted list fails exactly at the root link', async () => {
  const { chain } = await buildDefaultChain();
  const result = await validateChain(chain, []);
  assert.equal(result.valid, false);
  assert.equal(result.links[0].reason, REASONS.UNTRUSTED_ROOT);
  assert.equal(result.links[1].reason, REASONS.OK);
  assert.equal(result.links[2].reason, REASONS.OK);
});

test('a certificate with a mathematically correct signature is still rejected once expired', async () => {
  const { chain, trustedRootKeyHexes, keys } = await buildDefaultChain();
  const { issueCertificate } = await import('./trust-chain.js');
  const expiredLeaf = await issueCertificate({
    subject: chain[2].subject,
    issuer: chain[2].issuer,
    notBefore: '2000-01-01T00:00:00.000Z',
    notAfter: '2000-06-01T00:00:00.000Z',
    publicKeyHex: chain[2].publicKeyHex,
    signerPrivateKey: keys.intermediateKeys.privateKey,
  });
  const brokenChain = [chain[0], chain[1], expiredLeaf];

  const result = await validateChain(brokenChain, trustedRootKeyHexes);
  assert.equal(result.links[2].valid, false);
  assert.equal(result.links[2].reason, REASONS.EXPIRED);
});
