// app.js — all DOM wiring and canvas charts. Logic lives in paillier.js and
// election.js, neither of which touches the DOM.
import { generateKeypair, encrypt, decrypt, addCiphertexts } from "./paillier.js";
import { createBallot, BulletinBoard, tally, verifyTally } from "./election.js";

const $ = (id) => document.getElementById(id);

const OPTIONS = ["esbuild", "Vite", "plain Node scripts", "Webpack"];
const SIM_VOTER_NAMES = [
  "amara", "bjorn", "chinwe", "dagny", "elias", "fatou", "gustav", "hana",
  "idris", "joon", "kaia", "liam", "mira", "noor", "otis",
];
// Weighted so the tally has an interesting, uneven spread rather than a coin flip.
const SIM_VOTE_WEIGHTS = [5, 4, 1, 1, 2, 2, 0, 3, 1, 2, 4, 0, 3, 1, 2].map((_, i) => i % OPTIONS.length);
const SIM_PICKS = [1, 0, 1, 1, 2, 1, 3, 0, 1, 0, 1, 3, 0, 1, 2];

let publicKey, privateKey;
let board;
let lastAnnounced = null;

function fmtBig(n, headLen = 28, tailLen = 10) {
  const s = n.toString();
  if (s.length <= headLen + tailLen + 1) return s;
  return `${s.slice(0, headLen)}…${s.slice(-tailLen)} (${s.length} digits)`;
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString();
}

// ---------- identity demo ----------

const identityA = $("identity-a");
const identityB = $("identity-b");
const identityOutput = $("identity-output");

function runIdentityDemo() {
  const a = BigInt(Math.max(0, Math.min(999, Number(identityA.value) || 0)));
  const b = BigInt(Math.max(0, Math.min(999, Number(identityB.value) || 0)));
  const ca = encrypt(a, publicKey);
  const cb = encrypt(b, publicKey);
  const product = addCiphertexts(ca, cb, publicKey.n);
  const result = decrypt(product, privateKey);

  identityOutput.innerHTML = `
    <dl class="identity-grid" style="margin:0; display:contents;">
      <dt>enc(a)</dt><dd>${fmtBig(ca)}</dd>
      <dt>enc(b)</dt><dd>${fmtBig(cb)}</dd>
      <dt>enc(a) × enc(b) mod n²</dt><dd>${fmtBig(product)}</dd>
      <dt>decrypt(that)</dt><dd class="highlight">${result} — matches a + b = ${a + b}</dd>
    </dl>
  `;
}

$("identity-run-btn").addEventListener("click", runIdentityDemo);

// ---------- poll setup ----------

const optionSelect = $("option-select");
const voterAliasInput = $("voter-alias-input");
const castStatus = $("cast-status");
const boardTbody = $("board-tbody");
const boardHeaderRow = $("board-header-row");
const boardCount = $("board-count");
const attackerSelect = $("attacker-ballot-select");
const attackerView = $("attacker-view");

function populateOptionSelect() {
  optionSelect.innerHTML = OPTIONS.map((o, i) => `<option value="${i}">${o}</option>`).join("");
}

function renderBoardHeader() {
  boardHeaderRow.innerHTML =
    `<th>voter</th><th>cast</th>` +
    OPTIONS.map((o) => `<th class="num">${o}</th>`).join("");
}

function renderBoard() {
  const rows = board.list();
  boardCount.textContent = `${rows.length} ballots on the board`;

  boardTbody.innerHTML = "";
  for (const ballot of rows) {
    const tr = document.createElement("tr");
    tr.className = ballot._corrupted ? "row-corrupted" : "";
    const cells = ballot.ciphertexts
      .map(
        (c) =>
          `<td class="num"><span class="cipher-cell mono" data-full="${c.toString()}">${fmtBig(c, 14, 6)}</span></td>`
      )
      .join("");
    tr.innerHTML = `
      <td>${ballot.voter}</td>
      <td class="faint">${fmtTime(ballot.castAt)}</td>
      ${cells}
    `;
    tr.querySelectorAll(".cipher-cell").forEach((el) => {
      let expanded = false;
      el.addEventListener("click", () => {
        expanded = !expanded;
        el.textContent = expanded ? el.dataset.full : fmtBig(BigInt(el.dataset.full), 14, 6);
        el.classList.toggle("expanded", expanded);
      });
    });
    boardTbody.appendChild(tr);
  }

  attackerSelect.innerHTML = rows
    .map((b) => `<option value="${b.id}">${b.voter} — cast ${fmtTime(b.castAt)}</option>`)
    .join("");
  if (rows.length) renderAttackerView(rows[0].id);
}

function castAndAdd(voter, optionIndex) {
  const ballot = createBallot({ voter, optionIndex, options: OPTIONS, publicKey });
  board.cast(ballot);
  return ballot;
}

$("cast-vote-btn").addEventListener("click", () => {
  const alias = voterAliasInput.value.trim() || `guest-${Math.floor(Math.random() * 9999)}`;
  const optionIndex = Number(optionSelect.value);
  castAndAdd(alias, optionIndex);
  renderBoard();
  invalidateTally(`cast for "${OPTIONS[optionIndex]}" as ${alias}, encrypted in your browser — the board changed, so re-run the tally.`);
  castStatus.textContent = `cast for "${OPTIONS[optionIndex]}" as ${alias}, encrypted in your browser`;
  voterAliasInput.value = "";
});

// ---------- cheat panel ----------

function renderAttackerView(ballotId) {
  const ballot = board.get(ballotId);
  if (!ballot) {
    attackerView.textContent = "";
    return;
  }
  attackerView.textContent =
    `voter alias: ${ballot.voter} (metadata only, not the vote)\n` +
    `ciphertexts (one per option, in board order):\n\n` +
    ballot.ciphertexts.map((c, i) => `  [${OPTIONS[i]}] ${c.toString()}`).join("\n") +
    `\n\nNo bit here reveals which of these encrypts the 1. Without the private ` +
    `key, an attacker has ${ballot.ciphertexts.length} enormous integers and nothing else.`;
}

attackerSelect.addEventListener("change", () => renderAttackerView(attackerSelect.value));

const sameVoteOutput = $("same-vote-output");
$("same-vote-btn").addEventListener("click", () => {
  const c1 = encrypt(1n, publicKey);
  const c2 = encrypt(1n, publicKey);
  sameVoteOutput.innerHTML = `
    <div>encrypt(1) #1: <span class="different">${fmtBig(c1)}</span></div>
    <div>encrypt(1) #2: <span class="different">${fmtBig(c2)}</span></div>
    <div class="faint" style="margin-top:.3rem;">
      Same plaintext, ${c1 === c2 ? "identical" : "different"} ciphertexts —
      both still decrypt to 1. That difference comes entirely from the fresh
      random value drawn during each encryption.
    </div>
  `;
});

// ---------- tally ----------

const tallyAccumulator = $("tally-accumulator");
const tallyStatus = $("tally-status");
const tallyCanvas = $("tally-canvas");
const tallyRunBtn = $("tally-run-btn");
const verifyStatus = $("verify-status");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Any action that changes the board (a new vote, a corrupted ballot) makes
// the last announced tally stale. Clear both the displayed results and the
// chart so the screen never shows a tally the app no longer considers valid.
function invalidateTally(message) {
  if (lastAnnounced === null) return;
  lastAnnounced = null;
  tallyAccumulator.innerHTML = "";
  tallyStatus.textContent = message || "";
  tallyCanvas.style.display = "none";
}

function drawTallyChart(perOption) {
  tallyCanvas.style.display = "block";
  const ctx = tallyCanvas.getContext("2d");
  const w = tallyCanvas.width;
  const h = tallyCanvas.height;
  ctx.clearRect(0, 0, w, h);

  const styles = getComputedStyle(document.documentElement);
  const gridColor = styles.getPropertyValue("--border").trim() || "#262d38";
  const textColor = styles.getPropertyValue("--text-dim").trim() || "#9aa7b4";
  const accent = styles.getPropertyValue("--accent").trim() || "#4c8dff";
  const good = styles.getPropertyValue("--good").trim() || "#3fb950";

  const padL = 40;
  const padB = 40;
  const padT = 16;
  const padR = 16;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const max = Math.max(1, ...perOption) * 1.2;

  ctx.strokeStyle = gridColor;
  ctx.fillStyle = textColor;
  ctx.font = "11px ui-monospace, monospace";
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const y = padT + (plotH * i) / ySteps;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillText(Math.round(max * (1 - i / ySteps)).toString(), 6, y + 4);
  }

  const n = perOption.length;
  const barW = plotW / n - 16;
  perOption.forEach((count, i) => {
    const x = padL + (plotW / n) * i + 8;
    const barH = (count / max) * plotH;
    const y = padT + plotH - barH;
    ctx.fillStyle = i === perOption.indexOf(Math.max(...perOption)) ? good : accent;
    ctx.fillRect(x, y, barW, barH);
    ctx.fillStyle = textColor;
    ctx.textAlign = "center";
    ctx.fillText(count.toString(), x + barW / 2, y - 6);
    ctx.save();
    ctx.translate(x + barW / 2, h - padB + 14);
    const label = OPTIONS[i].length > 12 ? OPTIONS[i].slice(0, 11) + "…" : OPTIONS[i];
    ctx.fillText(label, 0, 0);
    ctx.restore();
  });
}

tallyRunBtn.addEventListener("click", async () => {
  tallyRunBtn.disabled = true;
  tallyStatus.textContent = "walking through every ballot…";
  tallyCanvas.style.display = "none";

  const rows = board.list();
  const n = publicKey.n;
  const numOptions = OPTIONS.length;
  const accs = new Array(numOptions).fill(0n).map(() => encrypt(0n, publicKey));

  tallyAccumulator.innerHTML = OPTIONS.map(
    (o, i) => `
      <div class="tally-option" id="tally-opt-${i}">
        <div class="label">${o}</div>
        <div class="acc-value" id="tally-acc-${i}">${fmtBig(accs[i])}</div>
        <div class="acc-progress" id="tally-progress-${i}">0 / ${rows.length} ballots folded in</div>
      </div>
    `
  ).join("");

  // Animate: fold in one ballot at a time, across all options, so the
  // accumulator visibly changes before the single decryption at the end.
  for (let step = 0; step < rows.length; step++) {
    const ballot = rows[step];
    for (let opt = 0; opt < numOptions; opt++) {
      accs[opt] = addCiphertexts(accs[opt], ballot.ciphertexts[opt], n);
      $(`tally-acc-${opt}`).textContent = fmtBig(accs[opt]);
      $(`tally-progress-${opt}`).textContent = `${step + 1} / ${rows.length} ballots folded in`;
    }
    await sleep(rows.length > 30 ? 15 : 60);
  }

  tallyStatus.textContent = "decrypting the final product per option (once each)…";
  await sleep(200);

  const perOption = accs.map((c) => Number(decrypt(c, privateKey)));
  perOption.forEach((count, i) => {
    $(`tally-opt-${i}`).classList.add("done");
    $(`tally-acc-${i}`).innerHTML = `<span class="result">${count} votes</span>`;
  });

  lastAnnounced = perOption;
  drawTallyChart(perOption);
  tallyStatus.textContent = `tallied ${rows.length} ballots, decrypted 4 numbers total (one per option) — never a single ballot.`;
  verifyStatus.textContent = "";
  tallyRunBtn.disabled = false;
});

// ---------- verify ----------

$("verify-run-btn").addEventListener("click", () => {
  if (!lastAnnounced) {
    verifyStatus.textContent = "run the tally first.";
    return;
  }
  const result = verifyTally(board, publicKey, privateKey, lastAnnounced);
  verifyStatus.textContent = result.ok
    ? "verified: recomputing the tally from the public board matches the announced result."
    : `verification FAILED: option(s) ${result.mismatchOptions.map((i) => OPTIONS[i]).join(", ")} do not match the announced total (recomputed: ${result.recomputed.join(", ")}).`;
  verifyStatus.className = result.ok ? "faint" : "faint tag bad";
});

$("corrupt-run-btn").addEventListener("click", () => {
  const rows = board.list();
  if (!rows.length) return;
  const victim = rows[Math.floor(Math.random() * rows.length)];
  board.corrupt(victim.id, publicKey, 0);
  renderBoard();
  invalidateTally();
  verifyStatus.textContent = `corrupted ${victim.voter}'s ballot — press "re-verify tally" to see it caught.`;
  verifyStatus.className = "faint";
});

// ---------- benchmark ----------

const BENCH_BITS = [256, 512, 1024];
const benchRunBtn = $("bench-run-btn");
const benchStatus = $("bench-status");
const benchCanvas = $("bench-canvas");
const benchTableBody = $("bench-table-body");

function drawBenchChart(results) {
  const ctx = benchCanvas.getContext("2d");
  const w = benchCanvas.width;
  const h = benchCanvas.height;
  ctx.clearRect(0, 0, w, h);

  const styles = getComputedStyle(document.documentElement);
  const gridColor = styles.getPropertyValue("--border").trim() || "#262d38";
  const textColor = styles.getPropertyValue("--text-dim").trim() || "#9aa7b4";
  const accent = styles.getPropertyValue("--accent").trim() || "#4c8dff";
  const alt = styles.getPropertyValue("--alt").trim() || "#bc8cff";
  const good = styles.getPropertyValue("--good").trim() || "#3fb950";
  const warn = styles.getPropertyValue("--warn").trim() || "#d29922";

  const padL = 50;
  const padB = 30;
  const padT = 16;
  const padR = 16;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const series = ["keygenMs", "encryptMs", "addMs", "decryptMs"];
  const colors = [warn, accent, good, alt];
  const maxVal = Math.max(...results.flatMap((r) => series.map((s) => r[s]))) * 1.15 || 1;

  ctx.strokeStyle = gridColor;
  ctx.fillStyle = textColor;
  ctx.font = "10px ui-monospace, monospace";
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const y = padT + (plotH * i) / ySteps;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillText((maxVal * (1 - i / ySteps)).toFixed(1), 4, y + 3);
  }

  const groupW = plotW / results.length;
  const barW = (groupW - 12) / series.length;

  results.forEach((r, gi) => {
    series.forEach((s, si) => {
      const val = r[s];
      const x = padL + groupW * gi + 6 + si * barW;
      const barH = (val / maxVal) * plotH;
      const y = padT + plotH - barH;
      ctx.fillStyle = colors[si];
      ctx.fillRect(x, y, barW - 2, Math.max(barH, 1));
    });
    ctx.fillStyle = textColor;
    ctx.textAlign = "center";
    ctx.fillText(`${r.bits}-bit`, padL + groupW * gi + groupW / 2, h - padB + 16);
  });

  // legend
  const legendY = h - 6;
  series.forEach((s, si) => {
    const x = padL + si * 90;
    ctx.fillStyle = colors[si];
    ctx.fillRect(x, legendY - 8, 8, 8);
    ctx.fillStyle = textColor;
    ctx.textAlign = "left";
    ctx.fillText(s.replace("Ms", ""), x + 12, legendY);
  });
}

benchRunBtn.addEventListener("click", async () => {
  benchRunBtn.disabled = true;
  benchTableBody.innerHTML = "";
  const results = [];

  for (const bits of BENCH_BITS) {
    benchStatus.textContent = `generating a ${bits}-bit keypair…`;
    await sleep(10); // let the status text paint before the blocking work

    const t0 = performance.now();
    const { publicKey: pk, privateKey: sk } = generateKeypair(bits);
    const t1 = performance.now();

    const m1 = BigInt(Math.floor(Math.random() * 1000));
    const m2 = BigInt(Math.floor(Math.random() * 1000));

    const t2 = performance.now();
    const c1 = encrypt(m1, pk);
    const t3 = performance.now();
    const c2 = encrypt(m2, pk);

    // Homomorphic addition is a single modular multiplication — fast enough
    // that one measurement is well under timer resolution. Repeat it until
    // the total span is meaningful, same approach as the other timings.
    let addReps = 0;
    let addTotal = 0;
    const t4 = performance.now();
    do {
      addCiphertexts(c1, c2, pk.n);
      addReps++;
      addTotal = performance.now() - t4;
    } while (addTotal < 20 && addReps < 100000);
    const csum = addCiphertexts(c1, c2, pk.n);
    const addMs = addTotal / addReps;

    const t6 = performance.now();
    decrypt(csum, sk);
    const t7 = performance.now();

    const row = {
      bits,
      keygenMs: t1 - t0,
      encryptMs: t3 - t2,
      addMs,
      decryptMs: t7 - t6,
    };
    results.push(row);

    // add is small enough that milliseconds hide it — show it in microseconds.
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${bits}</td><td class="num">${row.keygenMs.toFixed(1)} ms</td><td class="num">${row.encryptMs.toFixed(2)} ms</td><td class="num">${(row.addMs * 1000).toFixed(1)} \u00b5s${addReps > 1 ? ` (avg of ${addReps})` : ""}</td><td class="num">${row.decryptMs.toFixed(2)} ms</td>`;
    benchTableBody.appendChild(tr);
    drawBenchChart(results);
  }

  benchStatus.textContent = `measured just now in this browser across ${BENCH_BITS.length} modulus sizes`;
  benchRunBtn.disabled = false;
});

// ---------- init ----------

function seedBoard() {
  for (let i = 0; i < SIM_VOTER_NAMES.length; i++) {
    castAndAdd(SIM_VOTER_NAMES[i], SIM_PICKS[i % SIM_PICKS.length]);
  }
}

async function init() {
  populateOptionSelect();
  renderBoardHeader();
  castStatus.textContent = "generating the election's Paillier keypair…";

  await sleep(10); // paint the status before the blocking keygen
  const t0 = performance.now();
  ({ publicKey, privateKey } = generateKeypair(512));
  const t1 = performance.now();

  board = new BulletinBoard(OPTIONS);
  seedBoard();
  renderBoard();
  runIdentityDemo();

  castStatus.textContent = `keypair ready (512-bit modulus, generated in ${(t1 - t0).toFixed(0)} ms) — cast your vote below.`;
}

init();
