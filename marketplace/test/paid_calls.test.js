// 2026-09-05: pay-per-call purchases on record (src/paid_calls.js): the allow-list and the committed file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { paidCallRow, paidCallRows, paidCallsView, loadPaidCalls } from "../src/paid_calls.js";
const good = { agent: "gridtrader", asset: "USDT", path: "/gridtrader/x402", amount: "0.5", tx: "0x" + "ab".repeat(32), at: "2026-09-05T19:42Z", extra: "dropped" };
test("a row keeps only the named fields and links the transaction", () => {
  const r = paidCallRow(good);
  assert.deepEqual(Object.keys(r).sort(), ["agent", "amount", "asset", "at", "link", "path", "tx"]);
  assert.equal(r.link, "https://bscscan.com/tx/0x" + "ab".repeat(32));
});
test("bad rows are dropped: unknown agent, unknown asset, bad hash, bad path", () => {
  assert.equal(paidCallRow({ ...good, agent: "other" }), null);
  assert.equal(paidCallRow({ ...good, asset: "ETH" }), null);
  assert.equal(paidCallRow({ ...good, tx: "0x1234" }), null);
  assert.equal(paidCallRow({ ...good, path: "javascript:alert(1)" }), null);
  assert.equal(paidCallRows({ calls: [good, null, 5] }).length, 1);
});
test("the committed file carries the seven purchases, one per asset and agent pair on record", () => {
  const v = paidCallsView(loadPaidCalls());
  assert.equal(v.count, 7);
  assert.deepEqual([...new Set(v.rows.map((r) => r.asset))].sort(), ["U", "USD1", "USDC", "USDT"]);
  assert.deepEqual([...new Set(v.rows.map((r) => r.agent))].sort(), ["gridtrader", "healthmon", "rebalancer", "yieldopt"]);
  assert.ok(v.rows.every((r) => r.amount === "0.5"));
});
