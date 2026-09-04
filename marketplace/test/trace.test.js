// Settled-hire trace (src/trace.js): the allow-list, the complete-only filter, the amount rendering and the
// last-good-read behaviour, all offline against a fixture. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { traceRow, traceRows, traceView, loadTrace } from "../src/trace.js";

const complete = { id: 56655, complete: true, providerAgent: "healthmon", provider: "0x91F4602760e1627007BFc16F78A74cF8B9De8Da2", client: "0x9D16bb4b2ed89AAFC8390998ed2d3254aF6e513b", buyerKind: "first-party test wallet", statusName: "COMPLETED",
  created: { tx: "0xc".padEnd(66, "1"), at: "2026-08-24T17:44:19.000Z" },
  funded: { tx: "0xf".padEnd(66, "2"), at: "2026-08-24T17:44:30.000Z", amountWei: "100000000000000000", token: "U", decimals: 18 },
  submitted: { tx: "0xd".padEnd(66, "3"), at: "2026-08-24T17:44:43.000Z", deliverablePointer: "0x" + "ab".repeat(32) },
  greenfield: { url: "https://greenfield-sp.lumibot.org/view/chainhelix-verified/marketplace/deliverables/56655.json", sha256: "1f".repeat(32), objectId: "1", txHash: "AA" },
  settled: { tx: "0xe".padEnd(66, "4"), at: "2026-08-31T17:46:03.000Z", verdict: "APPROVE" },
  deliverableUrl: "https://agents.chainhelix.io/healthmon/erc8183/job/56655/response",
  secretField: "must not leak", missing: [] };
const incomplete = { ...complete, id: 56680, complete: false, statusName: "SUBMITTED", settled: null, missing: ["not settled"] };

test("traceRow lists only the named fields and renders the amount from wei", () => {
  const r = traceRow(complete);
  assert.deepEqual(Object.keys(r), ["job", "agent", "provider", "buyer", "buyerKind", "status", "hired", "delivered", "greenfield", "settled"]);
  assert.equal(r.secretField, undefined);
  assert.equal(r.hired.amount, "0.1");
  assert.equal(r.hired.link, "https://bscscan.com/tx/" + complete.funded.tx);
  assert.equal(r.delivered.url, complete.deliverableUrl);
  assert.equal(r.greenfield.sha256, "1f".repeat(32));
  assert.equal(r.settled.verdict, "APPROVE");
});

test("only complete hires become rows, newest first", () => {
  const rows = traceRows({ jobs: { 56655: complete, 56680: incomplete, 56612: { ...complete, id: 56612 } } });
  assert.deepEqual(rows.map((r) => r.job), [56655, 56612]);
  assert.equal(traceRow(incomplete), null);
});

test("traceView counts rows and everything on record", () => {
  const v = traceView({ generated: "2026-09-03T00:00:00.000Z", chainId: 56, contracts: { commerce: "0xC", policy: "0xP", router: "0xR" }, jobs: { 56655: complete, 56680: incomplete } });
  assert.equal(v.count, 1);
  assert.equal(v.onRecord, 2);
  assert.equal(v.rows[0].job, 56655);
  assert.equal(v.contracts.commerce, "0xC");
});

test("loadTrace keeps the last good read when the file is damaged, and answers null when there is none", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-"));
  const p = join(dir, "job_trace.json");
  assert.equal(loadTrace(p), null);
  writeFileSync(p, JSON.stringify({ generated: "x", jobs: { 56655: complete } }));
  assert.equal(traceRows(loadTrace(p)).length, 1);
  writeFileSync(p, "{ damaged");
  assert.equal(traceRows(loadTrace(p)).length, 1);
});
