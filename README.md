# Carl-Emil Heiselberg Andersen

**Live site: [frejis.github.io](https://frejis.github.io/)**

Ten things from cryptography and programming languages that are usually explained
with equations, built instead as pages you can click: encrypt a note the server
cannot read, watch a type checker infer types as you type, break five real
cryptographic mistakes, spend a privacy budget until it runs out.

I have an M.Sc. in Computer Science from Aarhus University, specialised in
cryptography and programming languages. My master's thesis implemented and
benchmarked the GKR protocol, and I spent four semesters as a teaching assistant,
including Computer Architecture and Cryptology. I am based in Aarhus, currently
looking for work, and I work in Danish and English.

## The demos

Start with [Break It Yourself](projects/a6-break-it/) if you want to see something
go wrong in ten seconds, or [Sumcheck Visualizer](projects/a2-sumcheck/) if you
want the thesis work.

| Project | What it does |
|---|---|
| [Sealed Note](projects/a1-sealed-note/) | End-to-end encrypted note sharing with AES-GCM via WebCrypto. The key lives in the URL fragment, so it never reaches the server; the stored rows are shown on screen as unreadable ciphertext, and a tamper button flips one byte to watch AEAD authentication reject it. |
| [Sumcheck Visualizer](projects/a2-sumcheck/) | The sumcheck protocol, the core of my GKR thesis, stepped through round by round with live prover-vs-verifier work counters. An experiment runs 200 cheating provers so you can see soundness hold empirically. |
| [Type Playground](projects/a3-type-playground/) | A small ML-like language: tokenizer, parser, Hindley-Milner type inference (Algorithm W with unification, occurs check and let-polymorphism) and an interpreter. Red squiggles as you type, an inferred type per binding, and the unification trace laid out step by step. |
| [Shrink Lab](projects/a4-shrink-lab/) | A miniature QuickCheck written from scratch, seeded and reproducible. Shrinking is visualised, so you watch a large random counterexample collapse to the minimal failing input. |
| [Secret Ballot](projects/a5-secret-ballot/) | Paillier homomorphic encryption tallying an election without decrypting a single ballot, with a public bulletin board of ciphertexts and a corrupt-then-verify demonstration. |
| [Break It Yourself](projects/a6-break-it/) | Five real cryptographic attacks that actually run in the page: the ECB penguin, keystream reuse from a repeated nonce, a padding oracle, SHA-256 length extension, and a timing side channel. |
| [Taint Analyzer](projects/a7-taint-analyzer/) | A static analyzer: control-flow graph construction plus a monotone worklist dataflow analysis that finds injection bugs. The fixed-point iteration is animated, and the witness path from source to sink is highlighted. |
| [Privacy Budget](projects/a8-privacy-budget/) | A differential privacy dashboard where the budget visibly drains as you query, and a differencing attack that succeeds with privacy off and fails with it on. |
| [Signed Delivery](projects/a10-signed-delivery/) | ECDSA P-256 signing via WebCrypto plus a certificate chain from root CA through an intermediate to an end certificate. Six ways to break the trust - altered message, altered signature, wrong key, forged root signature, expired certificate, untrusted root - each failing at one identifiable link while the others still verify. |
| [Infrastructure Pivot](projects/a11-infra-pivot/) | Mapping related internet infrastructure by pivoting on shared artifacts: TLS certificate fingerprints, JA3 fingerprints, SSH host keys, favicon hashes. A seeded synthetic set of 90 hosts with four planted clusters and background noise, where every artifact carries a computed selectivity so strong evidence is distinguishable from a trait half the dataset shares. |

Each project has its own README, including a "What this is not" section that states
its limitations plainly. The writeups behind the demos live in the
[blog hub](projects/a9-blog/).

## Running it locally

```
git clone https://github.com/Frejis/frejis.github.io
```

Open `index.html` in a browser, or serve the folder with any static server. There
is nothing to install and nothing to build; opening a project's `index.html`
straight from disk works too.

Tests use Node's built-in runner, one project at a time, from the repository root:

```
node --test "projects/a1-sealed-note/*.test.js"
```

Any other project slug works the same way. The quotes matter: the bare-directory
form `node --test projects/<slug>` fails with `MODULE_NOT_FOUND` on Node 24 on
Windows, so the quoted glob is what the READMEs use throughout. 172 tests pass
across the ten projects.

## How this is built

Plain HTML, CSS and ES modules. No npm install, no bundler, no framework, no CDN,
no dependencies at all.

That was a deliberate constraint rather than a shortcut. A demo with a build step
is a demo that stops working the first time a toolchain moves, and these should
still run years from now from a bare clone. It also means the source is the
artefact: you can open any file next to the page it draws and read exactly what is
happening, without installing anything to find out. The same rule applies to the
numbers on screen, which are measured live in the browser with `performance.now()`
rather than hardcoded, so every figure is what your machine did just now.
