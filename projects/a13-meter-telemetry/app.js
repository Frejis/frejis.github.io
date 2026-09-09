// app.js — DOM wiring only. All the codec, channel and power logic lives in
// frame.js / channel.js / power.js, which are plain modules importable from
// Node as well (see the *.test.js files next to this one).
import {
  encodeFull,
  decodeFull,
  tryEncodeDelta,
  crcOk,
  crc16,
  FIELD_MAX,
  FULL_FIELDS,
  FULL_PAYLOAD_BYTES,
  FULL_FRAME_BYTES,
  fieldAtBit,
} from "./frame.js";
import { runChannel } from "./channel.js";
import { batteryLifeYears, DEFAULT_ASSUMPTIONS } from "./power.js";

const $ = (id) => document.getElementById(id);
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");

// Compact axis label ("1.9M" instead of "1,859,537") so a wide left margin
// is not the only thing standing between a big count and a clipped label.
const compactNumber = (n) => {
  const rounded = Math.round(n);
  if (rounded >= 1_000_000) return `${(rounded / 1_000_000).toFixed(1)}M`;
  if (rounded >= 1_000) return `${(rounded / 1_000).toFixed(1)}k`;
  return rounded.toLocaleString();
};

// A fixed colour per field key, cycled through the theme's accent palette so
// the legend never invents a colour not already used elsewhere on the page.
const FIELD_COLORS = ["#4c8dff", "#3fb950", "#d29922", "#bc8cff", "#f85149", "#6ba1ff", "#2ea8a0"];
const colorFor = (() => {
  const assigned = new Map();
  let next = 0;
  return (key) => {
    if (!assigned.has(key)) assigned.set(key, FIELD_COLORS[next++ % FIELD_COLORS.length]);
    return assigned.get(key);
  };
})();

// ============================================================================
// A synthetic "current reading" driven by the sliders, plus a fixed previous
// reading ninety seconds earlier so the delta frame has something to shrink.
// ============================================================================

const START_TIME = 1_700_000_000;
const PREVIOUS_READING = {
  meterId: 184213,
  timestamp: START_TIME,
  volumeLiters: 1284392 - 40,
  flowRate: 310,
  battery: 27,
  flags: { leak: false, burst: false, backflow: false, tamper: false, lowBattery: true },
};

function readCurrentReading() {
  return {
    meterId: Number($("ctl-meterId").value),
    timestamp: START_TIME + 90,
    volumeLiters: Number($("ctl-volume").value),
    flowRate: Number($("ctl-flow").value),
    battery: Number($("ctl-battery").value),
    flags: {
      leak: $("ctl-leak").checked,
      burst: $("ctl-burst").checked,
      backflow: $("ctl-backflow").checked,
      tamper: $("ctl-tamper").checked,
      lowBattery: $("ctl-lowBattery").checked,
    },
  };
}

// ============================================================================
// 1. Byte map
// ============================================================================

function renderByteMap(container, fields, payloadBytes, frameBytes, onBitClick) {
  container.innerHTML = "";
  const totalBits = frameBytes.length * 8;
  for (let byteIndex = 0; byteIndex < frameBytes.length; byteIndex++) {
    const byteEl = document.createElement("div");
    byteEl.className = "byte";
    for (let bit = 0; bit < 8; bit++) {
      const bitIndex = byteIndex * 8 + bit;
      const owner = fieldAtBit(fields, payloadBytes, bitIndex);
      const bitValue = (frameBytes[byteIndex] >>> (7 - bit)) & 1;
      const el = document.createElement(onBitClick ? "button" : "span");
      el.type = onBitClick ? "button" : undefined;
      el.className = "bit" + (bitValue ? " on" : "");
      el.textContent = String(bitValue);
      el.title = `${owner ?? "pad"} · bit ${bitIndex}`;
      el.style.setProperty("--bit-color", owner === "crc" ? "#6b7785" : colorFor(owner ?? "pad"));
      if (onBitClick) {
        el.addEventListener("click", () => onBitClick(byteIndex, bit));
      }
      byteEl.appendChild(el);
    }
    container.appendChild(byteEl);
  }
  return totalBits;
}

function renderLegend(container, fields) {
  container.innerHTML = "";
  const seen = new Set();
  for (const f of fields) {
    if (seen.has(f.key)) continue;
    seen.add(f.key);
    const span = document.createElement("span");
    span.className = "swatch";
    span.style.setProperty("--sw-color", colorFor(f.key));
    span.textContent = `${f.label} (${f.bits}b)`;
    container.appendChild(span);
  }
  const crc = document.createElement("span");
  crc.className = "swatch";
  crc.style.setProperty("--sw-color", "#6b7785");
  crc.textContent = "CRC-16 (16b)";
  container.appendChild(crc);
}

function setupByteMap() {
  const mapEl = $("byte-map");
  const legendEl = $("byte-legend");
  const sizeTag = $("bytemap-size");
  const crcReadout = $("crc-readout");
  renderLegend(legendEl, FULL_FIELDS);

  const inputs = ["ctl-meterId", "ctl-volume", "ctl-flow", "ctl-battery",
    "ctl-leak", "ctl-burst", "ctl-backflow", "ctl-tamper", "ctl-lowBattery"];

  const render = () => {
    const reading = readCurrentReading();
    $("val-meterId").textContent = reading.meterId.toLocaleString();
    $("val-volume").textContent = `${reading.volumeLiters.toLocaleString()} L`;
    $("val-flow").textContent = `${(reading.flowRate / 10).toFixed(1)} L/h`;
    $("val-battery").textContent = `${reading.battery * 100 / 31 | 0}% (raw ${reading.battery}/31)`;

    const frameBytes = encodeFull(reading);
    renderByteMap(mapEl, FULL_FIELDS, FULL_PAYLOAD_BYTES, frameBytes, null);
    sizeTag.textContent = `${FULL_FRAME_BYTES} bytes on air`;
    const crc = crc16(frameBytes.subarray(0, FULL_PAYLOAD_BYTES));
    crcReadout.textContent = `CRC-16/CCITT-FALSE over the payload: 0x${crc.toString(16).padStart(4, "0")}`;
  };

  for (const id of inputs) $(id).addEventListener("input", render);
  render();
  return readCurrentReading;
}

// ============================================================================
// 2. Full vs delta
// ============================================================================

function setupCompare(getReading) {
  const overflowEl = $("delta-overflow");
  const deltaHexEl = $("delta-hex");

  const render = () => {
    const reading = getReading();
    const full = encodeFull(reading);
    $("full-hex").textContent = toHex(full);
    $("full-bytes").textContent = String(full.length);

    const attempt = tryEncodeDelta(reading, PREVIOUS_READING);
    if (attempt.ok) {
      const delta = attempt.bytes;
      deltaHexEl.hidden = false;
      overflowEl.hidden = true;
      deltaHexEl.textContent = toHex(delta);
      $("delta-bytes").textContent = String(delta.length);
      const saved = 1 - delta.length / full.length;
      $("delta-saving").textContent = `${(saved * 100).toFixed(0)}%`;
      return { full, delta };
    }

    // The jump since the previous reading does not fit the delta field —
    // a real meter would fall back to sending a full frame here. Show that
    // honestly instead of leaving the panel on stale numbers.
    deltaHexEl.hidden = true;
    overflowEl.hidden = false;
    overflowEl.textContent =
      `${attempt.error.message} — a jump this large cannot fit a 12-bit ` +
      `volume delta (max ${FIELD_MAX.volumeDelta.toLocaleString()}), so the ` +
      `meter would send a full frame instead of a delta one.`;
    $("delta-bytes").textContent = String(full.length);
    $("delta-saving").textContent = "0%";
    return { full, delta: full };
  };

  const inputs = ["ctl-meterId", "ctl-volume", "ctl-flow", "ctl-battery",
    "ctl-leak", "ctl-burst", "ctl-backflow", "ctl-tamper", "ctl-lowBattery"];
  for (const id of inputs) $(id).addEventListener("input", render);
  return render();
}

// ============================================================================
// 3. Corruption playground
// ============================================================================

function fieldValueList(reading) {
  return [
    ["meter id", reading.meterId.toLocaleString()],
    ["timestamp", String(reading.timestamp)],
    ["volume", `${reading.volumeLiters.toLocaleString()} L`],
    ["flow", `${(reading.flowRate / 10).toFixed(1)} L/h`],
    ["battery", `${reading.battery}/31`],
    ["leak", reading.flags.leak ? "yes" : "no"],
    ["burst", reading.flags.burst ? "yes" : "no"],
    ["backflow", reading.flags.backflow ? "yes" : "no"],
    ["tamper", reading.flags.tamper ? "yes" : "no"],
    ["low battery", reading.flags.lowBattery ? "yes" : "no"],
  ];
}

function setupCorruption(getReading) {
  const mapEl = $("corrupt-map");
  const crcTag = $("corrupt-crc");
  const decodedEl = $("corrupt-decoded");
  const resetBtn = $("corrupt-reset");

  let original = null;
  let current = null;

  const renderDecoded = () => {
    const valid = crcOk(current);
    crcTag.textContent = valid ? "CRC valid" : "CRC FAILED";
    crcTag.className = "tag " + (valid ? "ok" : "bad");

    let fields;
    let garbage = false;
    try {
      fields = fieldValueList(decodeFull(current).reading);
    } catch {
      fields = [["decode", "failed — invalid data"]];
      garbage = true;
    }
    if (!valid) garbage = true;
    decodedEl.className = "decoded-grid" + (garbage ? " garbage" : "");
    decodedEl.innerHTML = fields.map(([k, v]) =>
      `<div class="field"><span class="k">${k}</span><span class="v">${v}</span></div>`
    ).join("");
  };

  const renderMap = () => {
    renderByteMap(mapEl, FULL_FIELDS, FULL_PAYLOAD_BYTES, current, (byteIndex, bit) => {
      current[byteIndex] ^= 1 << (7 - bit);
      renderMap();
      renderDecoded();
    });
  };

  const reset = () => {
    original = encodeFull(getReading());
    current = Uint8Array.from(original);
    renderMap();
    renderDecoded();
  };

  resetBtn.addEventListener("click", reset);
  const inputs = ["ctl-meterId", "ctl-volume", "ctl-flow", "ctl-battery",
    "ctl-leak", "ctl-burst", "ctl-backflow", "ctl-tamper", "ctl-lowBattery"];
  for (const id of inputs) $(id).addEventListener("input", reset);

  reset();
}

// ============================================================================
// Canvas sizing — a canvas's backing store is independent of its CSS box, so
// leaving it at the HTML width/height attribute means the browser upscales a
// low-res bitmap into whatever the layout gives it, softening every line and
// letter. Size the backing store to the CSS box at the device's own pixel
// ratio, then scale the context so drawing code can keep working in CSS
// pixels.
// ============================================================================

function sizeCanvasForDisplay(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssWidth = rect.width || canvas.width;
  const cssHeight = rect.height || canvas.height;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: cssWidth, h: cssHeight };
}

// ============================================================================
// 3b. Bit-error-rate sweep
// ============================================================================

function drawBerChart(canvas, result) {
  const { ctx, w, h } = sizeCanvasForDisplay(canvas);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0a0d12";
  ctx.fillRect(0, 0, w, h);

  const bars = [
    { label: "intact", value: result.intact, color: "#3fb950" },
    { label: "caught by CRC", value: result.caughtByCrc, color: "#d29922" },
    { label: "undetected", value: result.undetected, color: "#f85149" },
  ];
  const pad = { left: 76, right: 16, top: 30, bottom: 30 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  // Headroom above the tallest bar so its value label never runs off the
  // top of the plot area — the axis scales to 1.15x the max value, not the
  // max value itself.
  const max = Math.max(...bars.map((b) => b.value), 1) * 1.15;
  const barW = plotW / bars.length;

  ctx.strokeStyle = "#262d38";
  ctx.fillStyle = "#6b7785";
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "right";
  for (let g = 0; g <= 4; g++) {
    const y = pad.top + (plotH * g) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    ctx.fillText(compactNumber(max * (1 - g / 4)), pad.left - 6, y + 3);
  }

  bars.forEach((b, i) => {
    const barH = (b.value / max) * plotH;
    const x = pad.left + i * barW;
    const y = pad.top + plotH - barH;
    ctx.fillStyle = b.color;
    ctx.fillRect(x + barW * 0.2, y, barW * 0.6, barH);
    ctx.fillStyle = "#e6edf3";
    ctx.textAlign = "center";
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillText(b.value.toLocaleString(), x + barW / 2, y - 6);
    ctx.fillStyle = "#9aa7b4";
    ctx.fillText(b.label, x + barW / 2, h - 10);
  });
}

// A 16-bit CRC misses roughly 1 in 65536 corrupted frames — see the README.
// 10,000 frames a run at a realistic BER produces only a few thousand
// corrupted frames, so the undetected bucket is 0 far more often than not
// and the panel's own headline number never appears. Sending 2,000,000
// frames a run and accumulating across runs (rather than resetting the
// counters on every click) gets a run comfortably past that threshold.
const FRAMES_PER_BER_RUN = 2_000_000;

function setupBerSweep(getReading) {
  const slider = $("ber-slider");
  const valueEl = $("ber-value");
  const runBtn = $("ber-run");
  const resetBtn = $("ber-reset");
  const statsEl = $("ber-stats");
  const expectedEl = $("ber-expected");
  const canvas = $("ber-canvas");

  const berFromSlider = () => Number(slider.value) / 1000; // 0..50 -> 0..5%
  const updateLabel = () => { valueEl.textContent = `${(berFromSlider() * 100).toFixed(1)}%`; };

  let totals = { total: 0, intact: 0, caughtByCrc: 0, undetected: 0 };
  let runsAtCurrentRate = 0;

  const renderTotals = () => {
    const corrupted = totals.caughtByCrc + totals.undetected;
    const expected = corrupted / 65536;
    statsEl.innerHTML = `
      <div class="stat"><span class="value">${totals.intact.toLocaleString()}</span><span class="label">intact</span></div>
      <div class="stat"><span class="value">${totals.caughtByCrc.toLocaleString()}</span><span class="label">caught by CRC</span></div>
      <div class="stat"><span class="value">${totals.undetected.toLocaleString()}</span><span class="label">silently corrupted</span></div>
    `;
    expectedEl.textContent = totals.total === 0 ? "" :
      `${totals.total.toLocaleString()} frames sent over ${runsAtCurrentRate} run(s) at this rate, ` +
      `${corrupted.toLocaleString()} corrupted, ${totals.undetected.toLocaleString()} undetected — ` +
      `corrupted \u00d7 2\u207b\u00b9\u2076 gives ${expected.toFixed(2)} as an upper bound for a ` +
      `uniformly random error pattern. CRC-16/CCITT-FALSE (poly 0x1021) is divisible by (x+1), ` +
      `so it catches every 1-bit error, every odd number of bit errors, and every burst under 17 ` +
      `bits — guaranteed, not probabilistic. At a low bit error rate almost every corrupted frame ` +
      `falls into one of those guaranteed-catch classes, so the observed undetected count is ` +
      `expected to run well below the 2\u207b\u00b9\u2076 figure, not converge on it.`;
    drawBerChart(canvas, totals);
  };

  const resetTotals = () => {
    totals = { total: 0, intact: 0, caughtByCrc: 0, undetected: 0 };
    runsAtCurrentRate = 0;
  };

  // Changing the rate mixes incompatible runs together, so start the
  // accumulator over rather than reporting a total across different rates.
  slider.addEventListener("input", () => { updateLabel(); resetTotals(); renderTotals(); });
  updateLabel();

  const run = async () => {
    runBtn.disabled = true;
    const bitErrorRate = berFromSlider();
    const frameBytes = encodeFull(getReading());
    await frame();
    // Seed advances every run so repeated runs at the same rate sample new
    // corruption patterns instead of repeating the same one.
    const seed = Math.floor(bitErrorRate * 1e6) + 1 + runsAtCurrentRate * 7919;
    const result = runChannel(frameBytes, FRAMES_PER_BER_RUN, bitErrorRate, seed, crcOk);
    totals.total += result.total;
    totals.intact += result.intact;
    totals.caughtByCrc += result.caughtByCrc;
    totals.undetected += result.undetected;
    runsAtCurrentRate++;
    renderTotals();
    runBtn.disabled = false;
  };
  runBtn.addEventListener("click", run);
  resetBtn.addEventListener("click", () => { resetTotals(); renderTotals(); });
  run();
}

// ============================================================================
// 4. Battery budget
// ============================================================================

function drawBatteryChart(canvas, points, currentIntervalMinutes) {
  const { ctx, w, h } = sizeCanvasForDisplay(canvas);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0a0d12";
  ctx.fillRect(0, 0, w, h);

  const pad = { left: 46, right: 14, top: 14, bottom: 30 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  const maxYears = Math.max(...points.full, ...points.delta, 1);
  const n = points.intervals.length;
  const xAt = (i) => pad.left + (plotW * i) / (n - 1);
  const yAt = (years) => pad.top + plotH - (years / maxYears) * plotH;

  ctx.strokeStyle = "#262d38";
  ctx.fillStyle = "#6b7785";
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "right";
  for (let g = 0; g <= 4; g++) {
    const y = pad.top + (plotH * g) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    ctx.fillText(Math.round(maxYears * (1 - g / 4)).toString(), pad.left - 6, y + 3);
  }

  const drawLine = (values, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = xAt(i), y = yAt(v);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };
  drawLine(points.full, "#f85149");
  drawLine(points.delta, "#3fb950");

  // Marker at the current interval.
  const idx = points.intervals.findIndex((v) => v >= currentIntervalMinutes);
  const markIdx = idx < 0 ? n - 1 : idx;
  ctx.fillStyle = "#e6edf3";
  ctx.beginPath();
  ctx.arc(xAt(markIdx), yAt(points.delta[markIdx]), 3.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#9aa7b4";
  ctx.textAlign = "center";
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillText("transmit interval, minutes (log-ish scale)", w / 2, h - 8);

  ctx.textAlign = "left";
  ctx.fillStyle = "#f85149";
  ctx.fillText("full", pad.left + 4, pad.top + 10);
  ctx.fillStyle = "#3fb950";
  ctx.fillText("delta", pad.left + 4, pad.top + 24);
}

function setupBattery(getReading) {
  const intervalSlider = $("battery-interval");
  const capacitySlider = $("battery-capacity");
  const canvas = $("battery-canvas");

  const render = () => {
    const intervalMinutes = Number(intervalSlider.value);
    const capacityMah = Number(capacitySlider.value);
    $("battery-interval-value").textContent =
      intervalMinutes < 60 ? `every ${intervalMinutes} min` : `every ${(intervalMinutes / 60).toFixed(1)} h`;
    $("battery-capacity-value").textContent = `${capacityMah.toLocaleString()} mAh`;

    const assumptions = { ...DEFAULT_ASSUMPTIONS, batteryCapacityMah: capacityMah };
    const reading = getReading();
    const fullBytes = encodeFull(reading).length;
    // A jump too large for the 12-bit volume delta falls back to a full
    // frame on the wire — mirror that here rather than throwing, same as
    // the full/delta comparison panel above.
    const deltaAttempt = tryEncodeDelta(reading, PREVIOUS_READING);
    const deltaBytes = deltaAttempt.ok ? deltaAttempt.bytes.length : fullBytes;
    const intervalSeconds = intervalMinutes * 60;

    const yearsFull = batteryLifeYears(fullBytes, intervalSeconds, assumptions);
    const yearsDelta = batteryLifeYears(deltaBytes, intervalSeconds, assumptions);
    $("years-full").textContent = yearsFull.toFixed(1);
    $("years-delta").textContent = yearsDelta.toFixed(1);
    $("years-gain").textContent = `\u00d7${(yearsDelta / yearsFull).toFixed(2)}`;

    // Sweep transmit interval from 1 minute to 24 hours for the chart.
    const intervals = [1, 2, 5, 10, 15, 30, 60, 120, 240, 480, 720, 1440];
    const full = intervals.map((m) => batteryLifeYears(fullBytes, m * 60, assumptions));
    const delta = intervals.map((m) => batteryLifeYears(deltaBytes, m * 60, assumptions));
    drawBatteryChart(canvas, { intervals, full, delta }, intervalMinutes);
  };

  intervalSlider.addEventListener("input", render);
  capacitySlider.addEventListener("input", render);
  const inputs = ["ctl-meterId", "ctl-volume", "ctl-flow", "ctl-battery",
    "ctl-leak", "ctl-burst", "ctl-backflow", "ctl-tamper", "ctl-lowBattery"];
  for (const id of inputs) $(id).addEventListener("input", render);

  render();
}

// ============================================================================

const getReading = setupByteMap();
setupCompare(getReading);
setupCorruption(getReading);
setupBerSweep(getReading);
setupBattery(getReading);
