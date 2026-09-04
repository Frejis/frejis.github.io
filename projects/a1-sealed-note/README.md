# Sealed Note

A note-sharing tool where the server storing your note is mathematically
incapable of reading it.

**[▶ Open the live demo](./index.html)**

## What you are looking at

Type a secret on the left, click "Encrypt and upload", and watch the row
land in "What the server stores" on the right — ciphertext, an IV, a
timestamp, nothing else. The decryption key travels only inside the share
link's URL fragment, which browsers never transmit. Open that link back on
this page and it decrypts client-side. Tamper with a stored row and try to
open it: decryption refuses outright rather than handing back corrupted
plaintext.

## Why this was hard

The interesting property here is not "encrypt some text" — it's making the
*trust boundary* visible. Two decisions carry the design:

- **Key placement.** The key rides in the URL fragment (`#k=...`), not the
  query string. Fragments are resolved entirely client-side and are stripped
  before the browser builds the HTTP request, so the "server" component —
  even the real one this was scoped as — structurally never sees the key,
  not "isn't given" it.
- **AEAD over plain encryption.** AES-GCM authenticates as well as encrypts.
  The tamper button exists because most people have only ever seen
  encryption fail silently (garbage plaintext). GCM instead throws — the
  ciphertext, its length, and its integrity tag are checked together, so a
  single flipped bit anywhere makes decryption reject the whole message.
  That distinction (confidentiality vs. confidentiality *and* integrity) is
  the actual cryptographic content of this demo.

Everything else — base64url framing so a binary key survives inside a URL,
burn-after-reading as a one-shot `get()`, the throughput chart — is
plumbing around those two decisions.

## Run it

Open `index.html` directly (double-click, or serve the repo root with any
static file server — no build step, no dependencies). Sensible defaults are
preloaded: a sample secret, a pre-seeded server row, and the recipient view
opens automatically if you load the page via a share link.

Tests, from the repository root:

```
node --test "projects/a1-sealed-note/*.test.js"
```

(pure logic only — key/export/import, encrypt/decrypt, share-link
round-trip, tamper detection, burn-after-reading, and a check that the
stored record never contains a fragment of the plaintext.)

## What this is not

- **The server is a simulation.** `FakeServer` in `sealed.js` is an
  in-memory `Map`, optionally mirrored to `localStorage` so it survives a
  reload — there is no network call, no real database, no Azure deployment.
  This was originally scoped as a C#/.NET backend on Azure; doing it
  client-side instead means the demo never rots and, more importantly, lets
  this page show you the exact database contents live, which a real backend
  demo could not do without also shipping an admin panel.
- **No rate limiting, no auth, no TLS story.** A real service needs all
  three; none of them are cryptographically interesting, so none are
  simulated here.
- **The key in the URL is a genuine trade-off, not a solved problem.** It
  never touches a server, but it does land in the recipient's browser
  history, any URL-logging browser extension, and the referrer of whatever
  page they paste it into. A production version would want a
  one-time-view enforcement server-side (this demo's burn-after-reading is
  the shape of that, minus the "can't be replayed" guarantee a real network
  round-trip would give you) and a warning against pasting the link
  somewhere that logs it.
- **No key rotation, no forward secrecy, no multi-recipient support.** One
  key, one note, one AES-GCM call. Deliberately as small as the interesting
  idea allows.
