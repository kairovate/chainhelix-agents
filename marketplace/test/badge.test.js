// 2026-09-08 (seller badge): earned only when every completed job has a sealed check; counts add up; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
const { deliveryBadge } = await import("../src/badge.js");
const W = "0x91F4602760e1627007BFc16F78A74cF8B9De8Da2";
const row = (job, verdict = "verified", status = "sealed", at = 1788818390576) => ({ seq: job, status, claim: { job, provider: W, verdict, checkedAt: at } });
test("earned: three completed, three sealed and verified", () => {
  const b = deliveryBadge(W, { claims: [row(1), row(2), row(3)], completed: [1, 2, 3] });
  assert.equal(b.earned, true); assert.equal(b.checked, 3); assert.equal(b.passed, 3); assert.equal(b.failed, 0); assert.equal(b.lastCheck, "2026-09-07"); assert.equal(b.record, "/d");
});
test("not earned: a completed job without a check shows the true count", () => {
  const b = deliveryBadge(W, { claims: [row(1), row(2)], completed: [1, 2, 3, 4] });
  assert.equal(b.earned, false); assert.equal(b.completedChecked, 2); assert.equal(b.completedJobs, 4);
});
test("a failed verdict keeps the badge and shows the failure; a queued row is pending, not checked", () => {
  const b = deliveryBadge(W, { claims: [row(1), row(2, "mismatch"), row(3, "verified", "queued")], completed: [1, 2] });
  assert.equal(b.earned, true); assert.equal(b.passed, 1); assert.equal(b.failed, 1); assert.equal(b.pending, 1); assert.equal(b.checked, 2);
});
test("the last row per job wins; another seller's rows are ignored; case of the address does not matter", () => {
  const other = { seq: 9, status: "sealed", claim: { job: 9, provider: "0x" + "1".repeat(40), verdict: "verified", checkedAt: 1 } };
  const b = deliveryBadge(W.toLowerCase(), { claims: [row(1, "mismatch"), row(1, "verified"), other], completed: [1] });
  assert.equal(b.checked, 1); assert.equal(b.passed, 1); assert.equal(b.earned, true);
});
test("nothing on record: zero everywhere, not earned", () => {
  const b = deliveryBadge(W, { claims: [], completed: [] });
  assert.equal(b.earned, false); assert.equal(b.checked, 0); assert.equal(b.lastCheck, null);
});
test("the card and the seller page carry the row in the dl style", async () => {
  const { renderHome, renderAgent } = await import("../src/pages.js");
  const a = { id: "x", name: "X", oneLiner: "o", status: "online", endpoint: "https://x.example/", identity: { erc8004Id: 1, links: { scan: "https://s", walletOnBscscan: "https://w", registryOnBscscan: "https://r" } }, price: null, reputation: null, jobs: { total: 3, completed: 3, inProgress: 0, rejected: 0 }, category: "grid", listing: "first-party",
    deliveryBadge: deliveryBadge(W, { claims: [row(1), row(2), row(3)], completed: [1, 2, 3] }) };
  const home = renderHome({ firstParty: [a], discovered: [] });
  assert.match(home, /<dt>Delivery checks<\/dt><dd><span class="badge on">all deliveries checked<\/span> 3 of 3 passed · last check 2026-09-07 · <a href="\/d">sealed on opBNB<\/a>/);
  const page = renderAgent({ ...a, inputSchema: null, hire: null });
  assert.match(page, /<dt>Delivery checks<\/dt>/);
  const b = { ...a, deliveryBadge: deliveryBadge(W, { claims: [row(1)], completed: [1, 2] }) };
  assert.match(renderHome({ firstParty: [b], discovered: [] }), /1 of 2 completed jobs checked · 1 of 1 passed/);
});
