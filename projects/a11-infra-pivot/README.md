# Infrastructure Pivot

Five servers look unrelated until you notice they share a certificate and an SSH key - this demo lets you pivot on shared technical fingerprints to find the cluster hiding behind them.

**[▶ Open the live demo](./index.html)**

## What you are looking at

A synthetic set of 90 hosts, each with a certificate, an SSH host key, a TLS client fingerprint, a favicon hash, and a hosting provider. Pick a shared trait and the selection grows to every host that has it, and the graph redraws to show the new cluster taking shape. A running trail on the right records every pivot so you can step back through how you got there. The catch: not every shared trait means anything, and the demo makes you feel that difference rather than just stating it.

## Why this was hard

The honest part isn't drawing a graph, it's making "this trait is worthless" visible rather than asserted. Each artifact gets a selectivity score from how many of the 90 hosts actually carry it - a fingerprint on 4 hosts is strong evidence, a trait shared by most of the dataset is background noise everyone happens to share, most likely from a common library or cloud provider. That score drives both the colour-coded tags on every pivot option and the "pivot on a common trait" button, which deliberately floods the selection with unrelated hosts to make the point concrete. The clusters themselves also aren't uniform: some hosts share two artifacts, and every one of the 4 planted clusters has one host wired to share only a single trait with one other member, so a first pivot alone won't fully surface it - you have to pivot again to reach the bridge. Getting that chain right in a deterministic, seeded generator (rather than hand-authoring 90 rows) took more care than the force layout did.

## Run it

Open `index.html` directly in a browser - no server, no build step.

Tests: `node --test "*.test.js"` from this folder (or `node --test "projects/a11-infra-pivot/*.test.js"` from the repo root - the quoted glob matters, a bare directory path fails on Node's Windows test runner). The suite covers deterministic generation from a fixed seed, cluster reachability by pivoting including the single-artifact bridge hosts, selectivity scoring and ranking, the weak-pivot noise flood, and pivot-history rollback.

## What this is not

Every host, IP, certificate, and organisation name here is synthetic, generated locally from a fixed PRNG seed - none of it was observed, scraped, or looked up, and no real host, IP range, or organisation appears anywhere in the dataset. The page makes no network calls of any kind; everything is computed in the browser from data baked in at load time. Real OSINT/infrastructure-attribution work is done with platforms like Shodan, Censys, and VirusTotal, which index actual internet-wide scan data - this demo doesn't call any of them, and doesn't attempt to imitate their scanning, certificate-transparency ingestion, or correlation depth. It's a model of the *reasoning* (which artifacts corroborate a link and which don't), not a tool for doing the work.
