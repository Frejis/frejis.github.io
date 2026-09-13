// stream.js — a seeded telemetry generator simulating a fibre access
// network: a handful of OLT/switch nodes, each with several ports, each
// port emitting realistic counters once per interval. Pure, no DOM.

// splitmix32, the same small deterministic PRNG used elsewhere in this
// portfolio (see a12-matching-engine/orderbook.js) — good enough
// distributional quality for a simulation, and trivially seedable so the
// whole demo reproduces exactly from one integer.
export function makeRng(seed) {
  let state = seed >>> 0;
  function nextUint32() {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0;
    return z;
  }
  return {
    nextUint32,
    next() { return nextUint32() / 0x100000000; }, // float in [0, 1)
    nextInt(min, max) { return min + Math.floor(this.next() * (max - min + 1)); },
    // Standard normal via Box-Muller, from this same RNG - used for the
    // small, realistic wobble in optical light level and temperature.
    nextGaussian() {
      const u1 = Math.max(this.next(), 1e-12);
      const u2 = this.next();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    },
  };
}

// A small, fixed fibre-access topology: a few OLTs, each with several ports
// carrying subscriber traffic. Deliberately small (this is a demo, not a
// capacity plan) but shaped like the real thing - one metric per port per
// counter, exactly what a device would export over gNMI/OpenConfig or SNMP.
export function buildTopology(nodeCount = 3, portsPerNode = 4) {
  const nodes = [];
  for (let n = 0; n < nodeCount; n++) {
    const ports = [];
    for (let p = 0; p < portsPerNode; p++) {
      ports.push({ port: `1/1/${p + 1}` });
    }
    nodes.push({ node: `aar-olt-${String(n + 1).padStart(2, "0")}`, ports });
  }
  return nodes;
}

// Per-port mutable simulation state: running byte counters, current light
// level, whether a fault has been injected, and when the node last rebooted.
function initPortState(rng) {
  return {
    rxBytes: 0,
    txBytes: 0,
    lightDbm: -18 + rng.nextGaussian() * 0.4, // typical GPON downstream ONT Rx level
    tempC: 32 + rng.nextGaussian() * 1.5,
    crcErrors: 0,
    // fault injection, off by default
    lightDegradePerTick: 0,
    crcBurstRemaining: 0,
    rebootPending: false,
  };
}

// Real PON/GPON receivers lose lock and stop reporting a meaningful power
// figure somewhere around -30dBm; a degrading link's readings sag toward
// that loss-of-signal floor and then sit there, they do not ramp to -185dBm
// forever. This demo has no "port down" state, so the floor is the closest
// honest approximation: once light level reaches it, it stops falling.
const LOS_FLOOR_DBM = -30;

// Advances the whole topology by one sample interval, mutating `states`
// (keyed by "node/port") in place and returning one sample object per
// series: {node, port, metric, value}. Rx/tx bytes are monotonically
// increasing counters (reset to a small value on a pending reboot); light
// level and temperature are slow random walks around a plausible baseline;
// CRC errors are usually zero, occasionally a small nonzero count, or a
// deliberately injected burst.
// Real interface counters are integers and real sensors report at a fixed
// resolution (an optical power meter to 0.1dB, a thermistor readout to
// 0.1C) - not the full precision of the float64 doing the internal maths.
// Quantising to that resolution is not a compression trick, it is what the
// hardware actually reports, and it is exactly why Gorilla's XOR encoding
// works so well on real telemetry: two consecutive 0.1dB-resolution
// readings are very often bit-for-bit identical, which a full-precision
// noisy float would almost never be.
function round(x, step) {
  return Math.round(x / step) * step;
}

export function tick(rng, states, intervalMs, throughputBpsBase = 8e7) {
  const out = [];
  for (const [key, st] of states) {
    // throughput: a baseline plus noise, degraded a little by any CRC burst
    // in progress (a real link retransmits/drops under errors)
    const congestion = st.crcBurstRemaining > 0 ? 0.55 : 1;
    const bps = Math.max(0, throughputBpsBase * congestion * (1 + rng.nextGaussian() * 0.015));
    const bytesThisTick = Math.round((bps * intervalMs) / 1000 / 8);
    st.rxBytes += bytesThisTick;
    st.txBytes += Math.round(bytesThisTick * (0.35 + rng.next() * 0.1)); // upstream is lighter than downstream

    st.lightDbm = Math.max(LOS_FLOOR_DBM, st.lightDbm + rng.nextGaussian() * 0.05 - st.lightDegradePerTick);
    st.tempC += rng.nextGaussian() * 0.1;

    let crcThisTick = rng.next() < 0.03 ? rng.nextInt(0, 2) : 0;
    if (st.crcBurstRemaining > 0) {
      crcThisTick += rng.nextInt(20, 60);
      st.crcBurstRemaining--;
    }
    st.crcErrors += crcThisTick;

    if (st.rebootPending) {
      st.rxBytes = 0;
      st.txBytes = 0;
      st.rebootPending = false;
    }

    out.push({ key, metric: "rx_bytes", value: st.rxBytes });
    out.push({ key, metric: "tx_bytes", value: st.txBytes });
    out.push({ key, metric: "light_dbm", value: round(st.lightDbm, 0.1) });
    out.push({ key, metric: "temp_c", value: round(st.tempC, 0.1) });
    out.push({ key, metric: "crc_errors", value: st.crcErrors });
  }
  return out;
}

// Builds a full generated dataset: `sampleCount` ticks at `intervalMs`
// spacing, starting at `startTs`, for every port in `topology`, optionally
// applying fault events (see below) at specific tick indices. Returns
// `{ seriesKeys, samplesByKey }` where samplesByKey maps
// "node/port" -> { rx_bytes: [...], tx_bytes: [...], light_dbm: [...], ... }
// each an array of {ts, value}, ready to feed into store.js or compress.js.
//
// `faults` is an array of { atTick, node, port, type, ...params }, type one
// of "degrade" (optical level worsens by `perTickDb` per tick from here on),
// "crcBurst" (injects `ticks` ticks of a heavy CRC burst starting here), or
// "reboot" (counters reset to zero on the next tick).
export function generate({ seed = 1, nodeCount = 3, portsPerNode = 4, sampleCount = 500, intervalMs = 10000, startTs = 1700000000000, faults = [] } = {}) {
  const rng = makeRng(seed);
  const topology = buildTopology(nodeCount, portsPerNode);
  const states = new Map();
  const keys = [];
  for (const node of topology) {
    for (const p of node.ports) {
      const key = `${node.node}/${p.port}`;
      states.set(key, initPortState(rng));
      keys.push(key);
    }
  }

  const faultsByTick = new Map();
  for (const f of faults) {
    if (!faultsByTick.has(f.atTick)) faultsByTick.set(f.atTick, []);
    faultsByTick.get(f.atTick).push(f);
  }

  const samplesByKey = new Map();
  for (const key of keys) {
    samplesByKey.set(key, { rx_bytes: [], tx_bytes: [], light_dbm: [], temp_c: [], crc_errors: [] });
  }

  for (let i = 0; i < sampleCount; i++) {
    const ts = startTs + i * intervalMs;
    const pending = faultsByTick.get(i) || [];
    for (const f of pending) {
      const key = `${f.node}/${f.port}`;
      const st = states.get(key);
      if (!st) continue;
      if (f.type === "degrade") st.lightDegradePerTick = f.perTickDb ?? 0.15;
      else if (f.type === "crcBurst") st.crcBurstRemaining = f.ticks ?? 20;
      else if (f.type === "reboot") st.rebootPending = true;
    }
    const samples = tick(rng, states, intervalMs);
    for (const s of samples) {
      samplesByKey.get(s.key)[s.metric].push({ ts, value: s.value });
    }
  }

  return { topology, seriesKeys: keys, samplesByKey };
}
