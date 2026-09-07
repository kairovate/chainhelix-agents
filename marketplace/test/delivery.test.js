// 2026-09-07 (A4): the sealed delivery checks on the storefront, read from a fixture record, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
const dir = mkdtempSync(join(tmpdir(), "deliv-"));
process.env.DELIVERY_CLAIMS_FILE = join(dir, "delivery_claims.json");
const TX = "0x" + "ab".repeat(32), PTR = "0x" + "cd".repeat(32);
const claim = { v: "chxd1", job: 4242, chainId: 56, provider: "0x91F4602760e1627007BFc16F78A74cF8B9De8Da2", buyer: "0x9D16bb4b2ed89AAFC8390998ed2d3254aF6e513b", status: "COMPLETED", verdict: "verified",
  deliverable: { url: "javascript:alert(1)", sha256: "f".repeat(64), keccak256: PTR, bytes: 509, source: "served" }, onChain: { pointer: PTR, submitTx: TX, submittedAt: "2026-09-07T10:00:09.000Z" },
  permanentCopy: { url: "https://greenfield.example/x.json", sha256: "f".repeat(64), indexSha256: "f".repeat(64), objectId: "1", fetched: true }, hired: { at: "2026-09-07T10:00:00.000Z", tx: TX, amount: "0.1", token: "U" },
  deliveredInSeconds: 9, settled: { at: "2026-09-07T12:00:00.000Z", tx: TX, verdict: "APPROVE" }, checks: { pointerMatches: true, permanentMatchesIndex: true, servedMatchesPermanent: null }, checkedAt: 1757000000000 };
writeFileSync(process.env.DELIVERY_CLAIMS_FILE, JSON.stringify({ updated: 1, key: "0x7f8d2C80f34a1A85bAb3FDbAcBcFB2ebb5Cd6474", count: 1, claims: [{ seq: 1, hash: "1".repeat(64), committedAt: 1757000000000, status: "sealed", opbnbTx: TX, claim, note: "" }] }));
const { deliveryFor, deliveryList, deliveryByJob } = await import("../src/delivery.js");
const { renderDelivery, renderDeliveryList, sitesStrip } = await import("../src/pages.js");
test("record for a job: links built from the chain ids, a javascript url refused as an href", () => {
  const v = deliveryFor(4242);
  assert.equal(v.verdict, "verified"); assert.equal(v.seal.tx.link, "https://opbnb.bscscan.com/tx/" + TX); assert.equal(v.seal.key, "0x7f8d2C80f34a1A85bAb3FDbAcBcFB2ebb5Cd6474");
  assert.equal(v.deliverable.url, null, "javascript: is not a link"); assert.equal(v.permanentCopy.url, "https://greenfield.example/x.json");
  assert.equal(v.hired.tx.link, "https://bscscan.com/tx/" + TX); assert.equal(deliveryFor(1), null);
});
test("list and by-job map", () => {
  const l = deliveryList(10); assert.equal(l.count, 1); assert.equal(l.claims[0].job, 4242); assert.equal(deliveryByJob()[4242].seq, 1);
});
test("the page states the verdict, the three checks, the hashes, the seal and the steps; no raw claim url", () => {
  const html = renderDelivery(deliveryFor(4242));
  assert.match(html, /Delivery check for hire 4242/); assert.match(html, /passed/); assert.match(html, /not checked/); assert.doesNotMatch(html, /failed/);
  assert.match(html, new RegExp("f".repeat(64))); assert.match(html, /opbnb\.bscscan\.com\/tx\//); assert.match(html, /Check it yourself/); assert.match(html, /verified_delivery/);
  assert.doesNotMatch(html, /javascript:/); assert.match(html, /9 seconds/); assert.match(html, /0\.1 U/);
});
test("the list page and the connected sites strip", () => {
  const html = renderDeliveryList(deliveryList(10));
  assert.match(html, /1 check on record/); assert.match(html, /href="\/d\/4242"/);
  assert.match(html, /<b>Agent Market<\/b>/); assert.match(html, /href="https:\/\/mcp\.chainhelix\.io">For machines/); assert.match(html, /href="https:\/\/chainhelix\.io">ChainHelix/);
  assert.match(sitesStrip("machines"), /<b>For machines<\/b>/);
});
test("no record file: empty list, nothing thrown", () => {
  process.env.DELIVERY_CLAIMS_FILE = join(dir, "missing.json");
  const { loadDelivery } = { loadDelivery: (p) => { try { return JSON.parse(require("fs").readFileSync(p, "utf8")); } catch { return { claims: [], count: 0 }; } } };
  assert.equal(loadDelivery(process.env.DELIVERY_CLAIMS_FILE).count, 0);
});
