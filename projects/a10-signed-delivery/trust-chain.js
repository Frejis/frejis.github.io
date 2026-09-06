// Part 2: a minimal certificate chain (root CA -> intermediate -> leaf).
//
// This is deliberately NOT X.509/ASN.1. A "certificate" here is a plain
// JS object with the fields that matter for the trust story, signed with
// a real ECDSA key over its own canonical JSON. See README for why.
import { signBytes, verifyBytes, textToBytes, bytesToHex, hexToBytes } from './crypto-utils.js';

// Fields that get signed, in a fixed order, so signer and verifier
// canonicalize identically.
function canonicalFields(cert) {
  return {
    subject: cert.subject,
    issuer: cert.issuer,
    notBefore: cert.notBefore,
    notAfter: cert.notAfter,
    publicKeyHex: cert.publicKeyHex,
  };
}

export function canonicalBytes(cert) {
  return textToBytes(JSON.stringify(canonicalFields(cert)));
}

export async function issueCertificate({ subject, issuer, notBefore, notAfter, publicKeyHex, signerPrivateKey }) {
  const unsigned = { subject, issuer, notBefore, notAfter, publicKeyHex };
  const signature = await signBytes(signerPrivateKey, canonicalBytes(unsigned));
  return { ...unsigned, signatureHex: bytesToHex(signature) };
}

// Every link check returns one of these reasons alongside pass/fail, so
// the UI can point at exactly what broke instead of a blanket "invalid".
export const REASONS = {
  OK: 'ok',
  BAD_SIGNATURE: 'signature-invalid',
  EXPIRED: 'expired',
  UNTRUSTED_ROOT: 'untrusted-root',
};

async function checkSignature(cert, issuerPublicKeyHex) {
  const issuerPublicKey = await crypto.subtle.importKey(
    'raw',
    hexToBytes(issuerPublicKeyHex),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
  return verifyBytes(issuerPublicKey, canonicalBytes(cert), hexToBytes(cert.signatureHex));
}

function isExpired(cert, atDate) {
  const now = atDate.getTime();
  return now < new Date(cert.notBefore).getTime() || now > new Date(cert.notAfter).getTime();
}

// Validates a chain [root, intermediate, ..., leaf]. Each link is checked
// independently (a broken link does not stop the others from being
// evaluated) so the UI can show "the rest of the chain is still fine".
export async function validateChain(chain, trustedRootKeyHexes, now = new Date()) {
  const results = [];

  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i];
    const issuerPublicKeyHex = i === 0 ? cert.publicKeyHex : chain[i - 1].publicKeyHex;
    const signatureOk = await checkSignature(cert, issuerPublicKeyHex);
    const expired = isExpired(cert, now);
    const trusted = i !== 0 || trustedRootKeyHexes.includes(cert.publicKeyHex);

    let reason = REASONS.OK;
    if (!signatureOk) reason = REASONS.BAD_SIGNATURE;
    else if (expired) reason = REASONS.EXPIRED;
    else if (!trusted) reason = REASONS.UNTRUSTED_ROOT;

    results.push({
      index: i,
      subject: cert.subject,
      issuer: cert.issuer,
      valid: reason === REASONS.OK,
      reason,
    });
  }

  return {
    valid: results.every((r) => r.valid),
    links: results,
  };
}
