// DOM wiring only. All logic lives in dataset.js / pivot.js / selectivity.js / layout.js.

import { generateDataset, PIVOT_FIELDS, DEFAULT_SEED } from "./dataset.js";
import { createSession, applyPivot, undoPivot, pivotCandidatesForHost } from "./pivot.js";
import { rankBySelectivity } from "./selectivity.js";
import { buildGraph, initPositions, stepLayout } from "./layout.js";
import { mulberry32 } from "./prng.js";

const dataset = generateDataset(DEFAULT_SEED);
const { hosts } = dataset;

let session = createSession(dataset.defaultHostId);
let focusHostId = dataset.defaultHostId;
// undoPivot replays from the start host, so the session's origin has to outlive
// the session objects it hands back
const startHostId = dataset.defaultHostId;

const graph = buildGraph(hosts, PIVOT_FIELDS);
initPositions(graph, 820, 560, mulberry32(1));

const canvas = document.getElementById("graphCanvas");
const ctx = canvas.getContext("2d");

const hostDetailEl = document.getElementById("hostDetail");
const pivotOptionsEl = document.getElementById("pivotOptions");
const pivotTrailEl = document.getElementById("pivotTrail");
const selectedCountEl = document.getElementById("selectedCount");
const totalCountEl = document.getElementById("totalCount");
const narrationEl = document.getElementById("pivotNarration");
const weakPivotBtn = document.getElementById("weakPivotBtn");
const resetBtn = document.getElementById("resetBtn");

const FIELD_LABELS = Object.fromEntries(PIVOT_FIELDS.map((f) => [f.field, f]));

function shortValue(v) {
  const s = String(v);
  if (s.length <= 22) return s;
  return s.slice(0, 10) + "…" + s.slice(-8);
}

function clusterOf(hostId) {
  const host = hosts[hostId];
  return dataset.clusters.find((c) => c.name === host.cluster) || null;
}

function renderHostDetail() {
  const h = hosts[focusHostId];
  const cluster = clusterOf(focusHostId);
  const rows = [
    ["Host", `#${h.id} - ${h.ip}`],
    ["Hosting provider", `${h.provider} (${h.asn})`, "ASN"],
    ["Country", h.country],
    ["Certificate subject", h.certSubject],
    ["Certificate issuer", h.certIssuer],
    ["Certificate fingerprint", h.certFingerprint, "SHA-256"],
    ["TLS client fingerprint", h.ja3, "JA3"],
    ["SSH host key", h.sshFingerprint],
    ["Server header", h.serverHeader],
    ["Favicon hash", String(h.faviconHash)],
    ["First seen", h.firstSeen],
    ["Last seen", h.lastSeen],
  ];
  hostDetailEl.innerHTML = `
    <dl>
      ${rows.map(([label, value, tech]) => `
        <dt>${label}${tech ? ` <span class="faint">(${tech})</span>` : ""}</dt>
        <dd>${escapeHtml(value)}</dd>
      `).join("")}
    </dl>
    ${cluster ? `<div class="cluster-note faint">Planted cluster: <span class="mono">${cluster.name}</span> - ${cluster.note}</div>`
               : `<div class="cluster-note faint">Not part of a planted cluster (background noise).</div>`}
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function tierTagClass(tier) {
  if (tier === "strong") return "good";
  if (tier === "moderate") return "warn";
  return "bad";
}

function renderPivotOptions() {
  const host = hosts[focusHostId];
  const candidates = pivotCandidatesForHost(host, PIVOT_FIELDS);
  const ranked = rankBySelectivity(hosts, candidates);

  pivotOptionsEl.innerHTML = "";
  for (const r of ranked) {
    const meta = FIELD_LABELS[r.field];
    const btn = document.createElement("button");
    btn.className = "pivot-option";
    btn.innerHTML = `
      <span class="label">
        <span class="plain">${meta.label}</span>
        <span class="explain">${escapeHtml(meta.explain)}</span>
        <span class="tech">${meta.tech} - ${escapeHtml(shortValue(r.value))}</span>
      </span>
      <span class="tag ${tierTagClass(r.tier)}">${r.tier} - ${r.count}/${r.total} hosts</span>
    `;
    btn.addEventListener("click", () => {
      session = applyPivot(session, hosts, r.field, r.value);
      render();
    });
    pivotOptionsEl.appendChild(btn);
  }
}

function rollBackTo(stepIndex) {
  // undoPivot drops one step at a time; walk back until the trail ends on the
  // clicked step
  while (session.steps.length > stepIndex + 1) {
    session = undoPivot(session, hosts, startHostId);
  }
  render();
}

function renderPivotTrail() {
  pivotTrailEl.innerHTML = "";
  if (session.steps.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = `No pivots yet - starting from host #${session.selected[0]}.`;
    pivotTrailEl.appendChild(li);
    return;
  }
  session.steps.forEach((step, i) => {
    const meta = FIELD_LABELS[step.field];
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "trail-step";
    const isCurrent = i === session.steps.length - 1;
    if (isCurrent) btn.setAttribute("aria-current", "step");
    btn.title = isCurrent
      ? "The current selection"
      : `Roll the selection back to step ${i + 1}, discarding the pivots after it`;
    btn.innerHTML = `
      <span class="step-desc">
        ${i + 1}. ${meta.label}
        <span class="faint mono">${escapeHtml(shortValue(step.value))}</span>
      </span>
      <span class="tag ${tierTagClass(step.selectivity.tier)}">+${step.addedIds.length} hosts</span>
    `;
    btn.addEventListener("click", () => rollBackTo(i));
    li.appendChild(btn);
    pivotTrailEl.appendChild(li);
  });
}

// One plain sentence for what the last click actually did. The tier - not the
// number of hosts added - decides whether it reads as a lead or as noise.
function renderNarration() {
  const last = session.steps[session.steps.length - 1];
  if (!last) {
    narrationEl.textContent =
      `Start here: one host, nothing linked to it yet. Pick a trait below and every host sharing it joins the selection.`;
    return;
  }
  const meta = FIELD_LABELS[last.field];
  const { count, total, tier } = last.selectivity;
  const added = last.addedIds.length;
  const verdict = count <= 1
    ? `No other host out of ${total} carries that value, so it links this machine to nothing - a dead end rather than a lead.`
    : tier === "strong"
      ? `Only ${count} of ${total} hosts carry that value, so two machines having it is hard to explain as coincidence - this is a lead.`
      : tier === "moderate"
        ? `${count} of ${total} hosts carry it. Worth noting, not enough on its own; corroborate it with a second, rarer trait.`
        : `${count} of ${total} hosts carry it, which is most of the dataset - that is something everyone happens to share, not a link between these machines.`;
  const outcome = added === 0
    ? `Nothing new joined: every host with that value was already selected.`
    : `${added} host${added === 1 ? "" : "s"} joined the selection.`;
  narrationEl.innerHTML =
    `<span class="tag ${tierTagClass(tier)}">${escapeHtml(tier)}</span> ` +
    `Pivoted on "${escapeHtml(meta.label)}". ${outcome} ${verdict}`;
}

function renderCounts() {
  selectedCountEl.textContent = `${session.selected.length} selected`;
  totalCountEl.textContent = `${hosts.length} hosts`;
}

function render() {
  renderHostDetail();
  renderPivotOptions();
  renderPivotTrail();
  renderNarration();
  renderCounts();
}

function drawGraph() {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const selectedSet = new Set(session.selected);
  // Read every frame, never cached: the canvas cannot inherit CSS, so a value
  // captured once keeps the palette the page opened with.
  const style = getComputedStyle(document.body);
  const borderColor = style.getPropertyValue("--border").trim();
  const accent = style.getPropertyValue("--accent").trim();
  const dim = style.getPropertyValue("--text-faint").trim();
  const alt = style.getPropertyValue("--alt").trim();
  const ring = style.getPropertyValue("--text").trim();

  ctx.lineWidth = 1;
  for (const edge of graph.edges) {
    const a = graph.nodes[edge.a];
    const b = graph.nodes[edge.b];
    const bothSelected = selectedSet.has(edge.a) && selectedSet.has(edge.b);
    ctx.strokeStyle = bothSelected ? accent : borderColor;
    ctx.globalAlpha = bothSelected ? 0.85 : 0.35;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  for (const node of graph.nodes) {
    const isSelected = selectedSet.has(node.id);
    const isFocus = node.id === focusHostId;
    const r = isFocus ? 8 : isSelected ? 6 : 4;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fillStyle = isFocus ? alt : isSelected ? accent : dim;
    ctx.fill();
    if (isFocus) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = ring;
      ctx.stroke();
    }
  }
}

canvas.addEventListener("click", (ev) => {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (ev.clientX - rect.left) * scaleX;
  const y = (ev.clientY - rect.top) * scaleY;
  let closest = null;
  let closestDist = Infinity;
  for (const node of graph.nodes) {
    const d = (node.x - x) ** 2 + (node.y - y) ** 2;
    if (d < closestDist) {
      closestDist = d;
      closest = node;
    }
  }
  if (closest && closestDist < 20 * 20) {
    // clicking a node outside the current selection only changes focus -
    // it never silently adds the host to the selection
    focusHostId = closest.id;
    render();
  }
});

weakPivotBtn.addEventListener("click", () => {
  const host = hosts[focusHostId];
  const candidates = pivotCandidatesForHost(host, PIVOT_FIELDS);
  const ranked = rankBySelectivity(hosts, candidates);
  const weakest = ranked[ranked.length - 1];
  session = applyPivot(session, hosts, weakest.field, weakest.value);
  render();
  // at desktop width the graph already sits beside this button; on a narrow
  // screen the flood would otherwise happen off-screen
  const box = canvas.getBoundingClientRect();
  if (box.top < 0 || box.bottom > window.innerHeight) {
    canvas.scrollIntoView({ behavior: "smooth", block: "center" });
  }
});

resetBtn.addEventListener("click", () => {
  session = createSession(startHostId);
  focusHostId = startHostId;
  render();
});

function animate() {
  stepLayout(graph, canvas.width, canvas.height);
  drawGraph();
  requestAnimationFrame(animate);
}

// The layout loop redraws every frame, so the graph follows the palette on its
// own; the listener makes the repaint immediate and explicit rather than
// dependent on that loop still being there.
document.addEventListener("themechange", drawGraph);

render();
requestAnimationFrame(animate);
