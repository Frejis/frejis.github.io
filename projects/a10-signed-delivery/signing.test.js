import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSigner, signMessage, verifyMessage, tamperMessage, tamperSignatureHex } from './signing.js';

const MESSAGE = 'Transfer 500 EUR to account NL91ABNA0417164300.';

test('a valid signature verifies', async () => {
  const signer = await createSigner();
  const signatureHex = await signMessage(signer.keyPair.privateKey, MESSAGE);
  const valid = await verifyMessage(signer.publicKeyHex, MESSAGE, signatureHex);
  assert.equal(valid, true);
});

test('tampering with the message after signing breaks verification', async () => {
  const signer = await createSigner();
  const signatureHex = await signMessage(signer.keyPair.privateKey, MESSAGE);
  const tampered = tamperMessage(MESSAGE);
  assert.notEqual(tampered, MESSAGE);
  const valid = await verifyMessage(signer.publicKeyHex, tampered, signatureHex);
  assert.equal(valid, false);
});

test('tampering with the signature itself breaks verification', async () => {
  const signer = await createSigner();
  const signatureHex = await signMessage(signer.keyPair.privateKey, MESSAGE);
  const tamperedSig = tamperSignatureHex(signatureHex);
  assert.notEqual(tamperedSig, signatureHex);
  const valid = await verifyMessage(signer.publicKeyHex, MESSAGE, tamperedSig);
  assert.equal(valid, false);
});

test('verifying with the wrong public key fails', async () => {
  const signer = await createSigner();
  const otherSigner = await createSigner();
  const signatureHex = await signMessage(signer.keyPair.privateKey, MESSAGE);
  const valid = await verifyMessage(otherSigner.publicKeyHex, MESSAGE, signatureHex);
  assert.equal(valid, false);
});
