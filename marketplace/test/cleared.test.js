// 2026-09-08 (cleared buyer): the seller-side read of the public copy; no network, no files.
import { test } from "node:test";
import assert from "node:assert/strict";
const { clearedBuyer } = await import("../src/delivery.js");
const W = "0x9D16bb4b2ed89AAFC8390998ed2d3254aF6e513b";
const now = Date.parse("2026-09-08T18:00:00Z");
const stmt = { result: "clear", screenedAt: "2026-09-08T17:00:00Z", expiresAt: "2026-09-09T17:00:00Z", signer: "0x7572c16B1e2f32AF6011804E5A19Cd9Ac378451B", message: "m", signature: "0x" + "a".repeat(130) };
const doc = { buyers: [{ wallet: W.toLowerCase(), validUntil: now + 20 * 86400e3, renewals: 3, current: stmt }] };
test("on file, active, fresh statement: the seller sees clear with the screen time and the renewals", () => {
  const c = clearedBuyer(W, doc, now);
  assert.equal(c.onFile, true); assert.equal(c.active, true); assert.equal(c.currentFresh, true); assert.equal(c.result, "clear"); assert.equal(c.renewals, 3); assert.equal(c.signer, stmt.signer);
});
test("statement past its 24 hours is not fresh; period ended is not active", () => {
  assert.equal(clearedBuyer(W, doc, now + 2 * 86400e3).currentFresh, false);
  assert.equal(clearedBuyer(W, doc, now + 40 * 86400e3).active, false);
});
test("not on file, junk address and an empty file answer onFile false without throwing", () => {
  assert.equal(clearedBuyer("0x" + "1".repeat(40), doc, now).onFile, false);
  assert.equal(clearedBuyer("bob", doc, now).onFile, false);
  assert.equal(clearedBuyer(W, { buyers: [] }, now).onFile, false);
  assert.equal(clearedBuyer(null, doc, now).onFile, false);
});
const { clearanceLine } = await import("../src/pages.js");
test("page line: nothing when not on file; the three states in the existing muted style", () => {
  assert.equal(clearanceLine({ onFile: false }), "");
  assert.match(clearanceLine({ onFile: true, active: false }), /period ended/);
  assert.match(clearanceLine({ onFile: true, active: true, currentFresh: false }), /renewal pending/);
  const l = clearanceLine({ onFile: true, active: true, currentFresh: true, result: "clear", screenedAt: "2026-09-08T17:00:00.000Z", renewals: 3 });
  assert.match(l, /cleared buyer, clear at 2026-09-08 17:00:00Z, renewed 3 times/); assert.match(l, /class="muted small"/);
});
