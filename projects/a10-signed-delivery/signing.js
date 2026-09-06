// Part 1: sign a message, verify it, and the three ways to break that trust.
import {
  generateSigningKeyPair,
  exportPublicKeyHex,
  importPublicKeyHex,
  signBytes,
  verifyBytes,
  textToBytes,
  bytesToHex,
  hexToBytes,
} from './crypto-utils.js';

export async function createSigner() {
  const keyPair = await generateSigningKeyPair();
  const publicKeyHex = await exportPublicKeyHex(keyPair.publicKey);
  return { keyPair, publicKeyHex };
}

export async function signMessage(privateKey, message) {
  const sig = await signBytes(privateKey, textToBytes(message));
  return bytesToHex(sig);
}

// verifierPublicKeyHex lets the demo verify with "someone else's" key
// without keeping two live CryptoKey objects around in the UI state.
export async function verifyMessage(publicKeyHex, message, signatureHex) {
  const publicKey = await importPublicKeyHex(publicKeyHex);
  return verifyBytes(publicKey, textToBytes(message), hexToBytes(signatureHex));
}

// Flips the last character of the message to something else. Good enough
// to change the bytes that were signed without producing an empty string.
export function tamperMessage(message) {
  if (message.length === 0) return 'x';
  const chars = [...message];
  const last = chars.length - 1;
  const code = chars[last].codePointAt(0);
  chars[last] = String.fromCodePoint(code === 0x10ffff ? code - 1 : code + 1);
  return chars.join('');
}

export function tamperSignatureHex(signatureHex) {
  const bytes = hexToBytes(signatureHex);
  bytes[0] ^= 0xff;
  return bytesToHex(bytes);
}
