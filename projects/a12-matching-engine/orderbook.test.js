import { test } from "node:test";
import assert from "node:assert/strict";
import { OrderBook, makeRng, nextAction, applyAction, runOrderFlow } from "./orderbook.js";

test("price-time priority: same price fills in arrival order", () => {
  const book = new OrderBook();
  const first = book.addLimitOrder("sell", 100, 5);
  const second = book.addLimitOrder("sell", 100, 5);
  const { trades } = book.addLimitOrder("buy", 100, 6);
  assert.equal(trades.length, 2);
  assert.equal(trades[0].makerOrderId, first.orderId);
  assert.equal(trades[0].qty, 5);
  assert.equal(trades[1].makerOrderId, second.orderId);
  assert.equal(trades[1].qty, 1);
});

test("best-price-first: an aggressive order takes the better price level first", () => {
  const book = new OrderBook();
  book.addLimitOrder("sell", 102, 10);
  const cheaper = book.addLimitOrder("sell", 100, 10);
  const { trades } = book.addLimitOrder("buy", 105, 5);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].price, 100);
  assert.equal(trades[0].makerOrderId, cheaper.orderId);
});

test("partial fill leaves the correct remainder resting with its original queue position", () => {
  const book = new OrderBook();
  const a = book.addLimitOrder("sell", 100, 10);
  const b = book.addLimitOrder("sell", 100, 10);
  book.addLimitOrder("buy", 100, 4); // partially fills a only
  const orderA = book.getOrder(a.orderId);
  const orderB = book.getOrder(b.orderId);
  assert.equal(orderA.remaining, 6);
  assert.equal(orderB.remaining, 10);
  // b must still fill only after a's remainder is exhausted
  const { trades } = book.addLimitOrder("buy", 100, 6);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].makerOrderId, a.orderId);
  assert.equal(trades[0].qty, 6);
  assert.equal(orderA.remaining, 0);
  assert.equal(orderB.remaining, 10);
});

test("a market order sweeps multiple levels and stops when the book is exhausted", () => {
  const book = new OrderBook();
  book.addLimitOrder("sell", 100, 5);
  book.addLimitOrder("sell", 101, 5);
  book.addLimitOrder("sell", 102, 5);
  const { trades } = book.addMarketOrder("buy", 100);
  const totalFilled = trades.reduce((s, t) => s + t.qty, 0);
  assert.equal(totalFilled, 15); // only 15 available - order evaporates unfilled past that
  assert.deepEqual(trades.map((t) => t.price), [100, 101, 102]);
  assert.equal(book.bestAsk(), null);
});

test("cancel removes the order and does not disturb the queue order of the others", () => {
  const book = new OrderBook();
  const a = book.addLimitOrder("sell", 100, 5);
  const b = book.addLimitOrder("sell", 100, 5);
  const c = book.addLimitOrder("sell", 100, 5);
  assert.equal(book.cancelOrder(b.orderId), true);
  const { trades } = book.addLimitOrder("buy", 100, 10);
  assert.equal(trades.length, 2);
  assert.equal(trades[0].makerOrderId, a.orderId);
  assert.equal(trades[1].makerOrderId, c.orderId);
});

test("cancel on an already-filled or unknown order returns false", () => {
  const book = new OrderBook();
  const a = book.addLimitOrder("sell", 100, 5);
  book.addLimitOrder("buy", 100, 5); // fully fills a
  assert.equal(book.cancelOrder(a.orderId), false);
  assert.equal(book.cancelOrder(999999), false);
});

test("depth() reports live quantity per level, best first", () => {
  const book = new OrderBook();
  book.addLimitOrder("buy", 99, 10);
  book.addLimitOrder("buy", 100, 5);
  book.addLimitOrder("sell", 103, 8);
  book.addLimitOrder("sell", 102, 3);
  const depth = book.depth();
  assert.deepEqual(depth.bids, [{ price: 100, qty: 5 }, { price: 99, qty: 10 }]);
  assert.deepEqual(depth.asks, [{ price: 102, qty: 3 }, { price: 103, qty: 8 }]);
});

test("seeded generator is deterministic for a fixed seed and differs across seeds", () => {
  function actionsFor(seed) {
    const book = new OrderBook();
    const rng = makeRng(seed);
    const actions = [];
    for (let i = 0; i < 200; i++) {
      const action = nextAction(rng, book);
      actions.push(JSON.stringify(action));
      applyAction(book, action);
    }
    return actions;
  }
  const a = actionsFor(42);
  const b = actionsFor(42);
  const c = actionsFor(43);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test("conservation invariant: every trade fills exactly one buyer and one seller by the same quantity, no order overfills, book never crosses", () => {
  const book = new OrderBook();
  const rng = makeRng(2024);
  let tradedQty = 0;
  const filledPerOrder = new Map(); // orderId -> quantity that order has actually traded

  runOrderFlow(book, rng, 20000, (action, result) => {
    for (const t of result.trades) {
      tradedQty += t.qty;
      filledPerOrder.set(t.makerOrderId, (filledPerOrder.get(t.makerOrderId) ?? 0) + t.qty);
      filledPerOrder.set(t.takerOrderId, (filledPerOrder.get(t.takerOrderId) ?? 0) + t.qty);
    }
    const bestBid = book.bestBid();
    const bestAsk = book.bestAsk();
    if (bestBid !== null && bestAsk !== null) {
      assert.ok(bestBid < bestAsk, `book crossed: bid ${bestBid} >= ask ${bestAsk}`);
    }
  });

  assert.ok(tradedQty > 0, "expected at least some trades over 20000 actions");

  // Sum each side's actual fills (from the trade log, not from `remaining`,
  // which a cancel also zeroes) - a buy order can only ever be the opposite
  // side of a trade from a sell order, so the two totals must match exactly.
  let filledBuy = 0;
  let filledSell = 0;
  for (const [orderId, filled] of filledPerOrder) {
    const order = book.getOrder(orderId);
    assert.ok(filled <= order.qty, `order ${orderId} filled ${filled} beyond its original quantity ${order.qty}`);
    if (order.side === "buy") filledBuy += filled; else filledSell += filled;
  }
  assert.equal(filledBuy, tradedQty, "total quantity filled on buy orders must equal total traded quantity");
  assert.equal(filledSell, tradedQty, "total quantity filled on sell orders must equal total traded quantity");
});

test("crossed-book invariant holds continuously across a second, differently-seeded long run", () => {
  const book = new OrderBook();
  const rng = makeRng(777);
  let checks = 0;
  runOrderFlow(book, rng, 5000, () => {
    const bestBid = book.bestBid();
    const bestAsk = book.bestAsk();
    if (bestBid !== null && bestAsk !== null) {
      assert.ok(bestBid < bestAsk);
      checks++;
    }
  });
  assert.ok(checks > 0, "expected the book to be non-empty on both sides at some point");
});

test("addLimitOrder and addMarketOrder reject non-positive quantities", () => {
  const book = new OrderBook();
  assert.throws(() => book.addLimitOrder("buy", 100, 0));
  assert.throws(() => book.addLimitOrder("buy", 100, -3));
  assert.throws(() => book.addMarketOrder("sell", 0));
});
