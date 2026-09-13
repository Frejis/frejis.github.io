// app.js — all DOM wiring. Logic lives in sealed.js and has no DOM references.
import {
  generateKey,
  exportKeyRaw,
  importKeyRaw,
  encryptText,
  decryptText,
  buildShareLink,
  parseShareLink,
  FakeServer,
} from "./sealed.js";

const server = new FakeServer("sealed-note-fake-server");

const $ = (id) => document.getElementById(id);

const plaintextInput = $("plaintext-input");
const burnCheckbox = $("burn-checkbox");
const encryptBtn = $("encrypt-btn");
const genKeyOut = $("gen-key-out");
const genIvOut = $("gen-iv-out");
const shareLinkOut = $("share-link-out");
const copyLinkBtn = $("copy-link-btn");
const uploadResult = $("upload-result");
const encryptNote = $("encrypt-note");

const serverRows = $("server-rows");
const serverStats = $("server-stats");
const clearServerBtn = $("clear-server-btn");

const recipientLinkInput = $("recipient-link-input");
const openLinkBtn = $("open-link-btn");
const decryptResult = $("decrypt-result");
const decryptNote = $("decrypt-note");

const runBenchmarkBtn = $("run-benchmark-btn");
const benchCanvas = $("bench-canvas");
const benchTableBody = $("bench-table-body");
const benchStatus = $("bench-status");
const benchNote = $("bench-note");

const SAMPLE_SECRET =
  "AWS_SECRET_ACCESS_KEY = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n" +
  "Rotate this before the demo goes near a real account. Only Bob should read this note.";

function baseUrl() {
  const u = new URL(location.href);
  u.hash = "";
  u.search = "";
  return u.toString();
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString();
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + "…" : str;
}

// ---------- server panel ----------

function renderServer() {
  const rows = server.list();
  serverStats.innerHTML = `
    <div class="stat"><span class="value">${rows.length}</span><span class="label">stored rows</span></div>
    <div class="stat"><span class="value">${rows.filter((r) => r.burn).length}</span><span class="label">burn-after-reading</span></div>
  `;

  if (rows.length === 0) {
    serverRows.innerHTML = `<p class="empty-hint">No rows. Encrypt something on the left.</p>`;
    return;
  }

  serverRows.innerHTML = "";
  for (const row of rows) {
    const card = document.createElement("div");
    card.className = "row-card";
    card.dataset.id = row.id;
    card.innerHTML = `
      <div class="spread">
        <code class="mono faint">${row.id.slice(0, 8)}</code>
        <span class="tag ${row.burn ? "warn" : ""}">${row.burn ? "burns on read" : "persists"}</span>
      </div>
      <div class="cipher mono" title="click to expand">${truncate(row.ciphertext, 64)}</div>
      <div class="meta muted mono">
        <span>iv: ${truncate(row.iv, 24)}</span>
        <span>created: ${fmtTime(row.createdAt)}</span>
      </div>
      <div class="actions">
        <button class="tamper-btn danger" type="button">tamper with ciphertext</button>
      </div>
    `;
    const cipherEl = card.querySelector(".cipher");
    let expanded = false;
    cipherEl.addEventListener("click", () => {
      expanded = !expanded;
      cipherEl.textContent = expanded ? row.ciphertext : truncate(row.ciphertext, 64);
      cipherEl.classList.toggle("expanded", expanded);
    });
    card.querySelector(".tamper-btn").addEventListener("click", () => {
      server.tamper(row.id);
      card.classList.add("flash");
      renderServer();
    });
    serverRows.appendChild(card);
  }
}

clearServerBtn.addEventListener("click", () => {
  server.clear();
  renderServer();
});

// ---------- encrypt + upload ----------

encryptBtn.addEventListener("click", async () => {
  const text = plaintextInput.value;
  if (!text) return;

  encryptBtn.disabled = true;
  try {
    const key = await generateKey();
    const keyB64 = await exportKeyRaw(key);
    const { ciphertext, iv } = await encryptText(key, text);
    const id = server.put({ ciphertext, iv, burn: burnCheckbox.checked });
    const link = buildShareLink(baseUrl(), id, keyB64);

    genKeyOut.textContent = keyB64;
    genIvOut.textContent = iv;
    shareLinkOut.value = link;
    encryptNote.textContent =
      `Your note was scrambled here in the browser and only the scrambled form was uploaded: ` +
      `that is the new top row on the right. The key below was made for this one note and exists ` +
      `in two places only — this tab, and the link. Whoever holds the link can read the note; the ` +
      `server cannot.`;
    uploadResult.hidden = false;
    renderServer();
  } catch (err) {
    uploadResult.hidden = false;
    encryptNote.textContent = "Nothing was uploaded: the browser could not complete the encryption.";
    genKeyOut.textContent = "";
    genIvOut.textContent = "";
    shareLinkOut.value = "";
    console.error(err);
  } finally {
    encryptBtn.disabled = false;
  }
});

copyLinkBtn.addEventListener("click", async () => {
  if (!shareLinkOut.value) return;
  try {
    await navigator.clipboard.writeText(shareLinkOut.value);
    copyLinkBtn.textContent = "copied";
    setTimeout(() => (copyLinkBtn.textContent = "copy"), 1200);
  } catch {
    shareLinkOut.select();
  }
});

// ---------- recipient view ----------

async function openLink(href) {
  decryptResult.hidden = false;
  decryptResult.className = "result-box panel mono";
  decryptResult.textContent = "decrypting…";
  decryptNote.hidden = true;
  try {
    const { id, keyB64 } = parseShareLink(href);
    const row = server.get(id); // burn-after-reading deletes here if flagged
    renderServer();
    if (!row) {
      decryptResult.className = "result-box panel mono error";
      decryptResult.textContent =
        "No such note on the server. It may already have been read once (burn-after-reading) or never existed.";
      decryptNote.hidden = false;
      decryptNote.textContent =
        "Nothing came back, because there is no row left to read. A note set to burn is deleted by the " +
        "server the first time it is opened, so a second reader gets this.";
      return;
    }
    const key = await importKeyRaw(keyB64);
    const plaintext = await decryptText(key, row.ciphertext, row.iv);
    decryptResult.className = "result-box panel mono ok";
    decryptResult.textContent = plaintext;
    decryptNote.hidden = false;
    decryptNote.textContent =
      "The link supplied the key, the server supplied the scrambled bytes, and the two were put " +
      "together in this tab. The text above was never present on the server in readable form.";
  } catch (err) {
    decryptResult.className = "result-box panel mono error";
    decryptResult.textContent =
      "Decryption failed: authentication check did not pass. The ciphertext is wrong, tampered, " +
      "or the key does not match. GCM refuses to hand back plaintext when this happens — " +
      `it never silently returns garbage. (${err.message || err})`;
    decryptNote.hidden = false;
    decryptNote.textContent =
      "That refusal is the point. Someone who can reach the stored row can destroy your note, but " +
      "they cannot change one word of it and have the reader believe it.";
  }
}

openLinkBtn.addEventListener("click", () => {
  const href = recipientLinkInput.value.trim();
  if (href) openLink(href);
});

// ---------- benchmark ----------

const BENCH_SIZES = [1024, 4 * 1024, 16 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024];

function randomText(bytes) {
  const arr = new Uint8Array(bytes);
  // crypto.getRandomValues throws above 65536 bytes per call, so fill in chunks.
  const MAX_CHUNK = 65536;
  for (let offset = 0; offset < arr.length; offset += MAX_CHUNK) {
    crypto.getRandomValues(arr.subarray(offset, Math.min(offset + MAX_CHUNK, arr.length)));
  }
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(33 + (arr[i] % 90));
  return s;
}

// The last measured run, kept so the chart can be repainted in the new
// palette when the theme changes. Canvas pixels do not inherit CSS.
let lastBenchResults = null;

function drawChart(results) {
  lastBenchResults = results;
  const ctx = benchCanvas.getContext("2d");
  const w = benchCanvas.width;
  const h = benchCanvas.height;
  ctx.clearRect(0, 0, w, h);

  const padL = 56;
  const padB = 32;
  const padT = 16;
  const padR = 16;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const maxThroughput = Math.max(...results.map((r) => r.throughput)) * 1.15;
  const styles = getComputedStyle(document.documentElement);
  const gridColor = styles.getPropertyValue("--border").trim();
  const textColor = styles.getPropertyValue("--text-dim").trim();
  const accent = styles.getPropertyValue("--accent").trim();

  ctx.strokeStyle = gridColor;
  ctx.fillStyle = textColor;
  ctx.font = "11px ui-monospace, monospace";
  ctx.lineWidth = 1;

  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const y = padT + (plotH * i) / ySteps;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    const val = maxThroughput * (1 - i / ySteps);
    ctx.fillText(val.toFixed(0), 4, y + 4);
  }

  const n = results.length;
  const barW = plotW / n - 12;

  results.forEach((r, i) => {
    const x = padL + (plotW / n) * i + 6;
    const barH = (r.throughput / maxThroughput) * plotH;
    const y = padT + plotH - barH;
    ctx.fillStyle = accent;
    ctx.fillRect(x, y, barW, barH);
    ctx.fillStyle = textColor;
    ctx.save();
    ctx.translate(x + barW / 2, h - padB + 14);
    ctx.textAlign = "center";
    ctx.fillText(fmtBytes(r.size), 0, 0);
    ctx.restore();
  });

  ctx.fillStyle = textColor;
  ctx.save();
  ctx.translate(14, padT + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText("MB/s", 0, 0);
  ctx.restore();
}

runBenchmarkBtn.addEventListener("click", async () => {
  runBenchmarkBtn.disabled = true;
  benchStatus.textContent = "running…";
  benchTableBody.innerHTML = "";
  const results = [];

  try {
    const key = await generateKey();
    const MIN_SPAN_MS = 20;
    for (const size of BENCH_SIZES) {
      const text = randomText(size);
      // warm-up run so JIT/optimisation is not counted against the smallest payload
      await encryptText(key, text.slice(0, Math.min(1024, size)));

      // Repeat until the total measured span is meaningful -- a single small
      // payload can encrypt in well under a timer tick, which would report
      // quantisation noise rather than a real measurement.
      let reps = 0;
      let total = 0;
      const t0 = performance.now();
      do {
        await encryptText(key, text);
        reps++;
        total = performance.now() - t0;
      } while (total < MIN_SPAN_MS && reps < 100000);
      const ms = total / reps;
      const mbps = size / 1024 / 1024 / (ms / 1000);
      results.push({ size, ms, throughput: mbps });

      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${fmtBytes(size)}</td><td class="num">${ms.toFixed(3)} ms${reps > 1 ? ` (avg of ${reps})` : ""}</td><td class="num">${mbps.toFixed(1)} MB/s</td>`;
      benchTableBody.appendChild(tr);
    }
    drawChart(results);
    benchStatus.textContent = `measured just now in this browser, ${results.length} payload sizes`;
    const biggest = results.at(-1);
    const smallest = results[0];
    benchNote.hidden = false;
    benchNote.textContent =
      `A note-sized payload of ${fmtBytes(smallest.size)} was encrypted in ${smallest.ms.toFixed(3)} ms on this machine, ` +
      `and ${fmtBytes(biggest.size)} took ${biggest.ms.toFixed(0)} ms — ${biggest.throughput.toFixed(0)} megabytes a second. ` +
      `Keeping the server unable to read your data costs the user nothing they could notice.`;
  } catch (err) {
    benchStatus.textContent = `benchmark failed: ${err.message || err}`;
  } finally {
    runBenchmarkBtn.disabled = false;
  }
});

document.addEventListener("themechange", () => {
  if (lastBenchResults) drawChart(lastBenchResults);
});

// ---------- init ----------

function seedSampleRow() {
  if (server.list().length > 0) return;
  (async () => {
    const key = await generateKey();
    const { ciphertext, iv } = await encryptText(
      key,
      "This row was pre-seeded so the table is never empty on first load."
    );
    server.put({ ciphertext, iv, burn: false });
    renderServer();
  })();
}

function init() {
  plaintextInput.value = SAMPLE_SECRET;
  renderServer();
  seedSampleRow();

  // If we were opened via a share link (has ?id= and #k=), jump straight
  // into the recipient view and decrypt automatically.
  if (location.search.includes("id=") && location.hash.includes("k=")) {
    recipientLinkInput.value = location.href;
    openLink(location.href);
    $("recipient-section").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

init();
