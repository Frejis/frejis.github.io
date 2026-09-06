import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDefaultSigner, buildDefaultChain, DEFAULT_MESSAGE } from './demo-data.js';
import { signMessage, verifyMessage } from './signing.js';

// app.js reads state.signer.keyPair.privateKey, state.signer.publicKeyHex and
// state.signer.otherPartyPublicKeyHex - this pins that exact shape so a signer
// built here can never drift from the one createSigner() produces.
test('buildDefaultSigner returns the shape app.js relies on', async () => {
  const signer = await buildDefaultSigner();
  assert.notEqual(signer.keyPair, undefined);
  assert.notEqual(signer.keyPair.privateKey, undefined);
  assert.notEqual(signer.publicKeyHex, undefined);
  assert.notEqual(signer.otherPartyPublicKeyHex, undefined);
  assert.notEqual(signer.publicKeyHex, signer.otherPartyPublicKeyHex);
});

test('buildDefaultSigner produces a signer that can actually sign and verify', async () => {
  const signer = await buildDefaultSigner();
  const signatureHex = await signMessage(signer.keyPair.privateKey, DEFAULT_MESSAGE);
  const valid = await verifyMessage(signer.publicKeyHex, DEFAULT_MESSAGE, signatureHex);
  assert.equal(valid, true);
});

test('buildDefaultChain returns the shape app.js relies on', async () => {
  const built = await buildDefaultChain();
  assert.equal(built.chain.length, 3);
  assert.notEqual(built.trustedRootKeyHexes, undefined);
  assert.notEqual(built.keys, undefined);
  assert.notEqual(built.keys.rootKeys.privateKey, undefined);
  assert.notEqual(built.keys.intermediateKeys, undefined);
  assert.notEqual(built.keys.leafKeys, undefined);
});
