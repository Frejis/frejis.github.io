// Builds the default state shown on page load: a signer for part 1 and a
// valid three-link certificate chain for part 2. Kept separate from app.js
// so app.js stays pure DOM wiring.
import { generateSigningKeyPair, exportPublicKeyHex } from './crypto-utils.js';
import { issueCertificate } from './trust-chain.js';
import { createSigner } from './signing.js';

export const DEFAULT_MESSAGE = 'Transfer 500 EUR to account NL91ABNA0417164300.';

export async function buildDefaultSigner() {
  const alice = await createSigner();
  const mallory = await generateSigningKeyPair(); // "someone else", for the wrong-key attack
  const malloryPublicKeyHex = await exportPublicKeyHex(mallory.publicKey);
  return {
    ...alice,
    otherPartyPublicKeyHex: malloryPublicKeyHex,
  };
}

function isoDaysFromNow(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export async function buildDefaultChain() {
  const rootKeys = await generateSigningKeyPair();
  const intermediateKeys = await generateSigningKeyPair();
  const leafKeys = await generateSigningKeyPair();

  const rootPublicKeyHex = await exportPublicKeyHex(rootKeys.publicKey);
  const intermediatePublicKeyHex = await exportPublicKeyHex(intermediateKeys.publicKey);
  const leafPublicKeyHex = await exportPublicKeyHex(leafKeys.publicKey);

  const root = await issueCertificate({
    subject: 'Portfolio Root CA',
    issuer: 'Portfolio Root CA',
    notBefore: isoDaysFromNow(-3650),
    notAfter: isoDaysFromNow(3650),
    publicKeyHex: rootPublicKeyHex,
    signerPrivateKey: rootKeys.privateKey, // self-signed
  });

  const intermediate = await issueCertificate({
    subject: 'Portfolio Intermediate CA',
    issuer: 'Portfolio Root CA',
    notBefore: isoDaysFromNow(-365),
    notAfter: isoDaysFromNow(1825),
    publicKeyHex: intermediatePublicKeyHex,
    signerPrivateKey: rootKeys.privateKey,
  });

  const leaf = await issueCertificate({
    subject: 'delivery.example.com',
    issuer: 'Portfolio Intermediate CA',
    notBefore: isoDaysFromNow(-30),
    notAfter: isoDaysFromNow(60),
    publicKeyHex: leafPublicKeyHex,
    signerPrivateKey: intermediateKeys.privateKey,
  });

  return {
    chain: [root, intermediate, leaf],
    trustedRootKeyHexes: [rootPublicKeyHex],
    // kept around so the "expire a cert" control can re-sign a tampered date
    // and the demo can still show a byte-for-byte real signature mismatch too
    keys: { rootKeys, intermediateKeys, leafKeys },
  };
}
