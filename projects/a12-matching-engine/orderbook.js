// A limit order book with price-time priority matching. Pure logic, no DOM -
// importable from Node (tests) and from the browser (app.js) alike.
//
// Data structure choice: each side of the book is a small array of Level
// objects, kept sorted by price (bids descending, asks ascending) via binary
// search insert. A level holds its resting orders in arrival order in a
// plain array; a "head" pointer skips past orders that have been fully
// filled or cancelled instead of physically removing them, so cancelling an
// order in the middle of a queue never touches (or re-indexes) the orders
// behind it. That is the property the "cancel does not disturb queue order"
// test is checking. Levels are few (prices cluster near the touch) and
// resting orders per level are modest, so an O(log n) binary-search insert
// beats the bookkeeping of a real production book (a price -> level hash
// map plus an ordered index, or a skip list) for a demo of this size.

// ---------------------------------------------------------------------------
// Seeded PRNG (SplitMix32) - deterministic, dependency-free.
// ---------------------------------------------------------------------------

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
    seed: seed >>> 0,
    nextUint32,
    next() { return nextUint32() / 0x100000000; }, // float in [0, 1)
    nextInt(min, max) { // inclusive both ends
      if (max < min) throw new Error(`nextInt: max (${max}) < min (${min})`);
      return min + Math.floor(this.next() * (max - min + 1));
    },
    nextBool() { return this.next() < 0.5; },
  };
}

// ---------------------------------------------------------------------------
// Price levels.
// ---------------------------------------------------------------------------

class Level {
  constructor(price) {
    this.price = price;
    this.orders = []; // arrival order; never reordered, only appended to
    this.head = 0; // index of the first order that might still be live
    this.qty = 0; // sum of .remaining over live (non-cancelled) orders
  }
}

function push(level, order) {
  level.orders.push(order);
  level.qty += order.remaining;
}

// Advance past orders at the head that are already fully filled or
// cancelled. Amortised O(1) per order over its lifetime: each one is
// skipped exactly once, ever.
function skipDead(level) {
  while (level.head < level.orders.length && level.orders[level.head].remaining === 0) {
    level.head++;
  }
}

// ---------------------------------------------------------------------------
// Sorted level arrays: bids descending by price, asks ascending.
// ---------------------------------------------------------------------------

function findLevel(levels, price, ascending) {
  let lo = 0, hi = levels.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const p = levels[mid].price;
    const before = ascending ? p < price : p > price;
    if (before) lo = mid + 1;
    else hi = mid;
  }
  return lo; // index where a level of `price` is, or should be inserted
}

// ---------------------------------------------------------------------------
// The book.
// ---------------------------------------------------------------------------

export class OrderBook {
  constructor() {
    this.bids = []; // Level[], descending price, index 0 = best bid
    this.asks = []; // Level[], ascending price, index 0 = best ask
    this.ordersById = new Map();
    this._idSeq = 1;
    this._seq = 1; // monotonic arrival/trade counter, for display only
  }

  bestBid() { return this.bids.length ? this.bids[0].price : null; }
  bestAsk() { return this.asks.length ? this.asks[0].price : null; }
  spread() {
    const b = this.bestBid(), a = this.bestAsk();
    return b !== null && a !== null ? a - b : null;
  }

  // Top `maxLevels` on each side, live quantity only. Ready to render.
  depth(maxLevels = 10) {
    const view = (levels) => levels.slice(0, maxLevels).map((l) => ({ price: l.price, qty: l.qty }));
    return { bids: view(this.bids), asks: view(this.asks) };
  }

  getOrder(id) { return this.ordersById.get(id); }

  // Ids of orders currently resting (live, unfilled remainder > 0). Used by
  // the order-flow generator to pick a plausible cancel target, and by
  // tests that want to inspect book state.
  restingOrderIds() {
    const out = [];
    for (const o of this.ordersById.values()) {
      if (!o.cancelled && o.remaining > 0 && o.resting) out.push(o.id);
    }
    return out;
  }

  addLimitOrder(side, price, qty) {
    if (!(qty > 0)) throw new Error(`addLimitOrder: qty must be positive, got ${qty}`);
    if (!Number.isFinite(price)) throw new Error(`addLimitOrder: invalid price ${price}`);
    const order = this._newOrder(side, price, qty);
    const trades = [];
    const opp = side === "buy" ? this.asks : this.bids;
    while (order.remaining > 0 && opp.length > 0) {
      const best = opp[0];
      const crosses = side === "buy" ? best.price <= price : best.price >= price;
      if (!crosses) break;
      this._matchAtLevel(best, order, trades);
      if (best.qty === 0) opp.shift();
    }
    if (order.remaining > 0) this._rest(order);
    return { orderId: order.id, trades };
  }

  addMarketOrder(side, qty) {
    if (!(qty > 0)) throw new Error(`addMarketOrder: qty must be positive, got ${qty}`);
    const order = this._newOrder(side, null, qty);
    const trades = [];
    const opp = side === "buy" ? this.asks : this.bids;
    while (order.remaining > 0 && opp.length > 0) {
      const best = opp[0];
      this._matchAtLevel(best, order, trades);
      if (best.qty === 0) opp.shift();
    }
    // Whatever remains unfilled when the book is exhausted just evaporates -
    // a market order never rests.
    return { orderId: order.id, trades };
  }

  cancelOrder(id) {
    const order = this.ordersById.get(id);
    if (!order || order.cancelled || !order.resting || order.remaining === 0) return false;
    const level = order.level;
    level.qty -= order.remaining;
    order.remaining = 0;
    order.cancelled = true;
    if (level.qty === 0) {
      const levels = order.side === "buy" ? this.bids : this.asks;
      const idx = levels.indexOf(level);
      if (idx !== -1) levels.splice(idx, 1);
    }
    return true;
  }

  _newOrder(side, price, qty) {
    const order = {
      id: this._idSeq++,
      side,
      price, // null for market orders
      qty,
      remaining: qty,
      cancelled: false,
      resting: false,
      level: null,
      timestamp: this._seq++,
    };
    this.ordersById.set(order.id, order);
    return order;
  }

  _rest(order) {
    order.resting = true;
    const ascending = order.side === "sell";
    const levels = order.side === "buy" ? this.bids : this.asks;
    const idx = findLevel(levels, order.price, ascending);
    let level = levels[idx];
    if (!level || level.price !== order.price) {
      level = new Level(order.price);
      levels.splice(idx, 0, level);
    }
    order.level = level;
    push(level, order);
  }

  // Matches `incoming` against the resting queue at `level` (assumed to be
  // the best level on the opposite side) until one side is exhausted.
  // Price-time priority: earliest surviving order in the queue always
  // trades first (skipDead only ever moves forward), best price is
  // guaranteed by the caller always operating on levels[0].
  _matchAtLevel(level, incoming, trades) {
    while (incoming.remaining > 0 && level.qty > 0) {
      skipDead(level);
      const maker = level.orders[level.head];
      const tradeQty = Math.min(incoming.remaining, maker.remaining);
      maker.remaining -= tradeQty;
      incoming.remaining -= tradeQty;
      level.qty -= tradeQty;
      trades.push({
        price: level.price,
        qty: tradeQty,
        aggressorSide: incoming.side,
        makerOrderId: maker.id,
        takerOrderId: incoming.id,
        timestamp: this._seq++,
      });
      if (maker.remaining === 0) level.head++;
    }
  }
}

// ---------------------------------------------------------------------------
// Order flow generator. Decides WHAT to do (pure, seeded); applyAction
// actually does it. Kept separate so a caller (a test, or the UI's
// benchmark loop) can time or inspect the "apply" step on its own.
// ---------------------------------------------------------------------------

// Mostly passive limit orders that rest a few ticks back from the touch,
// occasional aggressive orders that deliberately cross the spread, and
// cancels of orders that are actually resting.
export function nextAction(rng, book) {
  const bestBid = book.bestBid();
  const bestAsk = book.bestAsk();
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2
    : bestBid !== null ? bestBid + 1
    : bestAsk !== null ? bestAsk - 1
    : 10000; // arbitrary starting price when the book is empty

  const restingIds = book.restingOrderIds();
  const r = rng.next();

  if (r < 0.15 && restingIds.length > 0) {
    const id = restingIds[rng.nextInt(0, restingIds.length - 1)];
    return { type: "cancel", id };
  }

  if (r < 0.35) {
    // Aggressive: either a market order or a limit priced to cross.
    const side = rng.nextBool() ? "buy" : "sell";
    const qty = rng.nextInt(1, 15);
    if (rng.nextBool()) return { type: "market", side, qty };
    const price = side === "buy"
      ? (bestAsk ?? Math.round(mid + 1)) + rng.nextInt(0, 2)
      : (bestBid ?? Math.round(mid - 1)) - rng.nextInt(0, 2);
    return { type: "limit", side, price, qty };
  }

  // Passive: rests a small random offset back from the current touch,
  // widening the book instead of trading through it.
  const side = rng.nextBool() ? "buy" : "sell";
  const qty = rng.nextInt(1, 20);
  const price = side === "buy"
    ? (bestBid ?? Math.round(mid - 1)) - rng.nextInt(0, 4)
    : (bestAsk ?? Math.round(mid + 1)) + rng.nextInt(0, 4);
  return { type: "limit", side, price, qty };
}

export function applyAction(book, action) {
  if (action.type === "limit") return book.addLimitOrder(action.side, action.price, action.qty);
  if (action.type === "market") return book.addMarketOrder(action.side, action.qty);
  if (action.type === "cancel") return { orderId: action.id, trades: [], cancelled: book.cancelOrder(action.id) };
  throw new Error(`unknown action type: ${action.type}`);
}

// Drives `count` generated actions into `book`. `onEach(action, result, i)`,
// if given, runs after every single action - this is the hook the UI uses
// to time each operation and the tests use to check invariants continuously.
export function runOrderFlow(book, rng, count, onEach) {
  for (let i = 0; i < count; i++) {
    const action = nextAction(rng, book);
    const result = applyAction(book, action);
    if (onEach) onEach(action, result, i);
  }
}
