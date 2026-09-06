// Thin wrappers around WebCrypto ECDSA (P-256) plus hex <-> bytes helpers.
// No DOM access here: this file is imported by both the browser page and
// the Node test runner.

export function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

export function textToBytes(text) {
  return new TextEncoder().encode(text);
}

export async function generateSigningKeyPair() {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
}

export async function exportPublicKeyHex(publicKey) {
  const raw = await crypto.subtle.exportKey('raw', publicKey);
  return bytesToHex(new Uint8Array(raw));
}

export async function importPublicKeyHex(hex) {
  const raw = hexToBytes(hex);
  return crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
}

export async function signBytes(privateKey, bytes) {
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, bytes);
  return new Uint8Array(sig);
}

export async function verifyBytes(publicKey, bytes, signature) {
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, bytes);
}
