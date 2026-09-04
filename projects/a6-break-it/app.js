// app.js — DOM, canvas and animation. Every attack itself lives in attacks.js.
import {
  ecbEncrypt,
  cbcEncryptRaw,
  ctrEncrypt,
  xorBytes,
  dragCrib,
  rankCribOffsets,
  breakManyTimePad,
  PaddingOracle,
  paddingOracleAttack,
  naiveMac,
  naiveMacVerify,
  lengthExtend,
  hmacSha256,
  timedCompare,
  toHex,
  textToBytes,
  bytesToText,
} from "./attacks.js";

const $ = (id) => document.getElementById(id);

/** Yields to the browser so a long attack can paint while it runs. */
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** getRandomValues refuses more than 65536 bytes at once, so fill in chunks. */
function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) {
    crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  }
  return out;
}

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ============================================================================
// 1. ECB penguin
// ============================================================================

const ECB_SIZE = 240;
const ecbShapes = ["SECRET", "penguin", "BROKEN"];
let ecbShapeIndex = 0;

/**
 * Draws a high-contrast image on the canvas. High contrast is the point: ECB
 * preserves whatever is repetitive, and large flat areas are as repetitive as
 * it gets. A photograph would leak far less obviously.
 */
function drawSourceImage(ctx, shape) {
  const s = ECB_SIZE;
  ctx.fillStyle = "#f2f6fa";
  ctx.fillRect(0, 0, s, s);

  ctx.fillStyle = "#10151c";
  if (shape === "penguin") {
    // A blocky penguin: body, head, eyes, beak, feet.
    ctx.beginPath();
    ctx.ellipse(s / 2, s * 0.6, s * 0.26, s * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(s / 2, s * 0.28, s * 0.17, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f2f6fa";
    ctx.beginPath();
    ctx.ellipse(s / 2, s * 0.63, s * 0.15, s * 0.24, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(s * 0.44, s * 0.26, s * 0.035, 0, Math.PI * 2);
    ctx.arc(s * 0.56, s * 0.26, s * 0.035, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#e8a020";
    ctx.beginPath();
    ctx.moveTo(s * 0.5, s * 0.3);
    ctx.lineTo(s * 0.44, s * 0.37);
    ctx.lineTo(s * 0.56, s * 0.37);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(s * 0.36, s * 0.88, s * 0.1, s * 0.05);
    ctx.fillRect(s * 0.54, s * 0.88, s * 0.1, s * 0.05);
  } else {
    ctx.font = `700 ${shape.length > 6 ? 46 : 58}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(shape, s / 2, s / 2);
    ctx.fillRect(s * 0.1, s * 0.16, s * 0.8, s * 0.06);
    ctx.fillRect(s * 0.1, s * 0.78, s * 0.8, s * 0.06);
  }
}

/**
 * Encrypts the RGB channels only. Alpha is left opaque: encrypting it too
 * would make the result semi-transparent and muddy the point, which is what
 * happens to the *colours*.
 */
function encryptPixels(imageData, encrypt) {
  const src = imageData.data;
  const rgb = new Uint8Array((src.length / 4) * 3);
  for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
    rgb[j] = src[i];
    rgb[j + 1] = src[i + 1];
    rgb[j + 2] = src[i + 2];
  }
  // Whole blocks only; the tail is left as it is rather than padded, so the
  // output stays exactly one image in size.
  const usable = rgb.length - (rgb.length % 16);
  const out = encrypt(rgb.subarray(0, usable));

  const result = new ImageData(imageData.width, imageData.height);
  for (let i = 0, j = 0; i < result.data.length; i += 4, j += 3) {
    result.data[i] = j < usable ? out[j] : rgb[j];
    result.data[i + 1] = j + 1 < usable ? out[j + 1] : rgb[j + 1];
    result.data[i + 2] = j + 2 < usable ? out[j + 2] : rgb[j + 2];
    result.data[i + 3] = 255;
  }
  return result;
}

function setupEcb() {
  const plainCanvas = $("ecb-plain");
  const ecbCanvas = $("ecb-ecb");
  const cbcCanvas = $("ecb-cbc");
  const status = $("ecb-status");
  const progress = $("ecb-progress");
  const stats = $("ecb-stats");

  const plainCtx = plainCanvas.getContext("2d", { willReadFrequently: true });

  const redraw = () => {
    drawSourceImage(plainCtx, ecbShapes[ecbShapeIndex]);
    for (const c of [ecbCanvas, cbcCanvas]) {
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#0a0d12";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = "#6b7785";
      ctx.font = "13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("not encrypted yet", c.width / 2, c.height / 2);
    }
    stats.innerHTML = "";
    status.textContent = "";
  };

  const run = async () => {
    const key = randomBytes(16);
    const iv = randomBytes(16);
    const source = plainCtx.getImageData(0, 0, ECB_SIZE, ECB_SIZE);

    progress.hidden = false;
    progress.querySelector(".bar").style.width = "20%";
    status.textContent = "encrypting with AES-128...";
    await frame();

    const t0 = performance.now();
    const ecbImage = encryptPixels(source, (data) => ecbEncrypt(key, data));
    progress.querySelector(".bar").style.width = "60%";
    await frame();
    const cbcImage = encryptPixels(source, (data) => cbcEncryptRaw(key, iv, data));
    const elapsed = performance.now() - t0;

    ecbCanvas.getContext("2d").putImageData(ecbImage, 0, 0);
    cbcCanvas.getContext("2d").putImageData(cbcImage, 0, 0);
    progress.querySelector(".bar").style.width = "100%";

    // How much of the leak is measurable: count repeated 16-byte blocks in the
    // ciphertext. Counted on the source pixels rather than by re-reading the
    // rendered RGBA, which is the same data and far cheaper to walk.
    const sourceRgb = new Uint8Array((source.data.length / 4) * 3);
    for (let i = 0, j = 0; i < source.data.length; i += 4, j += 3) {
      sourceRgb[j] = source.data[i];
      sourceRgb[j + 1] = source.data[i + 1];
      sourceRgb[j + 2] = source.data[i + 2];
    }
    const cipherBytes = ecbEncrypt(key, sourceRgb.subarray(0, sourceRgb.length - (sourceRgb.length % 16)));
    const blocks = cipherBytes.length / 16;
    const seen = new Set();
    let repeats = 0;
    for (let b = 0; b < blocks; b++) {
      const block = cipherBytes.subarray(b * 16, b * 16 + 16);
      // Latin-1 string of the block: a cheap hashable key, no hex formatting.
      const hashKey = String.fromCharCode.apply(null, block);
      if (seen.has(hashKey)) repeats++;
      else seen.add(hashKey);
    }

    stats.innerHTML = `
      <div class="stat"><span class="value">${blocks.toLocaleString()}</span><span class="label">AES blocks</span></div>
      <div class="stat"><span class="value">${repeats.toLocaleString()}</span><span class="label">repeated ciphertext blocks</span></div>
      <div class="stat"><span class="value">${elapsed.toFixed(0)} ms</span><span class="label">to encrypt twice</span></div>
    `;
    status.textContent = "done — the ECB panel is real AES output";
    setTimeout(() => { progress.hidden = true; }, 400);
  };

  $("ecb-run").addEventListener("click", run);
  $("ecb-shape").addEventListener("click", () => {
    ecbShapeIndex = (ecbShapeIndex + 1) % ecbShapes.length;
    redraw();
  });

  redraw();
  return run;
}

// ============================================================================
// 2. Nonce reuse
// ============================================================================

const PAD_MESSAGES = [
  "the meeting is at the old station house at nine in the mornin",
  "bring the documents and do not tell anyone where we are going",
  "we will move the shipment on friday evening as planned agains",
  "the courier will wait by the harbour gate until after midnigh",
  "do not use this channel again after the transfer is completed",
  "the password for the account is written on the back of a card",
  "he said that the report was sent to the wrong address by mist",
  "please meet me at the station tomorrow and bring the document",
];

function setupPad() {
  // One key, one nonce, every message. That is the entire bug.
  const key = randomBytes(16);
  const nonce = randomBytes(8);
  const plaintexts = PAD_MESSAGES.map(textToBytes);
  const ciphertexts = plaintexts.map((m) => ctrEncrypt(key, nonce, m));

  // ---- crib dragging, on the first two messages ----
  const xored = xorBytes(ciphertexts[0], ciphertexts[1]);
  const cribInput = $("crib-input");
  const offsetInput = $("crib-offset");
  const offsetValue = $("crib-offset-value");
  const m1Out = $("crib-m1");
  const m2Out = $("crib-m2");
  const verdict = $("crib-verdict");

  const renderCrib = () => {
    const crib = textToBytes(cribInput.value);
    const offset = Number(offsetInput.value);
    offsetValue.textContent = String(offset);
    offsetInput.max = String(Math.max(0, xored.length - Math.max(1, crib.length)));

    if (crib.length === 0) {
      m1Out.textContent = "";
      m2Out.textContent = "";
      verdict.textContent = "Type a guess above.";
      return;
    }
    const other = dragCrib(xored, crib, offset);
    const pad = " ".repeat(offset);
    m1Out.innerHTML = `${pad}<span class="crib-hit">${escapeHtml(cribInput.value)}</span>`;
    m2Out.innerHTML = `${pad}<span class="crib-hit">${escapeHtml(bytesToText(other))}</span>`;

    // Is what fell out of the other message plausible English?
    const truth = bytesToText(plaintexts[1]).slice(offset, offset + crib.length);
    const correct = bytesToText(other) === truth;
    verdict.textContent = correct
      ? "That is exactly what message two says at this offset."
      : "Not aligned yet — drag the offset until message two reads as English.";
    verdict.className = correct ? "verdict ok" : "faint";
  };

  cribInput.addEventListener("input", renderCrib);
  offsetInput.addEventListener("input", renderCrib);
  $("crib-best").addEventListener("click", () => {
    const crib = textToBytes(cribInput.value);
    if (crib.length === 0) return;
    const [best] = rankCribOffsets(xored, crib, 1);
    offsetInput.value = String(best.offset);
    renderCrib();
  });
  renderCrib();

  // ---- the automatic attack ----
  const countInput = $("pad-count");
  const countValue = $("pad-count-value");
  const output = $("pad-output");
  const status = $("pad-status");
  const progress = $("pad-progress");
  const accuracy = $("pad-accuracy");
  const runBtn = $("pad-run");

  countInput.addEventListener("input", () => {
    countValue.textContent = countInput.value;
  });

  const run = async () => {
    const count = Number(countInput.value);
    runBtn.disabled = true;
    progress.hidden = false;
    progress.querySelector(".bar").style.width = "35%";
    status.textContent = `attacking ${count} ciphertexts...`;
    output.innerHTML = "";
    accuracy.innerHTML = "";
    await frame();

    const t0 = performance.now();
    const { messages } = breakManyTimePad(ciphertexts.slice(0, count));
    const elapsed = performance.now() - t0;
    progress.querySelector(".bar").style.width = "100%";

    let hits = 0;
    let total = 0;
    output.innerHTML = "";
    messages.forEach((got, i) => {
      const truth = plaintexts[i];
      const text = bytesToText(got);
      let html = "";
      for (let j = 0; j < text.length; j++) {
        const right = got[j] === truth[j];
        total++;
        if (right) hits++;
        html += `<span class="${right ? "right" : "wrong"}">${escapeHtml(text[j])}</span>`;
      }
      const line = document.createElement("div");
      line.className = "line";
      line.innerHTML = html;
      output.appendChild(line);
    });

    accuracy.innerHTML = `
      <div class="stat"><span class="value">${((hits / total) * 100).toFixed(1)}%</span><span class="label">characters recovered</span></div>
      <div class="stat"><span class="value">${elapsed.toFixed(0)} ms</span><span class="label">without the key</span></div>
    `;
    status.textContent = count >= 6
      ? "recovered — green is correct, red is where the model guessed wrong"
      : "recovered — with few ciphertexts there is less evidence per byte";
    runBtn.disabled = false;
    setTimeout(() => { progress.hidden = true; }, 400);
  };

  runBtn.addEventListener("click", run);
  return run;
}

// ============================================================================
// 3. Padding oracle
// ============================================================================

function setupOracle() {
  const secretInput = $("oracle-secret");
  const runBtn = $("oracle-run");
  const stopBtn = $("oracle-stop");
  const grid = $("oracle-grid");
  const stats = $("oracle-stats");
  const plaintextOut = $("oracle-plaintext");
  const blockStrip = $("oracle-blocks");
  const verdict = $("oracle-verdict");

  // 256 cells, one per guess for the byte being worked on.
  const cells = [];
  for (let i = 0; i < 256; i++) {
    const cell = document.createElement("span");
    grid.appendChild(cell);
    cells.push(cell);
  }

  let cancelled = false;

  const run = async () => {
    cancelled = false;
    runBtn.disabled = true;
    stopBtn.disabled = false;
    verdict.textContent = "";
    verdict.className = "verdict";

    const key = randomBytes(16);
    const iv = randomBytes(16);
    const secret = textToBytes(secretInput.value || " ");
    const oracle = new PaddingOracle(key);
    const ciphertext = oracle.seal(iv, secret);
    const totalBytes = ciphertext.length;
    const blockCount = totalBytes / 16;

    blockStrip.innerHTML = "";
    const blockTags = [];
    for (let b = 0; b < blockCount; b++) {
      const tag = document.createElement("span");
      tag.className = "blk";
      tag.textContent = `block ${b}`;
      blockStrip.appendChild(tag);
      blockTags.push(tag);
    }

    const known = new Uint8Array(totalBytes);
    const isKnown = new Array(totalBytes).fill(false);
    let activeIndex = -1;

    const renderPlaintext = () => {
      let html = "";
      for (let i = 0; i < totalBytes; i++) {
        if (isKnown[i]) {
          const ch = known[i] >= 32 && known[i] < 127 ? String.fromCharCode(known[i]) : "·";
          html += `<span class="known">${escapeHtml(ch)}</span>`;
        } else if (i === activeIndex) {
          html += `<span class="active">?</span>`;
        } else {
          html += `<span class="unknown">·</span>`;
        }
      }
      plaintextOut.innerHTML = html;
    };
    renderPlaintext();

    const renderStats = (queries) => {
      // 2^128 is the brute force this replaces. Rendered as a power, because
      // the number itself means nothing to anyone.
      stats.innerHTML = `
        <div class="stat"><span class="value">${queries.toLocaleString()}</span><span class="label">oracle queries</span></div>
        <div class="stat"><span class="value">2<sup>128</sup></span><span class="label">keys the attack skips</span></div>
        <div class="stat"><span class="value">${totalBytes}</span><span class="label">bytes to recover</span></div>
      `;
    };
    renderStats(0);

    // The attack is synchronous; onStep hands us every query so we can paint.
    // Painting each of several thousand queries would take minutes, so the
    // display is throttled and the run is chunked with await.
    const steps = [];

    // Run the real attack first, recording every oracle query, then replay the
    // recording as the animation. Painting inside the attack would either stall
    // the page or force the attack to be rewritten as a state machine; this way
    // the numbers on screen are the genuine ones.
    const attackResult = paddingOracleAttack(oracle, iv, ciphertext, (step) => {
      steps.push(step);
    });

    // Group the recorded queries by the byte they were attacking, so the
    // animation paints once per byte (64 frames) rather than once per query
    // (nearly 9000). Painting every query would take over two minutes and
    // block the page; the grid still shows every guess that was made.
    const byByte = [];
    for (const step of steps) {
      const globalIndex = step.blockIndex * 16 + step.byteIndex;
      if (byByte.length === 0 || byByte.at(-1).index !== globalIndex) {
        byByte.push({ index: globalIndex, blockIndex: step.blockIndex, steps: [] });
      }
      byByte.at(-1).steps.push(step);
    }

    for (const group of byByte) {
      if (cancelled) break;
      activeIndex = group.index;
      for (const cell of cells) cell.className = "";
      blockTags.forEach((tag, b) => {
        tag.className =
          "blk" + (b < group.blockIndex ? " done" : b === group.blockIndex ? " busy" : "");
      });
      for (const step of group.steps) {
        cells[step.guess].className = step.valid ? "hit" : "tried";
      }
      isKnown[group.index] = true;
      for (let i = 0; i < totalBytes; i++) {
        if (isKnown[i]) known[i] = attackResult.padded[i];
      }
      renderPlaintext();
      renderStats(group.steps.at(-1).queries);
      await frame();
    }

    blockTags.forEach((tag) => { tag.className = "blk done"; });
    activeIndex = -1;
    for (let i = 0; i < totalBytes; i++) {
      isKnown[i] = true;
      known[i] = attackResult.padded[i];
    }
    renderPlaintext();
    renderStats(oracle.queries);

    const recovered = bytesToText(attackResult.plaintext);
    const exact = recovered === secretInput.value;
    verdict.textContent = cancelled
      ? "stopped"
      : exact
        ? `Recovered exactly, in ${oracle.queries.toLocaleString()} queries. The key was never involved.`
        : "Recovered (differs from the input, which should not happen).";
    verdict.className = "verdict " + (cancelled ? "" : exact ? "ok" : "fail");

    runBtn.disabled = false;
    stopBtn.disabled = true;
  };

  runBtn.addEventListener("click", run);
  stopBtn.addEventListener("click", () => { cancelled = true; });
  return run;
}

// ============================================================================
// 4. Length extension
// ============================================================================

function setupExtend() {
  // The server's secret. The attack never sees it; only its length is guessed.
  const secret = randomBytes(20);

  const messageInput = $("extend-message");
  const suffixInput = $("extend-suffix");
  const lenInput = $("extend-secretlen");
  const lenValue = $("extend-secretlen-value");
  const bytesView = $("extend-bytes");
  const result = $("extend-result");
  const status = $("extend-status");

  lenInput.addEventListener("input", () => {
    lenValue.textContent = lenInput.value;
  });

  const run = () => {
    const message = textToBytes(messageInput.value);
    const suffix = textToBytes(suffixInput.value);
    const guessedLength = Number(lenInput.value);

    // What the server published.
    const mac = naiveMac(secret, message);

    // What the attacker builds from (message, mac, guessed length) alone.
    const { forgedMessage, glue, mac: forgedMac } = lengthExtend(message, mac, guessedLength, suffix);
    const accepted = naiveMacVerify(secret, forgedMessage, forgedMac);

    // Show the forged message as bytes, with the three regions coloured.
    const render = (bytes) =>
      Array.from(bytes, (b) => {
        if (b >= 32 && b < 127) return escapeHtml(String.fromCharCode(b));
        return `\\x${b.toString(16).padStart(2, "0")}`;
      }).join("");

    bytesView.innerHTML =
      `<span class="seg-original">${render(message)}</span>` +
      `<span class="seg-glue">${render(glue)}</span>` +
      `<span class="seg-suffix">${render(suffix)}</span>` +
      `<div class="legend">
         <span class="l-original">original message</span>
         <span class="l-glue">glue padding (${glue.length} bytes)</span>
         <span class="l-suffix">appended by the attacker</span>
       </div>`;

    const hmacTag = hmacSha256(secret, message);
    result.innerHTML = `
      <div class="mac-row"><span class="label">published</span><span>${toHex(mac)}</span></div>
      <div class="mac-row"><span class="label">forged</span><span class="${accepted ? "ok" : "fail"}">${toHex(forgedMac)}</span></div>
      <p class="verdict ${accepted ? "ok" : "fail"}">
        ${accepted
          ? "The server accepts this MAC for a message it never signed. The secret was not needed, only its length."
          : `Rejected: ${guessedLength} is the wrong secret length. An attacker just tries the next one.`}
      </p>
      <div class="mac-row"><span class="label">with HMAC</span><span class="ok">${toHex(hmacTag)}</span></div>
      <p class="faint">
        HMAC over the same message and secret. There is no state to resume, so
        the same trick produces nothing.
      </p>
    `;
    status.textContent = accepted ? "forged" : "wrong length, try another";
  };

  for (const el of [messageInput, suffixInput, lenInput]) {
    el.addEventListener("input", run);
  }
  $("extend-run").addEventListener("click", run);
  run();
}

// ============================================================================
// 5. Timing side channel
// ============================================================================

const TOKEN = "d3adb33f";
const TOKEN_ALPHABET = "0123456789abcdef";

function setupTiming() {
  const runBtn = $("timing-run");
  const stopBtn = $("timing-stop");
  const constantToggle = $("timing-constant");
  const canvas = $("timing-canvas");
  const tokenOut = $("timing-token");
  const verdict = $("timing-verdict");
  const stats = $("timing-stats");
  const ctx = canvas.getContext("2d");

  const secret = textToBytes(TOKEN);
  let cancelled = false;

  const drawChart = (timings, bestIndex, found) => {
    const w = canvas.width;
    const h = canvas.height;
    const pad = { left: 44, right: 12, top: 14, bottom: 28 };
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0a0d12";
    ctx.fillRect(0, 0, w, h);

    const values = timings.filter((v) => v > 0);
    if (values.length === 0) return;
    const max = Math.max(...values);
    const min = Math.min(...values);
    // A zero-based axis would flatten the whole chart, because the differences
    // are small next to the absolute time. The axis therefore starts just below
    // the fastest candidate, and is labelled so that is visible.
    const floor = min - (max - min) * 0.35 || 0;
    const span = max - floor || 1;

    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;
    const barW = plotW / timings.length;

    ctx.strokeStyle = "#262d38";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#6b7785";
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "right";
    for (let g = 0; g <= 4; g++) {
      const y = pad.top + (plotH * g) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      const value = floor + span * (1 - g / 4);
      ctx.fillText(value.toFixed(2), pad.left - 6, y + 3);
    }
    ctx.textAlign = "left";
    ctx.fillText("ms", 6, pad.top - 3);

    timings.forEach((t, i) => {
      if (t <= 0) return;
      const barH = ((t - floor) / span) * plotH;
      const x = pad.left + i * barW;
      const y = pad.top + plotH - barH;
      ctx.fillStyle = i === bestIndex ? (found ? "#3fb950" : "#4c8dff") : "#39424f";
      ctx.fillRect(x + barW * 0.15, y, barW * 0.7, barH);

      ctx.fillStyle = i === bestIndex ? "#e6edf3" : "#6b7785";
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText(TOKEN_ALPHABET[i], x + barW / 2, h - 10);
    });
  };

  const renderToken = (found, pending) => {
    tokenOut.innerHTML =
      `<span class="found">${escapeHtml(found)}</span>` +
      `<span class="pending">${"·".repeat(pending)}</span>`;
  };

  /**
   * Times one candidate. `repeats` is the amplification: a single comparison is
   * far below the clock's resolution, so it is run many times and the total is
   * measured. The effect is real; the repetition only lifts it above the noise.
   */
  const timeCandidate = (guess, constantTime, repeats) => {
    const bytes = textToBytes(guess);
    const t0 = performance.now();
    for (let r = 0; r < repeats; r++) {
      timedCompare(secret, bytes, { constantTime, work: 900 });
    }
    return performance.now() - t0;
  };

  const run = async () => {
    cancelled = false;
    runBtn.disabled = true;
    stopBtn.disabled = false;
    verdict.textContent = "";
    verdict.className = "verdict";

    const constantTime = constantToggle.checked;
    // Each measurement has to land in the low milliseconds, or the difference
    // between "three bytes matched" and "four bytes matched" falls under the
    // clock's resolution. Measured in this browser, 2000 repetitions take
    // about 4 ms for a full match against 0.4 ms when the first byte is wrong.
    // The first version used 90 repetitions, and the whole signal sat below
    // the timer's granularity: the attack recovered nothing at all.
    //
    // The budget is split between repetitions and rounds so that no single
    // measurement blocks the main thread long enough to freeze the page.
    const repeats = 700;
    const rounds = 6; // repeated passes, keeping the median, to beat jitter
    let found = "";
    let attempts = 0;
    const t0 = performance.now();

    for (let pos = 0; pos < TOKEN.length; pos++) {
      if (cancelled) break;
      const samples = TOKEN_ALPHABET.split("").map(() => []);

      for (let round = 0; round < rounds; round++) {
        for (let c = 0; c < TOKEN_ALPHABET.length; c++) {
          if (cancelled) break;
          // Pad the guess to the token's length so the comparison runs the same
          // number of times regardless of how much is known.
          const guess = (found + TOKEN_ALPHABET[c]).padEnd(TOKEN.length, "\u0000");
          samples[c].push(timeCandidate(guess, constantTime, repeats));
          attempts++;
        }
        const medians = samples.map((s) => {
          if (s.length === 0) return 0;
          const sorted = [...s].sort((a, b) => a - b);
          return sorted[Math.floor(sorted.length / 2)];
        });
        let bestIndex = 0;
        medians.forEach((m, i) => { if (m > medians[bestIndex]) bestIndex = i; });
        drawChart(medians, bestIndex, false);
        renderToken(found, TOKEN.length - found.length);
        stats.innerHTML = `
          <div class="stat"><span class="value">${attempts.toLocaleString()}</span><span class="label">timed guesses</span></div>
          <div class="stat"><span class="value">${found.length}/${TOKEN.length}</span><span class="label">characters recovered</span></div>
          <div class="stat"><span class="value">16<sup>${TOKEN.length}</sup></span><span class="label">tokens brute force would try</span></div>
        `;
        await frame();
      }

      const medians = samples.map((s) => {
        const sorted = [...s].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
      });
      let bestIndex = 0;
      medians.forEach((m, i) => { if (m > medians[bestIndex]) bestIndex = i; });

      // The final character cannot be read from the clock. Every byte's work
      // loop runs before its comparison, so at the last position a right and a
      // wrong guess do exactly the same amount of work and the timing
      // difference is genuinely zero - not merely small. An attacker does not
      // care: with the first seven known there are only sixteen tokens left,
      // and the service itself says which one is accepted.
      if (pos === TOKEN.length - 1 && !constantTime) {
        for (let c = 0; c < TOKEN_ALPHABET.length; c++) {
          attempts++;
          if (timedCompare(secret, textToBytes(found + TOKEN_ALPHABET[c]), { work: 4 }).equal) {
            bestIndex = c;
            break;
          }
        }
      }

      found += TOKEN_ALPHABET[bestIndex];
      drawChart(medians, bestIndex, true);
      renderToken(found, TOKEN.length - found.length);
      await frame();
    }

    const elapsed = performance.now() - t0;
    const correct = found === TOKEN;
    stats.innerHTML = `
      <div class="stat"><span class="value">${attempts.toLocaleString()}</span><span class="label">timed guesses</span></div>
      <div class="stat"><span class="value">${(elapsed / 1000).toFixed(1)} s</span><span class="label">wall clock</span></div>
      <div class="stat"><span class="value">16<sup>${TOKEN.length}</sup></span><span class="label">tokens brute force would try</span></div>
    `;

    if (cancelled) {
      verdict.textContent = "stopped";
    } else if (correct) {
      verdict.textContent =
        `Recovered "${found}" in ${attempts} guesses rather than 16^${TOKEN.length}. ` +
        `The first ${TOKEN.length - 1} characters came from the clock alone; ` +
        `the last was one of sixteen remaining candidates.`;
      verdict.className = "verdict ok";
    } else {
      verdict.innerHTML = constantTime
        ? `Got "<code class="inline">${escapeHtml(found)}</code>", which is wrong. With the constant-time comparison there is no signal to follow, so the attack is reduced to guessing.`
        : `Got "<code class="inline">${escapeHtml(found)}</code>", which is wrong. Timing noise on this machine drowned the signal for at least one character; run it again.`;
      verdict.className = "verdict " + (constantTime ? "ok" : "fail");
    }

    runBtn.disabled = false;
    stopBtn.disabled = true;
  };

  runBtn.addEventListener("click", run);
  stopBtn.addEventListener("click", () => { cancelled = true; });
  renderToken("", TOKEN.length);
  return run;
}

// ============================================================================

// Each card renders something the moment it is set up. The two heavy attacks
// (the statistical recovery and the oracle replay) start themselves once the
// page has painted, so nothing competes for the main thread during load.
const runEcb = setupEcb();
const runPad = setupPad();
const runOracle = setupOracle();
setupExtend();
const runTiming = setupTiming();

// Run them one after another rather than all at once, so the page stays
// responsive and each result appears as it lands. Every card then shows a
// finished attack rather than an empty frame waiting to be clicked.
(async () => {
  await runEcb();
  await runOracle();
  await runPad();
  await runTiming();
})();
