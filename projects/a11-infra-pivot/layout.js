// A small force-directed graph layout: repulsion between all nodes, springs
// along edges, mild pull toward the center so isolated nodes do not drift off
// forever. Deliberately simple (O(n^2) repulsion) - fine at ~90 nodes,
// not meant to scale further.

export function buildGraph(hosts, pivotFields) {
  const nodes = hosts.map((h) => ({ id: h.id, x: 0, y: 0, vx: 0, vy: 0 }));
  const edgeMap = new Map(); // key -> { a, b, fields: Set }

  for (const { field } of pivotFields) {
    const byValue = new Map();
    for (const h of hosts) {
      const v = h[field];
      if (v === undefined || v === null) continue;
      if (!byValue.has(v)) byValue.set(v, []);
      byValue.get(v).push(h.id);
    }
    for (const ids of byValue.values()) {
      if (ids.length < 2 || ids.length > 20) continue; // skip near-universal artifacts as edges
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = Math.min(ids[i], ids[j]);
          const b = Math.max(ids[i], ids[j]);
          const key = `${a}-${b}`;
          if (!edgeMap.has(key)) edgeMap.set(key, { a, b, fields: new Set() });
          edgeMap.get(key).fields.add(field);
        }
      }
    }
  }

  return { nodes, edges: [...edgeMap.values()] };
}

export function initPositions(graph, width, height, seededRng) {
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) * 0.38;
  const n = graph.nodes.length;
  graph.nodes.forEach((node, i) => {
    // deterministic ring start, nudged so the physics has room to work
    const angle = (i / n) * Math.PI * 2;
    const jitter = seededRng ? (seededRng() - 0.5) * 20 : 0;
    node.x = cx + Math.cos(angle) * r + jitter;
    node.y = cy + Math.sin(angle) * r + jitter;
    node.vx = 0;
    node.vy = 0;
  });
}

const REPULSION = 2600;
const SPRING_LENGTH = 90;
const SPRING_STRENGTH = 0.02;
const CENTER_PULL = 0.0015;
const DAMPING = 0.82;

/**
 * Advances the layout by one physics step, mutating node positions in place.
 * Pure function of (graph, width, height) otherwise - no globals, no timers.
 */
export function stepLayout(graph, width, height) {
  const { nodes, edges } = graph;
  const cx = width / 2;
  const cy = height / 2;

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    let fx = 0;
    let fy = 0;
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let distSq = dx * dx + dy * dy;
      if (distSq < 1) distSq = 1;
      const dist = Math.sqrt(distSq);
      const force = REPULSION / distSq;
      fx += (dx / dist) * force;
      fy += (dy / dist) * force;
    }
    fx += (cx - a.x) * CENTER_PULL;
    fy += (cy - a.y) * CENTER_PULL;
    a.vx = (a.vx + fx) * DAMPING;
    a.vy = (a.vy + fy) * DAMPING;
  }

  for (const edge of edges) {
    const a = nodes[edge.a];
    const b = nodes[edge.b];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
    const displacement = dist - SPRING_LENGTH;
    const force = displacement * SPRING_STRENGTH;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  for (const node of nodes) {
    node.x += node.vx;
    node.y += node.vy;
    node.x = Math.max(12, Math.min(width - 12, node.x));
    node.y = Math.max(12, Math.min(height - 12, node.y));
  }
}
