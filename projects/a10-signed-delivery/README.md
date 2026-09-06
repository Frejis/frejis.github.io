# Signed Delivery

What actually makes a digitally signed message trustworthy, and what does it take to break that trust.

**[▶ Open the live demo](./index.html)**

## What you are looking at

Part 1 signs a message with a real ECDSA key using the browser's own
WebCrypto, then lets you break the result three different ways: change the
message, change the signature, or check it against the wrong person's key.
Part 2 builds a small certificate chain - root CA, intermediate, end
certificate - and lets you attack any one link (a forged signature, an
expired certificate, an untrusted root) to see the chain fail exactly at
that link while the rest of it stays valid.

## Why this was hard

The interesting bit is not "the crypto works", it is showing *which* link
in a chain broke and why the others don't. `validateChain` in
`trust-chain.js` checks every link independently rather than stopping at
the first failure, so tampering with the intermediate certificate never
makes the leaf's own signature check say anything other than "fine, given
its issuer's key" - the leaf's signature genuinely doesn't depend on
whether the intermediate is expired. Getting the test suite to assert on
*which* link fails, not just that validation returned false, was the point
of the exercise. The certificate model itself is a plain object signed
over a fixed field order (`canonicalFields` in `trust-chain.js`) rather
than real X.509/DER, which sidesteps ASN.1 entirely and keeps the
signed bytes obvious to read in the source.

## Run it

Open `index.html` directly in a browser, no server or build step needed.

Tests: `node --test "*.test.js"` from this folder (or, from the repo root,
`node --test "projects/a10-signed-delivery/*.test.js"` - the quoted glob
matters, a bare directory path fails on Node's Windows test runner).

## What this is not

The certificates are plain JS objects, not X.509/ASN.1 - there is no
parsing of real DER-encoded certificates, no extensions, no revocation
(CRL/OCSP), and no certificate chaining rules beyond "does the signature
match and is it in date". Key pairs are generated fresh in memory on every
page load and never touch disk. This demonstrates the shape of the trust
problem, not a production PKI implementation.
