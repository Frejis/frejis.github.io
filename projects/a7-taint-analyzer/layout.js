// A small layered ("Sugiyama-lite") graph layout: assigns each CFG block a
// (column, row) position with row = longest-path distance from the entry
// block along forward edges, and loop back edges (identified by a DFS
// ancestor check) excluded from that distance so a loop body doesn't push
// its own header down. No external library — this is the whole thing.

export function layoutCFG(cfg) {
  const blocks = cfg.blocks;
  const byId = new Map(blocks.map((b) => [b.id, b]));

  const backEdges = new Set();
  const visited = new Set();
  const onStack = new Set();

  function dfs(id) {
    visited.add(id);
    onStack.add(id);
    for (const succ of byId.get(id).succs) {
      if (onStack.has(succ)) backEdges.add(`${id}->${succ}`);
      else if (!visited.has(succ)) dfs(succ);
    }
    onStack.delete(id);
  }
  dfs(cfg.entry);
  // Cover blocks unreachable from entry (shouldn't happen for well-formed
  // programs, but keeps layout total).
  for (const b of blocks) if (!visited.has(b.id)) dfs(b.id);

  const fwdSuccs = new Map(blocks.map((b) => [b.id, b.succs.filter((v) => !backEdges.has(`${b.id}->${v}`))]));
  const fwdPreds = new Map(blocks.map((b) => [b.id, []]));
  for (const b of blocks) for (const v of fwdSuccs.get(b.id)) fwdPreds.get(v).push(b.id);

  const indeg = new Map(blocks.map((b) => [b.id, fwdPreds.get(b.id).length]));
  const queue = blocks.filter((b) => indeg.get(b.id) === 0).map((b) => b.id);
  const topo = [];
  while (queue.length > 0) {
    const id = queue.shift();
    topo.push(id);
    for (const v of fwdSuccs.get(id)) {
      indeg.set(v, indeg.get(v) - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }
  for (const b of blocks) if (!topo.includes(b.id)) topo.push(b.id); // safety net

  const row = new Map(blocks.map((b) => [b.id, 0]));
  for (const id of topo) for (const v of fwdSuccs.get(id)) row.set(v, Math.max(row.get(v), row.get(id) + 1));

  const byRow = new Map();
  for (const id of topo) {
    const r = row.get(id);
    if (!byRow.has(r)) byRow.set(r, []);
    byRow.get(r).push(id);
  }

  const positions = new Map();
  let maxCols = 1;
  for (const [r, ids] of byRow) {
    maxCols = Math.max(maxCols, ids.length);
    ids.forEach((id, i) => positions.set(id, { col: i, row: r, rowCount: ids.length }));
  }

  return { positions, backEdges, rows: byRow.size, cols: maxCols };
}
